"use strict";

/**
 * W7-L6 METACOGNITION, CONFIDENCE AND SELF-CORRECTION.
 *
 * ACC subdomain `src/cognition/metacog/**` (`W7_METACOGNITION_SPEC.md`).
 * Extends witness/prediction/epistemics; `consciousness/Metacognition.js`
 * retires. METACOGNITION != SELF-AUTHORIZATION: this module imports
 * NOTHING from src/authority/** and holds no code path that calls it
 * (MC-5/MC-A5) — only `proposals[].kind` classification is exposed, and
 * applying a governed proposal is the CALLER's job through the owning
 * subsystem's normal API.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { makeAssessment, makeReview, makeCalibrationRecord, COGNITIVE_ONLY_PROPOSALS } = require("./records");

const ADMISSIBLE_OUTCOME_TIERS = new Set(["T1", "T2"]);

async function createMetacognition({ clock = { nowMs: () => Date.now() }, bounds = BOUNDS } = {}) {

    const reviews = new Map();
    const calibrationRecords = [];
    const lastReviewBySubjectTrigger = new Map(); // `${subjectKey}::${trigger}` -> reviewId
    let budgetWindowStartMs = clock.nowMs();
    let tokensSpentThisWindow = 0;
    let msSpentThisWindow = 0;

    function now() { return clock.nowMs(); }

    function rollBudgetWindow() {
        if (now() - budgetWindowStartMs >= 3_600_000) {
            budgetWindowStartMs = now();
            tokensSpentThisWindow = 0;
            msSpentThisWindow = 0;
        }
    }

    function assess(subjectRef, claim, evidenceQuality) {
        return makeAssessment({
            assessmentId: crypto.randomUUID(), subjectRef, claim, evidenceQuality, nowMs: now()
        });
    }

    function openReviewCount() {
        let n = 0;
        for (const r of reviews.values()) if (r.state === "OPEN") n++;
        return n;
    }

    /**
     * MC-5: tidak ada parameter "parentReviewId" — struktural mustahil
     * membuat review dari review (depth dibatasi 1 lewat ABSENnya jalur itu).
     */
    function openReview({ trigger, subjectRef, findings = [], proposals = [], cost = { tokens: 0, ms: 0 } }) {
        rollBudgetWindow();

        // Bug review independen (audit putaran-9, AUD9-P2-2): JSON.stringify(subjectRef)
        // mengeksekusi toJSON milik pemanggil di dalam proses kognisi. subjectRef
        // hanya pernah berbentuk {entityId} atau {relationId}; kunci dibangun
        // dari field itu saja (sama seperti attention/index.js's targetKey).
        // Bug review independen (audit putaran-10, AUD10-P2-3): versi putaran-9
        // tidak memvalidasi bentuk subjectRef -- dua subjectRef yang BEDA tapi
        // sama-sama tidak punya entityId/relationId string jatuh ke
        // `relation:undefined`, menggabungkan review yang tidak terkait.
        let subjectKey;
        if (typeof subjectRef?.entityId === "string") subjectKey = `entity:${subjectRef.entityId}`;
        else if (typeof subjectRef?.relationId === "string") subjectKey = `relation:${subjectRef.relationId}`;
        else fail(REASONS.INVALID_RECORD, "subjectRef wajib { entityId } atau { relationId } string");
        const debounceKey = `${subjectKey}::${trigger}`;
        const existingId = lastReviewBySubjectTrigger.get(debounceKey);
        if (existingId) {
            const existing = reviews.get(existingId);
            if (existing && existing.state === "OPEN" && (now() - (existing.lastTriggeredAtMs ?? 0)) < bounds.REVIEW_COOLDOWN_MS) {
                const bumped = Object.freeze({ ...existing, debounceCount: (existing.debounceCount ?? 1) + 1, lastTriggeredAtMs: now() });
                reviews.set(existingId, bumped);
                return bumped; // MC-6: dedebounce, bukan review baru
            }
        }

        if (openReviewCount() >= bounds.MAX_OPEN_REVIEWS) {
            fail(REASONS.OPEN_REVIEW_LIMIT_EXCEEDED, "jumlah review terbuka melebihi batas");
        }

        // Bug review independen (audit putaran-16, AUD16-P2-1): guard cost di
        // makeReview berjalan SETELAH baris ini membaca cost.tokens/cost.ms --
        // cost:null tetap melempar TypeError mentah di sini duluan, sebelum
        // sempat sampai ke makeReview.
        if (!cost || typeof cost !== "object") fail(REASONS.INVALID_RECORD, "cost wajib objek");
        const wouldExceedBudget =
            tokensSpentThisWindow + cost.tokens > bounds.REFLECTION_BUDGET_TOKENS_PER_HOUR ||
            msSpentThisWindow + cost.ms > bounds.REFLECTION_BUDGET_MS_PER_HOUR;

        const review = makeReview({ reviewId: crypto.randomUUID(), trigger, findings, proposals, cost, bounds });
        const finalReview = wouldExceedBudget
            ? Object.freeze({ ...review, state: "EXPIRED", debounceCount: 1, lastTriggeredAtMs: now() })
            : Object.freeze({ ...review, debounceCount: 1, lastTriggeredAtMs: now() });

        if (!wouldExceedBudget) {
            tokensSpentThisWindow += cost.tokens;
            msSpentThisWindow += cost.ms;
        }

        reviews.set(finalReview.reviewId, finalReview);
        lastReviewBySubjectTrigger.set(debounceKey, finalReview.reviewId);
        evictOldestClosedReviewIfOverBound();
        return finalReview;
    }

    /** Batas total retensi (open dibatasi terpisah oleh MAX_OPEN_REVIEWS di atas). */
    function evictOldestClosedReviewIfOverBound() {
        if (reviews.size <= bounds.MAX_TOTAL_REVIEWS_RETAINED) return;
        for (const [id, r] of reviews) {
            if (r.state !== "OPEN") {
                reviews.delete(id);
                for (const [key, mappedId] of lastReviewBySubjectTrigger) {
                    if (mappedId === id) lastReviewBySubjectTrigger.delete(key);
                }
                return;
            }
        }
    }

    /**
     * §5: proposal kognitif-murni diterapkan LANGSUNG lewat `cognitiveApplyPort`
     * (fungsi milik pemanggil, bukan Authority). Proposal lain hanya
     * DIKLASIFIKASIKAN sebagai GOVERNED — penerapannya di luar modul ini.
     */
    function classifyProposal(proposalKind) {
        return COGNITIVE_ONLY_PROPOSALS.has(proposalKind) ? "COGNITIVE_ONLY" : "GOVERNED";
    }

    function applyProposal(reviewId, proposalIndex, cognitiveApplyPort = null) {
        const review = reviews.get(reviewId);
        if (!review) fail(REASONS.UNKNOWN_REVIEW, `review '${reviewId}' tidak ditemukan`);
        const proposal = review.proposals[proposalIndex];
        if (!proposal) fail(REASONS.INVALID_RECORD, "proposal index tidak ditemukan");

        const classification = classifyProposal(proposal.kind);
        let applied = false;
        if (classification === "COGNITIVE_ONLY" && cognitiveApplyPort) {
            try {
                cognitiveApplyPort(proposal);
                applied = true;
            } catch {
                applied = false;
            }
        }

        const nextProposals = review.proposals.map((p, i) => (i === proposalIndex
            ? Object.freeze({ ...p, classification, appliedAt: applied ? now() : null, rejected: classification === "GOVERNED" ? null : !applied })
            : p));
        const next = Object.freeze({ ...review, proposals: Object.freeze(nextProposals) });
        reviews.set(reviewId, next);
        return { classification, applied };
    }

    /** MC-A6: hasil hanya diterima dari T1/T2 dengan bukti yang bisa diselesaikan. */
    function recordCalibration(spec) {
        if (!ADMISSIBLE_OUTCOME_TIERS.has(spec.outcomeTier)) {
            fail(REASONS.INVALID_OUTCOME, `outcomeTier '${spec.outcomeTier}' tidak admissible untuk kalibrasi`);
        }
        if (typeof spec.outcomeRef !== "string" || !spec.outcomeRef) {
            fail(REASONS.INVALID_OUTCOME, "outcomeRef wajib ada dan bisa diselesaikan");
        }
        // Bug review independen (audit putaran-11, AUD11-P2-8): recordId
        // pemanggil tidak pernah dicek tabrakan -- replay sebuah recordId
        // yang sudah tercatat menghitung ganda satu bukti kalibrasi yang sama.
        if (spec.recordId && calibrationRecords.some(r => r.recordId === spec.recordId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `recordId kalibrasi '${spec.recordId}' sudah ada`);
        }
        const record = makeCalibrationRecord({ ...spec, recordId: spec.recordId ?? crypto.randomUUID() });
        calibrationRecords.push(record);
        if (calibrationRecords.length > bounds.MAX_CALIBRATION_RECORDS) calibrationRecords.shift();
        return record;
    }

    function getReview(reviewId) { return reviews.get(reviewId) ?? null; }
    function calibrationCount() { return calibrationRecords.length; }
    function reviewCount() { return reviews.size; }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        assess, openReview, classifyProposal, applyProposal,
        recordCalibration, getReview, calibrationCount, reviewCount,
        laws, bounds
    });
}

module.exports = { createMetacognition, laws, BOUNDS };
