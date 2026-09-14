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
    // Bug review independen (audit putaran-37, AUD37-ADV-1): Map (bukan
    // array) supaya cek tabrakan recordId dan penghapusan tertua di
    // recordCalibration keduanya O(1), bukan O(n) per panggilan. Map
    // mempertahankan urutan penyisipan sama seperti array untuk FIFO.
    const calibrationRecords = new Map(); // recordId -> record
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
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec || {}`
        // tidak melindungi dari Proxy yang di-revoke (tetap truthy/typeof
        // "object") -- destructuring ini tetap [[Get]] mentah terhadapnya.
        let trigger, subjectRef, findings, proposals, cost;
        try {
            ({ trigger, subjectRef, findings = [], proposals = [], cost = { tokens: 0, ms: 0 } } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
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
        // Bug review independen (audit putaran-37, AUD37-P2-1): perbaikan
        // putaran-28 di atas membaca `relationId` TANPA SYARAT bahkan
        // ketika `entityId` sudah valid -- short-circuit ASLI (baca
        // relationId HANYA kalau entityId gagal) hilang, getter
        // relationId pemanggil yang sebelumnya tidak pernah tersentuh jadi
        // tereksekusi (kelas yang sama dengan AUD36-P2-2 di worldmodel/
        // attention). Dikembalikan: relationId hanya dibaca kalau entityId
        // terbukti bukan string.
        // Bug review independen (audit putaran-43, W7R43-P2-3): `subjectRef?.entityId`
        // MASIH melakukan [[Get]] biasa kalau `subjectRef` bukan null/undefined
        // -- `?.` cuma melindungi dari null/undefined, BUKAN dari Proxy yang
        // di-revoke, yang melempar TypeError MENTAH pada [[Get]] apa pun.
        // Short-circuit AUD37-P2-1 (relationId hanya dibaca kalau entityId
        // gagal) DIPERTAHANKAN -- setiap baca dibungkus try/catch sendiri,
        // TIDAK digabung jadi satu blok tak bersyarat.
        let subjectKey;
        let eid;
        try {
            eid = subjectRef?.entityId;
        } catch {
            fail(REASONS.INVALID_RECORD, "subjectRef tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (typeof eid === "string") {
            subjectKey = `entity:${eid}`;
        } else {
            let rid;
            try {
                rid = subjectRef?.relationId;
            } catch {
                fail(REASONS.INVALID_RECORD, "subjectRef tidak dapat diverifikasi dengan aman, ditolak");
            }
            if (typeof rid === "string") subjectKey = `relation:${rid}`;
            else fail(REASONS.INVALID_RECORD, "subjectRef wajib { entityId } atau { relationId } string");
        }
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
        // Bug review independen (audit putaran-34, AUD34-ADV-2): `cost.tokens`/
        // `cost.ms` dulu dibaca berkali-kali secara independen (guard tipe,
        // `wouldExceedBudget`, akumulasi `+=` di bawah, LALU lagi di dalam
        // makeReview) -- getter stateful bisa lolos guard dengan nilai sah
        // lalu membalas nilai besar/negatif pada baca berikutnya, meracuni
        // anggaran jendela (kelas yang sama dengan AUD17-P2-1, yang menutup
        // MASALAH TIPE tapi bukan masalah baca-berkali-kali ini). `tokens`/
        // `ms` dibaca SEKALI SAJA masing-masing (SEBELUM divalidasi, bukan
        // divalidasi-lewat-`cost.x`-lalu-dibaca-lagi) ke lokal, lalu
        // dibangun ulang jadi objek polos yang diteruskan ke makeReview --
        // baca internal makeReview di sana pun tidak lagi menyentuh
        // accessor pemanggil.
        if (!cost || typeof cost !== "object") {
            fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
        }
        // Bug review independen (audit putaran-44, W7R44-P2-2): `typeof cost
        // !== "object"` TIDAK menangkap Proxy yang di-revoke -- `cost.tokens`/
        // `cost.ms` tetap [[Get]] mentah terhadapnya.
        let costTokens, costMs;
        try {
            costTokens = cost.tokens;
            costMs = cost.ms;
        } catch {
            fail(REASONS.INVALID_RECORD, "cost tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (typeof costTokens !== "number" || !Number.isFinite(costTokens) || costTokens < 0 ||
            typeof costMs !== "number" || !Number.isFinite(costMs) || costMs < 0) {
            fail(REASONS.INVALID_RECORD, "cost wajib { tokens, ms } berupa number >= 0 yang valid");
        }
        const safeCost = Object.freeze({ tokens: costTokens, ms: costMs });
        const wouldExceedBudget =
            tokensSpentThisWindow + costTokens > bounds.REFLECTION_BUDGET_TOKENS_PER_HOUR ||
            msSpentThisWindow + costMs > bounds.REFLECTION_BUDGET_MS_PER_HOUR;

        const review = makeReview({ reviewId: crypto.randomUUID(), trigger, findings, proposals, cost: safeCost, bounds });
        const finalReview = wouldExceedBudget
            ? Object.freeze({ ...review, state: "EXPIRED", debounceCount: 1, lastTriggeredAtMs: now() })
            : Object.freeze({ ...review, debounceCount: 1, lastTriggeredAtMs: now() });

        if (!wouldExceedBudget) {
            tokensSpentThisWindow += costTokens;
            msSpentThisWindow += costMs;
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
        // Bug review independen (audit putaran-11, AUD11-P2-8): recordId
        // pemanggil tidak pernah dicek tabrakan -- replay sebuah recordId
        // yang sudah tercatat menghitung ganda satu bukti kalibrasi yang sama.
        // Bug review independen (audit putaran-30, AUD30-P2-1; putaran-34,
        // AUD34-ADV-3): `recordId`/`outcomeRef` dulu divalidasi lewat
        // `spec.x` langsung lalu (untuk recordId) dilewatkan lewat
        // `{...spec}` -- spread itu sendiri membaca ulang KEDUANYA (getter
        // stateful bisa memvalidasi outcomeRef string sah lalu menyimpan
        // objek pada baca kedua). Dikeluarkan bersama lewat destructuring.
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec`
        // sudah dijaga BUKAN null/non-objek di atas, tapi Proxy yang
        // di-revoke tetap typeof "object" -- destructuring ini tetap
        // [[Get]] mentah terhadapnya.
        let outcomeTier, outcomeRef, recordId, specRest;
        try {
            ({ outcomeTier, outcomeRef, recordId, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!ADMISSIBLE_OUTCOME_TIERS.has(outcomeTier)) {
            fail(REASONS.INVALID_OUTCOME, `outcomeTier '${typeof outcomeTier === "string" ? outcomeTier : typeof outcomeTier}' tidak admissible untuk kalibrasi`);
        }
        if (typeof outcomeRef !== "string" || !outcomeRef) {
            fail(REASONS.INVALID_OUTCOME, "outcomeRef wajib ada dan bisa diselesaikan");
        }
        // Bug review independen (audit putaran-37, AUD37-ADV-1): cek
        // tabrakan `.some()` dan pemangkasan `.shift()` sama-sama O(n) per
        // panggilan -- pada MAX_CALIBRATION_RECORDS (100000), mengisi+
        // membuang penuh berarti ~10^10 perbandingan. `calibrationRecords`
        // (Map, urutan penyisipan sama seperti array untuk FIFO) memberi
        // cek tabrakan dan penghapusan tertua O(1).
        if (recordId && calibrationRecords.has(recordId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `recordId kalibrasi '${typeof recordId === "string" ? recordId : typeof recordId}' sudah ada`);
        }
        const record = makeCalibrationRecord({ ...specRest, outcomeRef, recordId: recordId ?? crypto.randomUUID() });
        calibrationRecords.set(record.recordId, record);
        if (calibrationRecords.size > bounds.MAX_CALIBRATION_RECORDS) {
            calibrationRecords.delete(calibrationRecords.keys().next().value);
        }
        return record;
    }

    function getReview(reviewId) { return reviews.get(reviewId) ?? null; }
    function calibrationCount() { return calibrationRecords.size; }
    function reviewCount() { return reviews.size; }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        assess, openReview, classifyProposal, applyProposal,
        recordCalibration, getReview, calibrationCount, reviewCount,
        laws, bounds
    });
}

module.exports = { createMetacognition, laws, BOUNDS };
