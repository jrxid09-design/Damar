/**
 * RE Intelligence — kontrak analyzer plugin dan eksekusinya.
 *
 * Analyzer = { id, version, supports(ctx) → bool, analyze(ctx) → void }.
 * Analyzer menambahkan bukti/temuan lewat context kolektor terpusat
 * sehingga penomoran ID deterministik dan agregasi antar-analyzer
 * konsisten. Kegagalan satu analyzer WAJIB terisolasi: dicatat sebagai
 * diagnostic, analisis lain tetap berjalan, laporan tetap utuh.
 *
 * Anggaran kerja V0 deterministik (hitungan elemen dari config),
 * bukan waktu-dinding — analisis berulang harus identik.
 */

"use strict";

const {
    freezeDeep, observedFact, inferredClaim, hypothesis,
    FindingKind
} = require("../model/model");

/** Validasi bentuk analyzer saat pendaftaran — kontrak eksplisit. */
function defineAnalyzer(spec) {
    const { id, version, supports, analyze } = spec ?? {};
    if (typeof id !== "string" || !id.trim()) {
        throw new Error("REI_INVALID_ANALYZER: id wajib");
    }
    if (typeof version !== "number") {
        throw new Error(`REI_INVALID_ANALYZER: ${id} butuh version numerik`);
    }
    if (typeof supports !== "function" || typeof analyze !== "function") {
        throw new Error(`REI_INVALID_ANALYZER: ${id} butuh supports() dan analyze()`);
    }
    return Object.freeze({ id, version, supports, analyze });
}

/**
 * Context analisis: kumpulan kolektor ber-budget.
 * Semua penambahan divalidasi di sini agar invarian model tidak bisa
 * dilanggar oleh analyzer mana pun.
 */
function makeAnalysisContext({ descriptor, header, buffer, limits, bands }) {
    const evidence = [];
    const findings = [];
    const hypothesesList = [];
    const relationships = [];
    const embeddedArtifacts = [];
    const diagnostics = [];
    let seq = 0;
    let hypSeq = 0;
    let relSeq = 0;
    let embCount = 0;
    /** Analyzer boleh menyarankan tahap lanjutan (di-merge pipeline). */
    const recommendedStages = [];

    return {
        descriptor,
        header,
        /** Buffer mendalam — null bila melebihi anggaran ukuran. */
        buffer,
        limits,
        bands,

        /**
         * Tambah bukti. `structured` (opsional) membawa DATA TERSTRUKTUR
         * yang menjadi sumber otoritatif inferensi — string `observation`
         * hanyalah tampilan dan tidak boleh di-parse ulang untuk menurunkan
         * klaim (nama DLL/fungsi bisa memuat delimiter palsu).
         */
        addEvidence({ source, kind, observation, location, structured }) {
            const item = freezeDeep({
                id: `ev-${String(++seq).padStart(4, "0")}`,
                source,
                kind,
                observation,
                ...(location ? { location: freezeDeep(location) } : {}),
                ...(structured ? { structured: freezeDeep(structured) } : {})
            });
            evidence.push(item);
            return item.id;
        },

        /** Observed fact — pembacaan langsung byte. */
        addObservedFact(statement, evidenceIds, confidenceScore = 0.9) {
            const f = observedFact({
                statement, evidenceIds,
                confidence: confidenceScore
            });
            f.kind = FindingKind.OBSERVED_FACT;
            findings.push(f);
            return f;
        },

        /** Inferred claim — kesimpulan, bukan kepastian. */
        addInferredClaim(statement, evidenceIds, conf) {
            const f = inferredClaim({
                statement, evidenceIds, confidence: conf
            });
            f.kind = FindingKind.INFERRED_CLAIM;
            findings.push(f);
            return f;
        },

        /** Hipotesis wajib berbukti — tanpa bukti ditolak oleh model. */
        addHypothesis(statement, supportingEvidenceIds, conf) {
            const h = hypothesis({
                statement,
                supportingEvidenceIds,
                confidence: conf
            });
            h.id = `hyp-${String(++hypSeq).padStart(4, "0")}`;
            hypothesesList.push(h);
            return h;
        },

        addRelationship({ type, target, note }) {
            relationships.push({
                id: `rel-${String(++relSeq).padStart(4, "0")}`,
                type,
                target,
                ...(note ? { note } : {})
            });
        },

        addEmbedded(emb) {
            if (embeddedArtifacts.length >= limits.maxEmbeddedArtifacts) {
                diagnostics.push({
                    code: "BUDGET_LIMIT_REACHED",
                    severity: "warning",
                    message: `batas embedded artifact (${limits.maxEmbeddedArtifacts}) tercapai`
                });
                return null;
            }
            embCount++;
            const item = freezeDeep({
                index: embCount,
                ...emb
            });
            embeddedArtifacts.push(item);
            return item;
        },

        addDiagnostic(code, message, severity = "info") {
            diagnostics.push({ code, message, severity });
        },

        /** Tahap lanjutan yang disarankan analyzer (dedup di pipeline). */
        suggestStage(stage) {
            if (!recommendedStages.includes(stage)) recommendedStages.push(stage);
        },

        // hasil yang dikumpulkan:
        _result: {
            get evidence() { return evidence; },
            get findings() { return findings; },
            get hypotheses() { return hypothesesList; },
            get relationships() { return relationships; },
            get embeddedArtifacts() { return embeddedArtifacts; },
            get diagnostics() { return diagnostics; },
            get recommendedStages() { return [...recommendedStages]; }
        }
    };
}

/**
 * Jalankan semua analyzer yang supports() terhadap ctx.
 * Kegagalan supports/analyze → diagnostic ANALYZER_*; TIDAK merusak
 * analisis lain. Mengembalikan provenance tiap analyzer.
 */
function runAnalyzers(analyzers, ctx) {
    const provenance = [];

    for (const a of analyzers) {
        let supported;
        try {
            supported = Boolean(a.supports(ctx));
        } catch (err) {
            provenance.push({
                id: a.id, version: a.version, status: "failed",
                reason: `supports() error: ${safeMessage(err)}`
            });
            continue;
        }
        if (!supported) {
            provenance.push({ id: a.id, version: a.version, status: "skipped" });
            continue;
        }
        try {
            a.analyze(ctx);
            provenance.push({
                id: a.id, version: a.version,
                status: "ok",
                diagnosticCount: ctx._result.diagnostics.length
            });
        } catch (err) {
            provenance.push({
                id: a.id, version: a.version, status: "failed",
                reason: `analyze() error: ${safeMessage(err)}`
            });
        }
    }

    return provenance;
}

function safeMessage(err) {
    return String(err?.message ?? err).slice(0, 300);
}

module.exports = {
    defineAnalyzer,
    makeAnalysisContext,
    runAnalyzers,
    analysisResultOf: (ctx) => ctx._result
};
