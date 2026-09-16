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
const { makeSimulationRun, makeSimulationResult } = require("./records");
const { loadSnapshot, saveSnapshot } = require("./store");

const HOURLY_WINDOW_MS = 3600000;

function safeOutcomeValue(outcome, key, fallback) {
    try {
        const descriptor = outcome && Object.getOwnPropertyDescriptor(outcome, key);
        return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : fallback;
    } catch {
        return fallback;
    }
}

async function createSimulationSandbox({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

    const snapshot = await loadSnapshot(store);
    const runs = snapshot.runs;
    const results = snapshot.results;
    const coldStart = snapshot.coldStart;
    const tokenLedger = []; // [{atMs, tokens}] -- rolling hourly budget, in-process only (not persisted; a restart resets the hourly window, an honest and safe direction to err in)
    const invalidatedAssumptions = new Set();

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

    for (const [runId, run] of [...runs]) {
        if (!run || run.runId !== runId || !["COMPLETE", "TRUNCATED", "FAILED"].includes(run.state)) runs.delete(runId);
    }
    for (const [runId, result] of [...results]) {
        if (!result || result.runId !== runId || result.tier !== "T10" || !runs.has(runId) ||
            !["COMPLETE", "TRUNCATED", "FAILED"].includes(result.state)) results.delete(runId);
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
        if (hourlyTokensUsed(nowMs) + (Number.isInteger(budgetTokens) ? budgetTokens : 0) > bounds.MAX_TOKENS_PER_HOUR) {
            fail(REASONS.BUDGET_EXCEEDED, `anggaran token per jam melebihi batas (${bounds.MAX_TOKENS_PER_HOUR})`);
        }

        const run = makeSimulationRun({ runId, question, scenario, initialStateRef, steps, horizonDays, budgetTokens, fidelity, nowMs }, bounds);
        runs.set(run.runId, run);
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
        return Object.freeze({ invalidated: true, ref });
    }

    function listRuns() {
        return Object.freeze([...runs.values()]);
    }

    function runsSize() { return runs.size; }

    async function persist() {
        return saveSnapshot(store, { runs, results });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        simulationColdStart: coldStart,
        startRun, getResult, invalidateAssumptions, listRuns, runsSize,
        persist, laws, bounds
    });
}

module.exports = { createSimulationSandbox, BOUNDS, SCHEMA_VERSION };
