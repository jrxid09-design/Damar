"use strict";

/** W7-L6 METACOGNITION — pembangun record (spec §3). */

const { REASONS, fail } = require("./errors");
const { sanitizeEvidenceQuality, confidenceFromSafe } = require("./confidence");

const TRIGGERS = new Set(["CONTRADICTION", "EXPECTATION_VIOLATED", "REPEATED_FAILURE", "LOW_CONFIDENCE_ACTION", "OWNER_CHALLENGE", "SCHEDULED"]);
const PROPOSAL_KINDS = new Set(["REPLAN", "PROBE", "ASK_OWNER", "LOWER_CONFIDENCE", "ABANDON_GOAL", "OPEN_CONTRADICTION", "RECALIBRATE"]);

/** §5: proposal kognitif-murni boleh diterapkan tanpa Authority; sisanya normal governed. */
const COGNITIVE_ONLY_PROPOSALS = new Set(["LOWER_CONFIDENCE", "OPEN_CONTRADICTION", "PROBE"]);

function makeAssessment({ assessmentId, subjectRef, claim, evidenceQuality, nowMs, calibrationRef = null }) {
    if (typeof assessmentId !== "string" || !assessmentId) fail(REASONS.INVALID_RECORD, "assessmentId wajib string");
    // Bug review independen (audit putaran-30, AUD30-P2-3): evidenceQuality
    // dulu dibaca DUA KALI secara independen -- sekali di dalam
    // computeConfidence (untuk basis/value) dan sekali lagi di sini
    // (`{...evidenceQuality}` untuk arsip tersimpan). evidenceQuality
    // stateful bisa memberi nilai valid pada baca pertama (basis:
    // VERIFIED_EVIDENCE) lalu nilai lain pada baca kedua (evidenceQuality
    // tersimpan bilang verifiedCount:0) -- assessment yang disimpan
    // BERTENTANGAN dengan confidence yang disertifikasinya (pelanggaran
    // MC-1/MC-2). Disaring SEKALI di sini; value/basis dan salinan
    // tersimpan berasal dari snapshot yang SAMA persis.
    const safeEvidenceQuality = sanitizeEvidenceQuality(evidenceQuality);
    const { value, basis } = confidenceFromSafe(safeEvidenceQuality, nowMs);
    return Object.freeze({
        assessmentId, subjectRef: Object.freeze({ ...subjectRef }), claim,
        value, basis,
        evidenceQuality: Object.freeze(safeEvidenceQuality),
        calibrationRef
    });
}

function makeReview({ reviewId, trigger, findings = [], proposals = [], cost = { tokens: 0, ms: 0 }, bounds }) {
    // Bug review independen (audit putaran-25, AUD25-ADV-1): interpolasi
    // `${trigger}` mentah di pesan error meledakkan TypeError untuk Symbol
    // -- latent sampai sekarang karena index.js's openReview() sudah
    // menjaga TRIGGERS sebelum sampai sini (putaran-24), tapi builder ini
    // sendiri wajib aman untuk pemanggil lain/masa depan.
    if (!TRIGGERS.has(trigger)) fail(REASONS.INVALID_RECORD, `trigger '${typeof trigger === "string" ? trigger : typeof trigger}' tidak dikenal`);
    // Bug review independen (audit putaran-15, AUD15-P2-3): default `= []`
    // hanya berlaku untuk undefined, bukan null eksplisit -- findings:null/
    // proposals:null lolos lalu melempar TypeError mentah (bukan
    // INVALID_RECORD) di `.length`/`for...of`.
    if (findings !== undefined && !Array.isArray(findings)) fail(REASONS.INVALID_RECORD, "findings wajib array");
    if (proposals !== undefined && !Array.isArray(proposals)) fail(REASONS.INVALID_RECORD, "proposals wajib array");
    // Bug review independen (audit putaran-16, AUD16-P2-1): perbaikan
    // putaran-15 hanya menjaga WADAH array-nya -- elemen null/undefined di
    // dalamnya (mis. proposals: [null]) tetap melempar TypeError mentah di
    // `p.kind`. `cost` juga tidak pernah dijaga sama sekali -- cost:null
    // melempar TypeError mentah karena default `= {...}` hanya berlaku
    // untuk undefined.
    // Bug review independen (audit putaran-17, AUD17-P2-1): guard putaran-16
    // hanya memeriksa WADAH-nya -- BigInt/NaN/negatif di cost.tokens/ms
    // meledakkan aritmetika mentah atau meracuni anggaran refleksi di
    // openReview (index.js). Disamakan persis dengan guard di sana supaya
    // kedua tempat tidak berbeda predikat.
    if (!cost || typeof cost !== "object" ||
        typeof cost.tokens !== "number" || !Number.isFinite(cost.tokens) || cost.tokens < 0 ||
        typeof cost.ms !== "number" || !Number.isFinite(cost.ms) || cost.ms < 0) {
        fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
    }
    for (const p of proposals) {
        if (!p || typeof p !== "object") fail(REASONS.INVALID_RECORD, "setiap proposal wajib objek");
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${p.kind}` mentah meledakkan TypeError kalau p.kind Symbol.
        if (!PROPOSAL_KINDS.has(p.kind)) fail(REASONS.INVALID_RECORD, `proposal.kind '${typeof p.kind === "string" ? p.kind : typeof p.kind}' tidak dikenal`);
    }
    for (const f of findings) {
        if (!f || typeof f !== "object") fail(REASONS.INVALID_RECORD, "setiap finding wajib objek");
    }
    const boundedFindings = findings.length > bounds.MAX_FINDINGS_PER_REVIEW
        ? [...findings].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0)).slice(0, bounds.MAX_FINDINGS_PER_REVIEW)
        : findings;
    const boundedProposals = proposals.slice(0, bounds.MAX_PROPOSALS_PER_REVIEW);

    return Object.freeze({
        reviewId, trigger,
        findings: Object.freeze(boundedFindings.map(f => Object.freeze({ ...f }))),
        findingsTruncated: findings.length > bounds.MAX_FINDINGS_PER_REVIEW,
        proposals: Object.freeze(boundedProposals.map(p => Object.freeze({ ...p }))),
        cost: Object.freeze({ ...cost }),
        state: "OPEN"
    });
}

/** §7: skor Brier — never LogLoss di sini demi kesederhanaan (dipilih via scoreKind). */
function brierScore(predictedConfidence, outcomeCorrect) {
    const o = outcomeCorrect ? 1 : 0;
    return (predictedConfidence - o) ** 2;
}

function makeCalibrationRecord({ recordId, predictionRef, predictedValue, predictedConfidence, outcomeRef, outcomeValue, outcomeCorrect, scoreKind = "BRIER", windowFrom, windowTo }) {
    if (typeof recordId !== "string" || !recordId) fail(REASONS.INVALID_RECORD, "recordId wajib string");
    // Bug review independen (audit putaran-18, AUD18-A1): predictedConfidence
    // tidak pernah divalidasi -- BigInt meledakkan aritmetika mentah
    // (TypeError), NaN diam-diam menghasilkan skor kalibrasi error:NaN yang
    // meracuni statistik kalibrasi.
    if (typeof predictedConfidence !== "number" || !Number.isFinite(predictedConfidence)) {
        fail(REASONS.INVALID_RECORD, "predictedConfidence wajib number yang valid");
    }
    const error = scoreKind === "BRIER" ? brierScore(predictedConfidence, outcomeCorrect) : Math.abs(predictedConfidence - (outcomeCorrect ? 1 : 0));
    return Object.freeze({
        recordId, predictionRef, predictedValue, predictedConfidence,
        outcomeRef, outcomeValue, error, scoreKind,
        window: Object.freeze({ from: windowFrom, to: windowTo })
    });
}

module.exports = {
    TRIGGERS, PROPOSAL_KINDS, COGNITIVE_ONLY_PROPOSALS,
    makeAssessment, makeReview, makeCalibrationRecord, brierScore
};
