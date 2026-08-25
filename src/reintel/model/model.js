/**
 * RE Intelligence — model domain kanonik.
 *
 * Pemisahan epistemik wajib:
 *   OBSERVED FACT   — hasil pembacaan langsung dari byte artifact.
 *   INFERRED CLAIM  — kesimpulan dari fakta teramati (bukan kepastian).
 *   HYPOTHESIS      — dugaan yang HARUS membawa bukti pendukung; tidak
 *                     pernah boleh disimpan sebagai observed fact.
 *
 * Semua objek model dibekukan (immutable). Confidence deterministik:
 * skor 0..1 dengan banding LOW/MEDIUM/HIGH yang didokumentasikan di
 * ReIntelConfig. Klaim perilaku selalu "possible" — analisis statis
 * tidak pernah mengamati eksekusi.
 */

"use strict";

const ArtifactType = Object.freeze({
    TEXT: "TEXT",
    SCRIPT: "SCRIPT",
    PE_EXECUTABLE: "PE_EXECUTABLE",
    PE_DLL: "PE_DLL",
    ELF: "ELF",
    ARCHIVE: "ARCHIVE",
    FIRMWARE_BLOB: "FIRMWARE_BLOB",
    BINARY: "BINARY",
    UNKNOWN: "UNKNOWN"
});

const ConfidenceLevel = Object.freeze({
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH"
});

const EvidenceKind = Object.freeze({
    MAGIC_BYTES: "magic_bytes",
    HEADER_FIELD: "header_field",
    EXTENSION: "extension",
    CONTENT_HEURISTIC: "content_heuristic",
    ENTROPY: "entropy",
    IMPORT_TABLE: "import_table",
    EXPORT_TABLE: "export_table",
    SECTION_TABLE: "section_table",
    STRING_LITERAL: "string_literal",
    SCRIPT_PATTERN: "script_pattern"
});

const FindingKind = Object.freeze({
    OBSERVED_FACT: "observed_fact",
    INFERRED_CLAIM: "inferred_claim"
});

const BehavioralClaimType = Object.freeze({
    MAY_ACCESS_NETWORK: "MAY_ACCESS_NETWORK",
    MAY_CREATE_PROCESS: "MAY_CREATE_PROCESS",
    MAY_MODIFY_FILES: "MAY_MODIFY_FILES",
    MAY_ACCESS_REGISTRY: "MAY_ACCESS_REGISTRY",
    MAY_LOAD_DYNAMIC_LIBRARY: "MAY_LOAD_DYNAMIC_LIBRARY",
    MAY_PERFORM_CRYPTOGRAPHY: "MAY_PERFORM_CRYPTOGRAPHY"
});

const RelationshipType = Object.freeze({
    CONTAINS: "CONTAINS",
    IMPORTS: "IMPORTS",
    REFERENCES: "REFERENCES",
    EMBEDS: "EMBEDS",
    DERIVED_FROM: "DERIVED_FROM",
    SIMILAR_TO: "SIMILAR_TO"
});

const AnalysisStage = Object.freeze({
    IDENTIFICATION: "IDENTIFICATION",
    HASHING: "HASHING",
    STRUCTURAL_ANALYSIS: "STRUCTURAL_ANALYSIS",
    FINDINGS: "FINDINGS",
    HYPOTHESES: "HYPOTHESES",
    CONFIDENCE: "CONFIDENCE",
    BEHAVIOR_MODEL: "BEHAVIOR_MODEL",
    REPORT: "REPORT",
    MANUAL_TRIAGE: "MANUAL_TRIAGE",
    DEEP_PE_ANALYSIS: "DEEP_PE_ANALYSIS",
    ARCHIVE_DECOMPOSITION: "ARCHIVE_DECOMPOSITION",
    DYNAMIC_ANALYSIS: "DYNAMIC_ANALYSIS",
    PROTOCOL_CAPTURE_ANALYSIS: "PROTOCOL_CAPTURE_ANALYSIS"
});

const DiagnosticSeverity = Object.freeze({
    INFO: "info",
    WARNING: "warning",
    ERROR: "error"
});

/** Pembekuan mendalam — laporan dan model harus immutable. */
function freezeDeep(value) {
    if (value === null || typeof value !== "object") return value;
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    if (!Object.isFrozen(value)) Object.freeze(value);
    return value;
}

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Skor → level memakai banding dari config. Skor dibulatkan ke 2 desimal
 * agar representasi tidak berpura-pura presisi.
 */
function makeConfidence(score, bands = { lowBelow: 0.35, mediumBelow: 0.7 }) {
    const s = clamp01(Math.round(clamp01(score) * 100) / 100);
    const level = s < bands.lowBelow
        ? ConfidenceLevel.LOW
        : s < bands.mediumBelow
            ? ConfidenceLevel.MEDIUM
            : ConfidenceLevel.HIGH;
    return freezeDeep({ score: s, level });
}

/**
 * Agregasi konservatif: gabungan confidence sekumpulan bukti adalah
 * MINIMUM-nya. Sistem tidak boleh lebih yakin daripada bukti terlemah
 * yang menjadi dasar kesimpulan.
 */
function combineConfidence(confidences, bands) {
    if (!confidences.length) return makeConfidence(0, bands);
    const min = Math.min(...confidences.map((c) => clamp01(c.score ?? c)));
    return makeConfidence(min, bands);
}

/** ID deterministik per-run berurutan (ev-0001, fact-0001, ...). */
function nextId(prefix, seq) {
    return `${prefix}-${String(seq).padStart(4, "0")}`;
}

/** Observed fact: pernyataan faktual hasil pembacaan byte. */
function observedFact({ statement, evidenceIds = [], confidence = 1 }) {
    if (typeof statement !== "string" || !statement.trim()) {
        throw new Error("REI_INVALID_FACT: observed fact butuh statement");
    }
    return {
        kind: FindingKind.OBSERVED_FACT,
        statement,
        evidenceIds: [...evidenceIds],
        confidence: typeof confidence === "number" ? confidence : confidence
    };
}

/** Inferred claim: kesimpulan dari fakta — bukan kepastian. */
function inferredClaim({ statement, evidenceIds = [], confidence }) {
    return {
        kind: FindingKind.INFERRED_CLAIM,
        statement,
        evidenceIds: [...evidenceIds],
        confidence
    };
}

/**
 * Hypothesis: dugaan + bukti pendukung WAJIB. Tanpa bukti → ditolak;
 * ini menjaga invarian bahwa hipotesis tak pernah menyamar jadi fakta.
 */
function hypothesis({ statement, supportingEvidenceIds = [], confidence }) {
    if (!supportingEvidenceIds.length) {
        throw new Error(
            "REI_HYPOTHESIS_UNBOUND: hipotesis wajib membawa bukti pendukung"
        );
    }
    return {
        kind: "hypothesis",
        status: "unverified",
        statement,
        supportingEvidenceIds: [...supportingEvidenceIds],
        confidence
    };
}

module.exports = {
    ArtifactType,
    ConfidenceLevel,
    EvidenceKind,
    FindingKind,
    BehavioralClaimType,
    RelationshipType,
    AnalysisStage,
    DiagnosticSeverity,
    freezeDeep,
    clamp01,
    makeConfidence,
    combineConfidence,
    nextId,
    observedFact,
    inferredClaim,
    hypothesis
};
