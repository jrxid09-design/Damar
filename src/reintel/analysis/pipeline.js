/**
 * RE Intelligence — pipeline analisis statis kanonik.
 *
 *   ARTIFACT → IDENTIFICATION → HASHING → EVIDENCE
 *     → STRUCTURAL ANALYSIS → FINDINGS → HYPOTHESES
 *     → CONFIDENCE → BEHAVIOR MODEL → RECOMMENDED NEXT ANALYSIS
 *     → AnalysisReport (immutable)
 *
 * Jaminan V0:
 * - TIDAK mengeksekusi artifact. Analisis 100% pembacaan byte.
 * - Artifact hostile: semua batas dari config; kegagalan parser
 *   diagnostik dan parsial, tidak pernah melempar keluar.
 * - Laporan immutable (deep-frozen) dan deterministik antar-run
 *   untuk input sama.
 * - Authority = nol. Laporan tidak memberi izin apa pun.
 */

"use strict";

const fs = require("node:fs");

const { createReIntelConfig } = require("../config/ReIntelConfig");
const {
    freezeDeep, makeConfidence, ArtifactType, AnalysisStage, FindingKind
} = require("../model/model");
const { sha256File, sha256Buffer, deriveArtifactId } = require("../core/hashing");
const { identifyArtifact } = require("../core/identify");
const { deriveBehavioralClaims } = require("./behavior");
const {
    makeAnalysisContext, runAnalyzers, analysisResultOf
} = require("./analyzer");
const { defaultAnalyzers } = require("./analyzers");
const { HOOK_EVENTS } = require("./../hooks/futureHooks");

const REPORT_SCHEMA_VERSION = 1;

/**
 * Analisis artifact.
 * @param {{path?: string, buffer?: Buffer, name?: string}} input
 * @param {{config?: object, overrides?: object, depth?: number,
 *          emit?: Function, nowEpochMs?: number,
 *          analyzers?: Array, analyzeEmbedded?: boolean}} options
 * @returns {Promise<object>} laporan deep-frozen.
 */
async function analyzeArtifact(input, options = {}) {
    const config = options.config ?? createReIntelConfig(undefined, options.overrides);
    const limits = config.limits;
    const bands = config.confidenceBands;
    const stagesExecuted = [];
    const diagnostics = [];

    // ---- resolve sumber -------------------------------------------------
    let name = input.name ?? null;
    let sizeBytes = 0;
    let header = null;
    let buffer = null;

    if (input.path !== undefined) {
        const st = fs.statSync(input.path);
        sizeBytes = Number(st.size);
        name ??= input.path.split(/[\\/]/).pop();

        const fd = fs.openSync(input.path, "r");
        try {
            header = readBounded(fd, Math.min(st.size, limits.maxHeaderBytes));
        } finally {
            fs.closeSync(fd);
        }
    } else if (input.buffer !== undefined) {
        buffer = input.buffer;
        sizeBytes = buffer.length;
        header = buffer.subarray(0, Math.min(buffer.length, limits.maxHeaderBytes));
    } else {
        throw new Error("REI_INVALID_INPUT: butuh path atau buffer");
    }

    // ---- HASHING ---------------------------------------------------------
    stagesExecuted.push(AnalysisStage.HASHING);
    const sha256 = input.path !== undefined
        ? await sha256File(input.path)
        : sha256Buffer(buffer);
    const artifactId = deriveArtifactId(sha256, sizeBytes);

    // ---- anggaran ukuran -------------------------------------------------
    if (sizeBytes > limits.maxFileBytes) {
        diagnostics.push({
            code: "BUDGET_LIMIT_REACHED",
            severity: "warning",
            message: `ukuran file ${sizeBytes} > anggaran maxFileBytes ${limits.maxFileBytes}; hanya identifikasi + hash`
        });
    } else if (buffer === null && input.path !== undefined &&
               sizeBytes <= limits.maxDeepParseBytes) {
        buffer = readWholeFileBounded(input.path, sizeBytes);
    }
    if (buffer !== null && sizeBytes > limits.maxDeepParseBytes) {
        diagnostics.push({
            code: "BUDGET_LIMIT_REACHED",
            severity: "warning",
            message: `ukuran file ${sizeBytes} > anggaran maxDeepParseBytes; parsing mendalam dilewati`
        });
        buffer = null;
    }

    // ---- IDENTIFICATION ---------------------------------------------------
    stagesExecuted.push(AnalysisStage.IDENTIFICATION);
    const idres = identifyArtifact(header, { name, sizeBytes }, limits, bands);

    const descriptor = freezeDeep({
        artifactId,
        name,
        sizeBytes,
        sha256,
        algo: "sha256",
        type: idres.type,
        classificationConfidence: makeConfidence(idres.confidenceScore, bands),
        classificationBasis: idres.basis
    });

    // ---- STRUCTURAL ANALYSIS (analyzers) -----------------------------------
    stagesExecuted.push(AnalysisStage.STRUCTURAL_ANALYSIS);
    const ctx = makeAnalysisContext({ descriptor, header, buffer, limits, bands });

    // bukti identifikasi masuk kolektor terpusat agar nomor ID deterministik.
    for (const e of idres.evidence) {
        ctx.addEvidence({
            source: "identification",
            kind: e.kind,
            observation: e.observation,
            location: undefined
        });
    }

    const analyzers = options.analyzers ?? defaultAnalyzers;
    const provenance = runAnalyzers(analyzers, ctx);

    const res = analysisResultOf(ctx);

    // ---- FINDINGS / HYPOTHESES / CONFIDENCE --------------------------------
    stagesExecuted.push(AnalysisStage.FINDINGS, AnalysisStage.HYPOTHESES,
        AnalysisStage.CONFIDENCE);
    const findings = res.findings.map((f) => freezeDeep({
        ...f,
        confidence: typeof f.confidence === "number"
            ? makeConfidence(f.confidence, bands)
            : f.confidence
    }));

    const hypotheses = res.hypotheses.map((h) => freezeDeep({
        ...h,
        confidence: typeof h.confidence === "number"
            ? makeConfidence(h.confidence, bands)
            : h.confidence
    }));

    // ---- BEHAVIOR MODEL -----------------------------------------------------
    stagesExecuted.push(AnalysisStage.BEHAVIOR_MODEL);
    const behavioralClaims = deriveBehavioralClaims(res.evidence);

    // ---- embedded artifacts + rekursi berbudget ------------------------------
    const embeddedArtifacts = res.embeddedArtifacts;
    const embeddedAnalyses = [];
    const depth = options.depth ?? 0;
    if (options.analyzeEmbedded !== false &&
        embeddedArtifacts.length > 0 &&
        depth < limits.maxRecursionDepth &&
        buffer !== null) {
        const MAX_RECURSED = 4;
        for (const emb of embeddedArtifacts.slice(0, MAX_RECURSED)) {
            try {
                const child = await analyzeArtifact(
                    { buffer: buffer.subarray(emb.offset), name: `embedded@${emb.offset}` },
                    { ...options, depth: depth + 1 }
                );
                embeddedAnalyses.push(child);
                res.relationships.push({
                    id: `rel-emb-${emb.index}`,
                    type: "CONTAINS",
                    target: child.artifact.artifactId,
                    note: `embedded pada offset ${emb.offset}`
                });
            } catch (err) {
                diagnostics.push({
                    code: "EMBEDDED_ANALYSIS_FAILED",
                    severity: "warning",
                    message: `analisis embedded @${emb.offset} gagal: ${String(err?.message).slice(0, 200)}`
                });
            }
        }
    } else if (embeddedArtifacts.length > 0 && depth >= limits.maxRecursionDepth) {
        diagnostics.push({
            code: "BUDGET_LIMIT_REACHED",
            severity: "warning",
            message: `kedalaman rekursi maksimum (${limits.maxRecursionDepth}) tercapai; embedded tidak dianalisis lebih dalam`
        });
    }

    for (const d of res.diagnostics) diagnostics.push(d);

    // ---- rekomendasi tahap lanjutan -------------------------------------------
    const recommended = new Set(ctx._result.recommendedStages);
    if (descriptor.type === ArtifactType.UNKNOWN) {
        recommended.add(AnalysisStage.MANUAL_TRIAGE);
    }
    if (descriptor.type === ArtifactType.ARCHIVE) {
        recommended.add(AnalysisStage.ARCHIVE_DECOMPOSITION);
    }

    // Event masa depan untuk stage RE lanjutan (interface saja di V0).
    if (descriptor.type === ArtifactType.UNKNOWN && typeof options.emit === "function") {
        options.emit(HOOK_EVENTS.UNKNOWN_ARTIFACT_REQUIRES_ANALYSIS, {
            artifactId, type: descriptor.type, confidence: descriptor.classificationConfidence
        });
        recommended.add("UNKNOWN_ARTIFACT_ESCALATION");
    }

    stagesExecuted.push(AnalysisStage.REPORT);

    // ---- REPORT -----------------------------------------------------------------
    const report = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        kind: "re_intel_static_analysis_report",
        artifact: {
            artifactId,
            name,
            sizeBytes,
            sha256,
            algo: "sha256"
        },
        classification: {
            type: descriptor.type,
            confidence: descriptor.classificationConfidence,
            basis: descriptor.classificationBasis,
            entropySample: idres.entropy,
            nonPrintableRatio: idres.nonPrintableRatio
        },
        structuralSummary: {
            observedFactCount: findings.filter((f) => f.kind === FindingKind.OBSERVED_FACT).length,
            inferredClaimCount: findings.filter((f) => f.kind === FindingKind.INFERRED_CLAIM).length,
            hypothesisCount: hypotheses.length,
            behavioralClaimCount: behavioralClaims.length
        },
        evidence: res.evidence,
        findings,
        hypotheses,
        behavioralClaims,
        relationships: res.relationships,
        embeddedArtifacts,
        embeddedAnalyses,
        diagnostics,
        analyzers: provenance,
        stagesExecuted,
        recommendedNextStages: [...recommended],
        /** Authority SELALU nol: temuan bukan izin. */
        authority: Object.freeze({
            granted: false,
            note: "temuan analisis statis tidak memberi otoritas operasi apa pun"
        }),
        futureHooks: Object.freeze({
            dynamicAnalysisAvailable: false,
            protocolCaptureAnalysisAvailable: false,
            note: "V0 statis saja; lihat hooks/futureHooks.js"
        }),
        generatedAtEpochMs: options.nowEpochMs ?? null
    };

    return freezeDeep(report);
}

function readBounded(fd, bytes) {
    const buf = Buffer.alloc(bytes);
    let read = 0;
    while (read < bytes) {
        const n = fs.readSync(fd, buf, read, bytes - read, read);
        if (n <= 0) break;
        read += n;
    }
    return read === bytes ? buf : buf.subarray(0, read);
}

function readWholeFileBounded(path, sizeBytes) {
    const fd = fs.openSync(path, "r");
    try {
        return readBounded(fd, sizeBytes);
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { analyzeArtifact };
