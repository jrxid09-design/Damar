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
const { makeAssessment, makeReview, makeCalibrationRecord, COGNITIVE_ONLY_PROPOSALS, TRIGGERS } = require("./records");

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
    function openReview(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan destructuring jadi TypeError mentah.
        const { trigger, subjectRef, findings = [], proposals = [], cost = { tokens: 0, ms: 0 } } = spec || {};
        rollBudgetWindow();

        // Bug review independen (audit putaran-9, AUD9-P2-2): JSON.stringify(subjectRef)
        // mengeksekusi toJSON milik pemanggil di dalam proses kognisi. subjectRef
        // hanya pernah berbentuk {entityId} atau {relationId}; kunci dibangun
        // dari field itu saja (sama seperti attention/index.js's targetKey).
        // Bug review independen (audit putaran-10, AUD10-P2-3): versi putaran-9
        // tidak memvalidasi bentuk subjectRef -- dua subjectRef yang BEDA tapi
        // sama-sama tidak punya entityId/relationId string jatuh ke
        // `relation:undefined`, menggabungkan review yang tidak terkait.
        // Bug review independen (audit putaran-28, AUD28-P2-6): entityId/
        // relationId dibaca DUA KALI (sekali di `typeof` test, sekali lagi
        // di template literal) -- getter/Proxy stateful yang mengembalikan
        // string sah pada baca pertama lalu Symbol pada baca kedua tetap
        // meledakkan TypeError, meniadakan jaminan single-read yang sudah
        // ditegakkan untuk `trigger` di fungsi yang sama (putaran-24).
        // Dibaca SEKALI ke variabel lokal, dipakai untuk KEDUA pemeriksaan.
        let subjectKey;
        const eid = subjectRef?.entityId;
        const rid = subjectRef?.relationId;
        if (typeof eid === "string") subjectKey = `entity:${eid}`;
        else if (typeof rid === "string") subjectKey = `relation:${rid}`;
        else fail(REASONS.INVALID_RECORD, "subjectRef wajib { entityId } atau { relationId } string");
        // Bug review independen (audit putaran-24, AUD24-P2-2): `trigger`
        // dulu langsung diinterpolasi ke debounceKey (mengeksekusi
        // toString milik pemanggil) SEBELUM makeReview sempat memvalidasi
        // TRIGGERS.has(trigger) -- kalau string hasil coercion kebetulan
        // cocok kunci debounce yang OPEN dan dalam cooldown, trigger
        // non-string diterima diam-diam lewat jalur early-return debounce,
        // sama seperti AUD9-P2-2 yang sudah menutup jalur ini untuk
        // subjectRef tapi tidak pernah dimigrasikan ke trigger.
        if (!TRIGGERS.has(trigger)) {
            // Pesan error TIDAK menginterpolasi `trigger` mentah -- template
            // literal `${trigger}` sendiri memanggil toString milik
            // pemanggil, persis jalur yang baru saja ditutup guard di atas.
            fail(REASONS.INVALID_RECORD, `trigger '${typeof trigger}' tidak dikenal`);
        }
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
        // Bug review independen (audit putaran-17, AUD17-P2-1): guard putaran-16
        // hanya memeriksa WADAH-nya -- BigInt di cost.tokens/ms meledakkan
        // `+` mentah (TypeError mentah), NaN meracuni tokensSpentThisWindow
        // untuk SISA JENDELA (setiap perbandingan `> budget` sesudahnya
        // otomatis false, anggaran refleksi mati total), dan nilai negatif
        // MENGKREDIT anggaran alih-alih membelanjakannya.
        if (!cost || typeof cost !== "object" ||
            typeof cost.tokens !== "number" || !Number.isFinite(cost.tokens) || cost.tokens < 0 ||
            typeof cost.ms !== "number" || !Number.isFinite(cost.ms) || cost.ms < 0) {
            fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
        }
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
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${reviewId}` mentah meledakkan TypeError untuk Symbol/mengeksekusi
        // toString pemanggil untuk objek, walau `reviews.get()` sendiri
        // (pencarian Map) tidak pernah mengeksekusi apa pun.
        if (!review) fail(REASONS.UNKNOWN_REVIEW, `review '${typeof reviewId === "string" ? reviewId : typeof reviewId}' tidak ditemukan`);
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
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.outcomeTier` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        if (!ADMISSIBLE_OUTCOME_TIERS.has(spec.outcomeTier)) {
            fail(REASONS.INVALID_OUTCOME, `outcomeTier '${typeof spec.outcomeTier === "string" ? spec.outcomeTier : typeof spec.outcomeTier}' tidak admissible untuk kalibrasi`);
        }
        if (typeof spec.outcomeRef !== "string" || !spec.outcomeRef) {
            fail(REASONS.INVALID_OUTCOME, "outcomeRef wajib ada dan bisa diselesaikan");
        }
        // Bug review independen (audit putaran-11, AUD11-P2-8): recordId
        // pemanggil tidak pernah dicek tabrakan -- replay sebuah recordId
        // yang sudah tercatat menghitung ganda satu bukti kalibrasi yang sama.
        // Bug review independen (audit putaran-30, AUD30-P2-1): `spec.recordId`
        // dibaca berkali-kali (cek tabrakan, lalu konstruksi) -- accessor
        // stateful bisa mengembalikan id berbeda tiap baca, melewati dedup.
        const recordId = spec.recordId;
        if (recordId && calibrationRecords.some(r => r.recordId === recordId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `recordId kalibrasi '${typeof recordId === "string" ? recordId : typeof recordId}' sudah ada`);
        }
        const record = makeCalibrationRecord({ ...spec, recordId: recordId ?? crypto.randomUUID() });
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
