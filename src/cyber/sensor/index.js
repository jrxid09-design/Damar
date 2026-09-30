"use strict";

/**
 * DCD SENSOR PLANE — telemetry, discovery, observations.
 *
 * No execution authority. The Sensor plane normalises incoming signals
 * (agent telemetry, OSINT hits, scanner findings, Kali read-only probes)
 * into validated CyberRecord shapes. Every record is T4-T7; the Sensor
 * plane NEVER mints T1 (VERIFIED) or T3 (AUTHORITY).
 *
 * Invariants enforced here:
 *   DC-08: DCD produces no T1/T3 records
 *   DC-10: ALERT_NOT_FACT — alert is T7 HYPOTHESIS, not T4 OBSERVED
 *   DC-53: NO_RAW_TELEMETRY_IN_COGNITIVE_CONTEXT — rawRef, not inline body
 *   DC-61: DCD_OWNS_NO_T1
 */

const contracts = require("../contracts");
const { assertCyberRecord, SOURCE_TIER_BINDINGS, EVIDENCE_SOURCE_KINDS } = contracts;

/**
 * Normalize a raw observation into a validated CyberRecord shape.
 * Returns { ok, record, errors }.
 *
 * rawRef is an opaque id pointing to the raw payload in its original store.
 * The record body never contains the raw payload inline (DC-53).
 * Tier and epistemicClass are DERIVED from sourceKind (DC-111, DC-123).
 */
function normalizeObservation(params) {
    const {
        observationId,
        sourceKind,
        rawRef,
        summary,
        observedAt,
        entityRef,
        confidence,
        ttlMs,
    } = params || {};

    const errors = [];

    if (typeof observationId !== "string" || !observationId) {
        errors.push("observationId required (string)");
    }
    if (!EVIDENCE_SOURCE_KINDS.includes(sourceKind)) {
        errors.push(`unknown sourceKind '${sourceKind}'`);
    }
    // rawRef must be an opaque reference — DC-53: no inline body/payload
    if (typeof rawRef !== "string" || !rawRef) {
        errors.push("rawRef required (opaque reference id)");
    }
    if (typeof summary !== "string" || !summary) {
        errors.push("summary required");
    }
    if (!Number.isFinite(observedAt)) {
        errors.push("observedAt must be finite epoch-ms");
    }

    if (errors.length) return { ok: false, record: null, errors };

    // For constrained sources, use the first permitted tier/class.
    // For unconstrained (null binding), default to T4 OBSERVED.
    const binding = SOURCE_TIER_BINDINGS[sourceKind];
    const tier = binding ? binding.tiers[0] : "T4";
    const epistemicClass = binding ? binding.epistemicClasses[0] : "OBSERVED";

    // T1 (VERIFIED) and T3 (AUTHORITY) are forbidden — DC-08, DC-61
    if (tier === "T1" || tier === "T3") {
        return { ok: false, record: null, errors: [`Sensor plane cannot mint tier '${tier}'`] };
    }

    const resolvedTtlMs = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : 3_600_000;
    const record = {
        recordId: observationId,
        recordKind: "OBSERVATION",
        tier,
        epistemicClass,
        sourceKind,
        rawRef,
        summary,
        observedAt,
        // validUntil required for T4 non-DECLARED records (truth lattice §7)
        validUntil: tier === "T4" && epistemicClass !== "DECLARED"
            ? observedAt + resolvedTtlMs
            : undefined,
        ttlMs: resolvedTtlMs,
        entityRef: entityRef || null,
        confidence: typeof confidence === "number" ? Math.min(1, Math.max(0, confidence)) : null,
    };

    const validation = assertCyberRecord(record);
    if (!validation.ok) return { ok: false, record: null, errors: validation.errors };

    return { ok: true, record: Object.freeze(record), errors: [] };
}

/**
 * Admit a batch of telemetry observations. Returns { accepted, rejected }.
 * No blocking — gaps are marked (DI-06 / DC-56: NO_BACKGROUND_WORK_ON_CRITICAL_RESPONSE_PATH).
 */
function admitTelemetry(observations) {
    const accepted = [];
    const rejected = [];
    const items = Array.isArray(observations) ? observations : [];
    for (const obs of items) {
        const result = normalizeObservation(obs);
        if (result.ok) accepted.push(result.record);
        else rejected.push({ input: obs, errors: result.errors });
    }
    return { accepted, rejected };
}

/**
 * Create an in-memory observation store with TTL eviction.
 * CACHE != TRUTH (I-97): losing this store loses only latency, not facts.
 * Returns { put, get, sweep, size }.
 */
function createObservationStore() {
    const store = Object.create(null);

    function put(record) {
        if (!record || typeof record.recordId !== "string") return;
        store[record.recordId] = { record, insertedAt: Date.now() };
    }

    function get(id) {
        const entry = store[id];
        if (!entry) return null;
        if ((Date.now() - entry.insertedAt) > entry.record.ttlMs) {
            delete store[id];
            return null;
        }
        return entry.record;
    }

    function sweep(nowMs) {
        for (const id of Object.keys(store)) {
            const entry = store[id];
            if ((nowMs - entry.insertedAt) > entry.record.ttlMs) delete store[id];
        }
    }

    function size() { return Object.keys(store).length; }

    return Object.freeze({ put, get, sweep, size });
}

module.exports = Object.freeze({
    normalizeObservation,
    admitTelemetry,
    createObservationStore,
});
