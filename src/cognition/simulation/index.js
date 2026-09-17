"use strict";

/**
 * W8-L5 PREDICTIVE SIMULATION AND IMAGINATION SANDBOX.
 *
 * ACC subdomain `src/cognition/simulation/**`, new. Retires
 * `src/consciousness/Imagination.js` -- but only after a SEPARATE,
 * later-gated unreachable-proof step (currently false, per
 * WAVE8_LEGACY_CLASSIFICATION.md); this lane exists ALONGSIDE it for now,
 * "adapter-first migration."
 *
 * SIMULATION != REALITY. PREDICTION != FACT. Results are ALWAYS tier T10 --
 * never ingestable into the real world model (T10 is absent from
 * worldmodel's ADMISSIBLE_TIERS). This module imports NOTHING from
 * worldmodel/goals/Authority/actuation/the ACC journal -- structurally
 * incapable of writing real state, not merely policy-restricted.
 *
 * Contract: C:\Workspace\Damar-audit-evidence\wave7-10\wave8-recon\WAVE8_CONTRACTS_FROZEN.md
 * "## W8-L5 -- Simulation Sandbox". Baseline SHA f397ce4.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const { makeSimulationRun, makeSimulationResult, buildSafeSimValue } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");
const utilTypes = require("node:util").types;
const { isDeepStrictEqual } = require("node:util");

const HOURLY_WINDOW_MS = 3600000;

/**
 * Resolve `append` milik audit ledger lewat DESKRIPTOR, di sepanjang rantai
 * prototipe.
 *
 * `typeof auditLedger.append === "function"` adalah `[[Get]]` mentah: ledger
 * yang memasang getter di sana menjalankan kode pemanggil SEBELUM hook audit
 * sempat menangkap kegagalannya, jadi batas "tanpa eksekusi kode" tidak benar
 * (audit Wave8 L3/L5). Accessor diperlakukan sebagai tidak dapat dipakai.
 */
function resolveAuditAppend(auditLedger) {
    if (!auditLedger || (typeof auditLedger !== "object" && typeof auditLedger !== "function")) return null;
    let level = auditLedger;
    const seen = new Set();
    while (level && (typeof level === "object" || typeof level === "function")) {
        if (level === Object.prototype || level === Function.prototype) break;
        if (seen.has(level)) break;
        seen.add(level);
        if (utilTypes.isProxy(level)) return null;
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(level, "append");
        } catch {
            return null;
        }
        if (desc) {
            if (desc.get || desc.set) return null;
            return typeof desc.value === "function" ? desc.value : null;
        }
        try {
            level = Object.getPrototypeOf(level);
        } catch {
            return null;
        }
    }
    return null;
}

function safeOutcomeValue(outcome, key, fallback) {
    try {
        const descriptor = outcome && Object.getOwnPropertyDescriptor(outcome, key);
        return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : fallback;
    } catch {
        return fallback;
    }
}

/**
 * Absorpsi hasil audit, TANPA pernah memanggil `then` milik pemanggil.
 *
 * Versi-versi sebelumnya memanggil `then` (lewat `then.call` lalu lewat
 * `Reflect.apply`) dan hanya bisa menyerap promise yang DIKEMBALIKAN. Itu tidak
 * cukup: sebuah `then` milik pemanggil dapat mengeksekusi `Promise.reject(...)`
 * lalu mengembalikan `undefined`, sehingga penolakan itu lepas sama sekali dan
 * hanya bisa diamati sebagai `unhandledRejection` -- di bawah kebijakan Node
 * yang ketat, proses berhenti (audit a9cc5db). Memanggil kode pemanggil juga
 * bertentangan dengan batas "hook audit tidak menjalankan kode pemanggil".
 *
 * Karena itu `then` milik pemanggil TIDAK PERNAH dijalankan. Hanya promise ASLI
 * (dikenali lewat brand intrinsik `util.types.isPromise`, yang juga benar untuk
 * promise lintas-realm) yang diberi handler, dan handler itu dipasang lewat
 * `Promise.prototype.then` INTRINSIK sehingga tidak ada pencarian properti pada
 * objek pemanggil.
 *
 * Konsekuensi yang DISEBUT: thenable buatan sendiri (bukan Promise asli) tidak
 * lagi diikuti. Untuk hook audit itu justru yang diinginkan -- hook yang ingin
 * hasilnya diobservasi harus mengembalikan Promise asli.
 */
const REFLECT_APPLY = Reflect.apply;
const PROMISE_THEN = Promise.prototype.then;
const IS_PROMISE_INTRINSIC = utilTypes.isPromise;

function absorbAuditResult(result) {
    if (!result || (typeof result !== "object" && typeof result !== "function")) return;
    let isRealPromise;
    try {
        isRealPromise = REFLECT_APPLY(IS_PROMISE_INTRINSIC, utilTypes, [result]);
    } catch {
        return;
    }
    if (!isRealPromise) return;   // thenable pemanggil tidak pernah dipanggil
    try {
        REFLECT_APPLY(PROMISE_THEN, result, [undefined, () => {}]);
    } catch { /* promise asli yang aneh -> tidak ada rejection yang tertinggal */ }
}

async function createSimulationSandbox({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS, auditLedger = null } = {}) {
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    // Audit hook (contract L5: "run start/end, truncation, and export are
    // audited ... every store-boundary rejection is audited as a would-be
    // contamination attempt"). Kegagalan audit TIDAK PERNAH menggagalkan
    // operasi yang diaudit -- pola yang sama dengan lane Wave7 lainnya.
    function audit(eventType, fields) {
        try {
            const append = resolveAuditAppend(auditLedger);
            if (append) {
                const result = append.call(auditLedger, Object.freeze({
                    eventType, source: "acc.simulation", outcome: "ok",
                    metadata: Object.freeze({ lane: "W8-L5", ...fields })
                }));
                // Hook audit bisa ASYNC dan menolak. Seluruh pemeriksaan hasil
                // (termasuk nilai kembalian `then`) ditangani absorbAuditResult
                // tanpa satu pun pencarian properti pada objek pemanggil.
                absorbAuditResult(result);
            }
        } catch { /* audit failure never blocks the sandbox */ }
    }

    // Batas store: percobaan membaca store NYATA ditolak dan HARUS tercatat
    // sebagai percobaan kontaminasi (contract: "every store-boundary rejection
    // is audited as a would-be contamination attempt"). Penolakannya sendiri
    // terjadi di dalam loadSnapshot, jadi catch ini yang mengauditnya sebelum
    // melempar ulang -- tanpa ini penolakan konstruksi tidak pernah tercatat.
    let snapshot;
    try {
        snapshot = await loadSnapshot(store);
    } catch (err) {
        audit("cognition.simulation.cross_store_write_rejected", {
            reason: err && err.reason ? err.reason : "CROSS_STORE_WRITE_REJECTED"
        });
        throw err;
    }
    const runs = snapshot.runs;
    const results = snapshot.results;
    const coldStart = snapshot.coldStart;
    // Riwayat anggaran + asumsi yang diinvalidasi IKUT BERTAHAN melintasi
    // restart. Tidak mempersistensinya membuat bound 500k token/jam bisa
    // dilampaui hanya dengan me-restart, dan membuat hasil yang sudah
    // STALE_ASSUMPTIONS kembali COMPLETE (audit Wave8 L3/L5).
    const tokenLedger = Array.isArray(snapshot.tokenLedger) ? [...snapshot.tokenLedger] : []; // [{atMs, tokens}]
    const invalidatedAssumptions = new Set(
        Array.isArray(snapshot.invalidatedAssumptions) ? snapshot.invalidatedAssumptions : []);
    if (snapshot.degraded) {
        audit("cognition.simulation.store_unreadable", { reason: "store-unreadable-or-hostile" });
    }
    // Riwayat anggaran yang ADA tapi tidak dapat diverifikasi berarti jumlah
    // token yang sudah dipakai tidak diketahui. Menganggapnya nol adalah
    // gagal-buka yang mereset batas laju 500k token/jam (dan menghidupkan lagi
    // hasil yang sudah STALE_ASSUMPTIONS) hanya dengan merusak snapshot, jadi
    // jalannya run ditolak tegas sampai state anggaran dapat diverifikasi
    // (audit Wave8 L3/L5).
    const budgetUnverifiable = snapshot.degraded === true;
    for (const [runId, run] of runs) {
        if (run.state === "RUNNING") {
            // A lost in-flight run is an HONEST loss (contract: "a lost
            // in-flight sandbox run is an HONEST loss (never silently
            // reconstructed as if it had completed)").
            audit("cognition.simulation.run_lost", { runId });
        }
    }

    // Validasi DIJALANKAN SEBELUM kompaksi.
    //
    // Sebelumnya kompaksi berjalan lebih dulu, sehingga entri malformed bisa
    // menempati kapasitas dan mengevict entri SAH: dengan retensi 1, sebuah run
    // malformed yang lebih baru mengevict run sah yang lebih lama, lalu validasi
    // membuang run malformed itu -- dan tersisa NOL run. State sah hilang oleh
    // state yang memang tidak layak dipercaya (audit 97a1990).
    //
    // Validasi memakai BUILDER lane ini, bukan pemeriksaan sebagian: memeriksa
    // {runId, state} saja membuat run dengan `createdAtMs` tidak sah lolos,
    // menempati kapasitas, dan mengevict run sah pada retensi 1 (audit
    // ba68903). Builder adalah kontrak bentuk record, jadi memakainya ulang
    // menutup SELURUH medan sekaligus.
    for (const [runId, run] of [...runs]) {
        if (!isWellFormedPersistedRun(runId, run)) runs.delete(runId);
    }
    for (const [runId, result] of [...results]) {
        if (!isWellFormedPersistedResult(runId, result)) results.delete(runId);
    }

    // Construction-time compaction of a reloaded snapshot (same class as
    // Wave7 rounds 71-73 and W8-L3's own construction-time compaction
    // above): a snapshot persisted under a larger bound must be compacted
    // to the active bound before any record is exposed.
    {
        const maxRetained = Math.max(0, Math.trunc(bounds.MAX_RETAINED_RUNS));
        for (const [runId, run] of runs) {
            if (run.state === "RUNNING") {
                runs.delete(runId);
                results.delete(runId);
            }
        }
        while (runs.size > maxRetained) {
            let victimId = null, victimAt = Infinity;
            for (const r of runs.values()) {
                if (r.state === "RUNNING") continue; // never evict an in-flight run, even across restart -- it will be reconciled, not silently discarded
                if (r.createdAtMs < victimAt) { victimAt = r.createdAtMs; victimId = r.runId; }
            }
            if (!victimId) break;
            runs.delete(victimId);
            results.delete(victimId);
        }
    }

    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }

    /**
     * Record tersimpan harus lulus builder lane ini DAN tidak dinormalkan olehnya.
     *
     * Builder MENORMALKAN banyak medan (mis. `fidelity` non-string menjadi
     * "DEFAULT", `confidence` dijepit ke 0..1, `tokensUsed` non-finite menjadi
     * 0, `validUntilMs` masa depan diterima apa adanya). "Lulus builder" saja
     * karena itu bukan bukti bentuk yang benar: record ASLINYA tetap tersimpan,
     * sehingga nilai seperti `confidence: 999` atau `tokensUsed: -7` tetap
     * ter-expose lewat `getResult()` dan ikut menggantikan hasil yang sah
     * (audit 472b6e0).
     *
     * Karena itu SALINAN AMAN record tersimpan dibandingkan dengan hasil
     * builder: medan yang dinormalkan membuat keduanya tidak sama, jadi record
     * itu ditolak. Salinan diambil lewat buildSafeSimValue (deskriptor, tanpa
     * accessor) dan hasil builder sudah disanitasi builder, sehingga
     * perbandingan ini tidak menjalankan kode pemanggil.
     */
    function isCanonicallyEqual(stored, canonical) {
        let safeStored;
        try {
            safeStored = buildSafeSimValue(stored);
        } catch {
            return false;
        }
        if (!safeStored || typeof safeStored !== "object") return false;
        return isDeepStrictEqual(safeStored, canonical);
    }

    function isWellFormedPersistedRun(id, run) {
        if (!run || typeof run !== "object") return false;
        if (run.runId !== id) return false;
        if (!["COMPLETE", "TRUNCATED", "FAILED"].includes(run.state)) return false;
        if (!Number.isFinite(run.createdAtMs) || run.createdAtMs > now()) return false;
        let canonical;
        try {
            canonical = makeSimulationRun({
                runId: run.runId, question: run.question, scenario: run.scenario,
                initialStateRef: run.initialStateRef, steps: run.steps,
                horizonDays: run.horizonDays, budgetTokens: run.budgetTokens,
                fidelity: run.fidelity, nowMs: run.createdAtMs
            }, bounds);
        } catch { return false; }
        // `makeSimulationRun` SELALU menghasilkan state "RUNNING" (run yang baru
        // dibuat), sedangkan yang dipersistensi sudah selesai. Karena itu state
        // tersimpan dipakai saat membandingkan; medan lainnya tetap harus sama
        // persis dengan hasil bentuk kanonik.
        return isCanonicallyEqual(run, { ...canonical, state: run.state });
    }

    function isWellFormedPersistedResult(id, result) {
        if (!result || typeof result !== "object") return false;
        if (result.runId !== id) return false;
        if (!runs.has(id)) return false;
        // FORCED T10: tier lain tidak pernah sah dan tidak boleh menggantikan
        // hasil sah mana pun.
        if (result.tier !== "T10") return false;
        // Semantik yang TIDAK dapat ditangkap perbandingan kanonik: token yang
        // dipakai tidak pernah negatif, hasil tidak pernah dibuat di masa depan,
        // dan TTL tidak pernah mendahului pembuatannya (audit 472b6e0).
        if (!Number.isFinite(result.tokensUsed) || result.tokensUsed < 0) return false;
        if (!Number.isFinite(result.generatedAtMs) || result.generatedAtMs > now()) return false;
        if (!Number.isFinite(result.validUntilMs) || result.validUntilMs < result.generatedAtMs) return false;
        // BATAS ANGGARAN DAN TTL dari RUN pasangannya. Perbandingan kanonik tidak
        // dapat menangkap keduanya: builder hanya menyalin `validUntilMs` dan
        // `tokensUsed` apa adanya, sehingga hasil dengan token jauh melampaui
        // anggaran run -- atau TTL yang membentang ribuan tahun -- tetap lolos
        // dan terbaca sebagai COMPLETE, ikut menggantikan hasil yang sah dan
        // membuat kuota token serta kesegaran tidak bermakna (audit a9cc5db).
        const pairedRun = runs.get(id);
        if (!pairedRun || !Number.isFinite(pairedRun.budgetTokens)) return false;
        if (result.tokensUsed > pairedRun.budgetTokens) return false;
        if (result.validUntilMs > result.generatedAtMs + Math.max(0, Math.trunc(bounds.TTL_MS))) return false;
        // BENTUK yang tidak dinormalkan builder: `risks`/`assumptions` yang bukan
        // array diteruskan apa adanya oleh builder, jadi perbandingan kanonik
        // tidak menangkapnya dan record malformed tetap lolos (audit 472b6e0).
        if (!Array.isArray(result.risks) || !Array.isArray(result.assumptions)) return false;
        if (result.distribution !== null &&
            (typeof result.distribution !== "object" || Array.isArray(result.distribution))) return false;
        let canonical;
        try {
            canonical = makeSimulationResult({
                runId: result.runId, distribution: result.distribution, risks: result.risks,
                assumptions: result.assumptions, confidence: result.confidence,
                state: result.state, tokensUsed: result.tokensUsed,
                validUntilMs: result.validUntilMs, nowMs: result.generatedAtMs
            }, bounds);
        } catch { return false; }
        // `generatedAtMs` dibaca DUA kali oleh builder (sebagai `nowMs` dan
        // sebagai medan hasil), jadi hasilnya harus memuat nilai itu apa adanya.
        return isCanonicallyEqual(result, canonical);
    }

    function pruneLedger(nowMs) {
        const cutoff = nowMs - HOURLY_WINDOW_MS;
        while (tokenLedger.length && tokenLedger[0].atMs < cutoff) tokenLedger.shift();
    }

    function hourlyTokensUsed(nowMs) {
        pruneLedger(nowMs);
        return tokenLedger.reduce((sum, e) => sum + e.tokens, 0);
    }

    function evictRetainedIfOverBound() {
        const maxRetained = Math.max(0, Math.trunc(bounds.MAX_RETAINED_RUNS));
        while (runs.size > maxRetained) {
            let victimId = null, victimAt = Infinity;
            for (const r of runs.values()) {
                if (r.state === "RUNNING") continue;
                if (r.createdAtMs < victimAt) { victimAt = r.createdAtMs; victimId = r.runId; }
            }
            if (!victimId) break;
            runs.delete(victimId);
            results.delete(victimId);
        }
    }

    /**
     * `provider` is caller-injected: `(run) => ({ tokensUsed, distribution,
     * risks, assumptions, confidence })`, sync or async. L5's job is the
     * sandbox/bound/isolate/tier-force system AROUND whatever provider
     * actually computes a rollout -- it is not itself a physics/prediction
     * engine (out of this lane's contract scope).
     */
    async function startRun(spec) {
        let runId, question, scenario, initialStateRef, steps, horizonDays, budgetTokens, fidelity, provider;
        try {
            const source = spec || {};
            const read = (key) => {
                const descriptor = Object.getOwnPropertyDescriptor(source, key);
                if (!descriptor) return undefined;
                if (descriptor.get || descriptor.set) throw new Error("accessor");
                return descriptor.value;
            };
            runId = read("runId"); question = read("question"); scenario = read("scenario");
            initialStateRef = read("initialStateRef"); steps = read("steps"); horizonDays = read("horizonDays");
            budgetTokens = read("budgetTokens"); fidelity = read("fidelity"); provider = read("provider");
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (runId && runs.has(runId)) fail(REASONS.DUPLICATE_RECORD_ID, `runId '${typeof runId === "string" ? runId : typeof runId}' sudah ada`);
        if (typeof provider !== "function") fail(REASONS.INVALID_RECORD, "provider wajib fungsi");

        const runningCount = [...runs.values()].filter(r => r.state === "RUNNING").length;
        if (runningCount >= Math.max(0, Math.trunc(bounds.MAX_CONCURRENT_RUNS))) {
            fail(REASONS.CONCURRENT_RUN_LIMIT_EXCEEDED, `simulasi konkuren melebihi batas (${bounds.MAX_CONCURRENT_RUNS})`);
        }

        const nowMs = now();
        if (budgetUnverifiable) {
            // Jumlah token terpakai tidak dapat diverifikasi, jadi batas laju
            // tidak dapat ditegakkan. Menjalankan run akan melewati batas
            // secara diam-diam; menolaknya adalah arah yang aman.
            audit("cognition.simulation.budget_unverifiable", { runId: typeof runId === "string" ? runId : null });
            fail(REASONS.BUDGET_EXCEEDED, "riwayat anggaran tidak dapat diverifikasi; run ditolak sampai state anggaran pulih");
        }
        if (hourlyTokensUsed(nowMs) + (Number.isInteger(budgetTokens) ? budgetTokens : 0) > bounds.MAX_TOKENS_PER_HOUR) {
            fail(REASONS.BUDGET_EXCEEDED, `anggaran token per jam melebihi batas (${bounds.MAX_TOKENS_PER_HOUR})`);
        }

        const run = makeSimulationRun({ runId, question, scenario, initialStateRef, steps, horizonDays, budgetTokens, fidelity, nowMs }, bounds);
        runs.set(run.runId, run);
        audit("cognition.simulation.run_started", { runId: run.runId, fidelity: run.fidelity, budgetTokens: run.budgetTokens });
        const reservation = { atMs: nowMs, tokens: budgetTokens };
        tokenLedger.push(reservation);

        let outcome;
        try {
            outcome = await provider(run);
        } catch {
            outcome = null; // provider failure -> FAILED, planning is told, never silently proceeds as if it succeeded
        }

        let tokensUsed = 0;
        let reportedTokensUsed = 0;
        try {
            const descriptor = outcome && Object.getOwnPropertyDescriptor(outcome, "tokensUsed");
            if (descriptor && !descriptor.get && !descriptor.set && Number.isFinite(descriptor.value)) {
                reportedTokensUsed = Math.max(0, descriptor.value);
                tokensUsed = Math.min(run.budgetTokens, reportedTokensUsed);
            }
            else if (outcome) outcome = null;
        } catch { outcome = null; }
        reservation.tokens = tokensUsed;

        let state;
        if (!outcome) {
            state = "FAILED";
        } else if (reportedTokensUsed > run.budgetTokens) {
            state = "TRUNCATED"; // budget exhausted mid-run -- explicitly marked incomplete, never presented as complete
        } else {
            state = "COMPLETE";
        }

        let result;
        try {
            result = makeSimulationResult({
                runId: run.runId,
                distribution: outcome ? safeOutcomeValue(outcome, "distribution", null) : null,
                risks: outcome ? safeOutcomeValue(outcome, "risks", []) : [],
                assumptions: outcome ? safeOutcomeValue(outcome, "assumptions", []) : [],
                confidence: outcome ? safeOutcomeValue(outcome, "confidence", 0) : 0,
                state, tokensUsed,
                validUntilMs: nowMs + Math.max(0, Math.trunc(bounds.TTL_MS)),
                nowMs
            }, bounds);
        } catch {
            state = "FAILED";
            try {
                result = makeSimulationResult({ runId: run.runId, distribution: null, risks: [], assumptions: [], confidence: 0,
                    state, tokensUsed: 0, validUntilMs: nowMs + Math.max(0, Math.trunc(bounds.TTL_MS)), nowMs }, bounds);
            } catch (fatal) {
                runs.delete(run.runId);
                results.delete(run.runId);
                throw fatal;
            }
        }

        runs.set(run.runId, Object.freeze({ ...run, state }));
        results.set(run.runId, result);
        // run end + truncation are audited (contract L5 verification hooks).
        audit(state === "TRUNCATED" ? "cognition.simulation.run_truncated" : "cognition.simulation.run_ended",
            { runId: run.runId, state, tokensUsed });
        evictRetainedIfOverBound();
        return getResult(run.runId);
    }

    /** Stale assumptions are a QUERY-TIME view, never a mutation of the stored record. */
    function getResult(runId) {
        const result = results.get(runId);
        if (!result) fail(REASONS.UNKNOWN_RUN, `runId '${typeof runId === "string" ? runId : typeof runId}' tidak ditemukan`);
        const assumptions = Array.isArray(result.assumptions) ? result.assumptions : [];
        const invalidated = assumptions.some((item) => typeof item === "string" && invalidatedAssumptions.has(item));
        if (result.state === "COMPLETE" && (invalidated || now() > result.validUntilMs)) {
            return Object.freeze({ ...result, state: "STALE_ASSUMPTIONS" });
        }
        return result;
    }

    function invalidateAssumptions(ref) {
        if (typeof ref !== "string" || !ref) fail(REASONS.INVALID_RECORD, "assumption ref wajib string");
        invalidatedAssumptions.add(ref);
        audit("cognition.simulation.assumptions_invalidated", { ref });
        return Object.freeze({ invalidated: true, ref });
    }

    function listRuns() {
        return Object.freeze([...runs.values()]);
    }

    function runsSize() { return runs.size; }

    async function persist() {
        try {
            // "export" dalam kontrak L5: persist adalah satu-satunya jalur yang
            // mengeluarkan state sandbox dari memori, jadi ia diaudit
            // ("run start/end, truncation, and export are audited").
            audit("cognition.simulation.exported", { runs: runs.size, results: results.size });
            return await saveSnapshot(store, { runs, results, tokenLedger, invalidatedAssumptions });
        } catch (err) {
            // Batas store: penulisan ke store NYATA ditolak. Dicatat sebagai
            // percobaan kontaminasi (contract: "every store-boundary rejection
            // is audited as a would-be contamination attempt").
            audit("cognition.simulation.cross_store_write_rejected", {
                reason: err && err.reason ? err.reason : "CROSS_STORE_WRITE_REJECTED"
            });
            throw err;
        }
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        simulationColdStart: coldStart,
        startRun, getResult, invalidateAssumptions, listRuns, runsSize,
        persist, laws, bounds
    });
}

module.exports = { createSimulationSandbox, BOUNDS, SCHEMA_VERSION };
