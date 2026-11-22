"use strict";

/**
 * W8-L5 record builders. Same trap-safe discipline as every other Wave7/8
 * lane in this codebase (descriptor-based reads, DANGEROUS_KEYS rejected,
 * non-finite/function/symbol/BigInt rejected, bounded depth/node count).
 * Written as an independent local copy (not a shared import) -- the
 * manifest's own Stage B rule is "no shared-file edits" between
 * contract-parallel lanes; L3/L5 each get their own copy of this
 * well-established pattern rather than a new cross-lane shared dependency.
 */

const { REASONS, fail, SimulationError } = require("./errors");
const { BOUNDS } = require("./bounds");
const utilTypes = require("node:util").types;
const IS_PROXY = utilTypes.isProxy;

const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_NODES = 4096;

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function buildSafeSimValue(value, depth = 0, budget) {
    if (!budget) budget = { count: 0 };
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh membawa fungsi");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh membawa Symbol");
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh membawa BigInt");
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh berupa angka non-finite");
    }
    if (t !== "object") return value;
    // PROXY DITOLAK SEBELUM OPERASI REFLEKTIF APA PUN.
    //
    // Seluruh pembacaan di bawah memakai operasi reflektif (getOwnPropertyDescriptor,
    // Reflect.ownKeys, getPrototypeOf). Pada Proxy, semuanya menjalankan trap
    // milik pemanggil, jadi "pembacaan lewat deskriptor" TIDAK cukup -- nilainya
    // sudah menjalankan kode sebelum validasi (audit Wave8 L3/L5).
    if (IS_PROXY(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh berupa Proxy");
    }
    if (depth > MAX_SCAN_DEPTH) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi terlalu dalam untuk diverifikasi dengan aman");
    budget.count += 1;
    if (budget.count > MAX_SCAN_NODES) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node pada nilai simulasi melebihi batas");

    try {
        if (Array.isArray(value)) {
            const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
            const len = lengthDescriptor && !lengthDescriptor.get && !lengthDescriptor.set ? lengthDescriptor.value : -1;
            if (!Number.isInteger(len) || len < 0) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array tidak sah");
            const out = [];
            for (let i = 0; i < len; i++) {
                const desc = Object.getOwnPropertyDescriptor(value, i);
                if (!desc || desc.get || desc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `elemen array pada indeks '${i}' tidak boleh membawa properti accessor`);
                out.push(buildSafeSimValue(desc.value, depth + 1, budget));
            }
            for (const key of Reflect.ownKeys(value)) {
                if (key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < len)) {
                    fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "array tidak boleh membawa properti tambahan");
                }
            }
            return out;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh berupa instance kelas");
        }
        const out = {};
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak boleh membawa kunci Symbol");
            if (DANGEROUS_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `nilai simulasi tidak boleh membawa properti accessor: '${key}'`);
            out[key] = buildSafeSimValue(desc.value, depth + 1, budget);
        }
        return out;
    } catch (err) {
        if (err instanceof SimulationError) throw err;
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai simulasi tidak dapat diverifikasi dengan aman");
    }
}

function makeSimulationRun({ runId, question, scenario, initialStateRef, steps, horizonDays, budgetTokens, fidelity, nowMs }, bounds = BOUNDS) {
    if (typeof runId !== "string" || !runId) fail(REASONS.INVALID_RECORD, "runId wajib string");
    if (typeof question !== "string" || !question) fail(REASONS.INVALID_RECORD, "question wajib string");
    if (!Number.isInteger(steps) || steps <= 0 || steps > bounds.MAX_STEPS_PER_RUN) {
        fail(REASONS.BUDGET_EXCEEDED, `steps wajib integer 1..${bounds.MAX_STEPS_PER_RUN}`);
    }
    if (!Number.isFinite(horizonDays) || horizonDays <= 0 || horizonDays > bounds.MAX_HORIZON_DAYS) {
        fail(REASONS.BUDGET_EXCEEDED, `horizonDays wajib 0 < n <= ${bounds.MAX_HORIZON_DAYS}`);
    }
    if (!Number.isInteger(budgetTokens) || budgetTokens <= 0 || budgetTokens > bounds.MAX_TOKENS_PER_RUN) {
        fail(REASONS.BUDGET_EXCEEDED, `budgetTokens wajib integer 1..${bounds.MAX_TOKENS_PER_RUN}`);
    }
    // Snapshot immutability: initialStateRef is sanitized+frozen ONCE, here,
    // at run construction -- never re-read live mid-run. A region that was
    // "unknown" in the caller's snapshot at this instant stays unknown in
    // THIS run's frozen copy forever, even if the real scene later resolves
    // it (closes the TOCTOU-shaped ambiguity documented in
    // WAVE8_CONTRACT_AUDIT_EVIDENCE.md round 4).
    const safeInitialStateRef = deepFreeze(buildSafeSimValue(initialStateRef));
    const safeScenario = deepFreeze(buildSafeSimValue(scenario));
    return Object.freeze({
        runId, question, scenario: safeScenario, initialStateRef: safeInitialStateRef,
        steps, horizonDays, budgetTokens, fidelity: typeof fidelity === "string" ? fidelity : "DEFAULT",
        state: "RUNNING", createdAtMs: nowMs
    });
}

function makeSimulationResult({ runId, distribution, risks, assumptions, confidence, state, tokensUsed, validUntilMs, nowMs }, bounds = BOUNDS) {
    if (typeof runId !== "string" || !runId) fail(REASONS.INVALID_RECORD, "runId wajib string");
    if (!["COMPLETE", "TRUNCATED", "FAILED"].includes(state)) fail(REASONS.INVALID_RECORD, "state hasil simulasi tidak dikenal");
    const safeDistribution = deepFreeze(buildSafeSimValue(distribution ?? null));
    const safeRisks = deepFreeze(buildSafeSimValue(risks ?? []));
    const safeAssumptions = deepFreeze(buildSafeSimValue(assumptions ?? []));
    const safeConfidence = (typeof confidence === "number" && Number.isFinite(confidence)) ? Math.max(0, Math.min(1, confidence)) : 0;
    const result = Object.freeze({
        runId,
        distribution: safeDistribution, risks: safeRisks, assumptions: safeAssumptions,
        confidence: safeConfidence,
        // FORCED T10: never any other tier, unconditionally, regardless of caller input.
        tier: "T10",
        state, tokensUsed: Number.isFinite(tokensUsed) ? tokensUsed : 0,
        validUntilMs, generatedAtMs: nowMs
    });
    let size;
    try {
        size = Buffer.byteLength(JSON.stringify(result), "utf8");
    } catch {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "hasil simulasi tidak dapat diserialisasi dengan aman");
    }
    if (size > bounds.MAX_RESULT_BYTES) {
        fail(REASONS.RESULT_TOO_LARGE, `hasil simulasi (${size} byte) melebihi batas (${bounds.MAX_RESULT_BYTES})`);
    }
    return result;
}

module.exports = { buildSafeSimValue, deepFreeze, makeSimulationRun, makeSimulationResult };
