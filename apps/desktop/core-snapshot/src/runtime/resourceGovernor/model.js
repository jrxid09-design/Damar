"use strict";

function freezeDeep(value) {
    if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) freezeDeep(value[key]);
        Object.freeze(value);
    }
    return value;
}

const WORKLOAD_CLASSES = Object.freeze([
    "INTERACTIVE", "VOICE", "TOOL", "AGENT",
    "RE_ANALYSIS", "BACKGROUND", "MAINTENANCE", "TEST", "UNKNOWN"
]);

const LATENCY_CLASSES = Object.freeze(["STRICT", "NORMAL", "BULK"]);

const PRESSURE_BANDS = Object.freeze({
    NORMAL: "NORMAL", ELEVATED: "ELEVATED", HIGH: "HIGH",
    CRITICAL: "CRITICAL", UNKNOWN: "UNKNOWN"
});

const ADMISSION_OUTCOMES = Object.freeze({
    ADMIT: "ADMIT", QUEUE: "QUEUE", DEFER: "DEFER",
    REJECT_RESOURCE_LIMIT: "REJECT_RESOURCE_LIMIT"
});

const REASONS = Object.freeze({
    OK_ADMITTED: "OK_ADMITTED",
    OK_QUEUED: "OK_QUEUED",
    DEFERRED_BACKGROUND_UNDER_PRESSURE: "DEFERRED_BACKGROUND_UNDER_PRESSURE",
    DEFERRED_EVENT_LOOP_SEVERE: "DEFERRED_EVENT_LOOP_SEVERE",
    DEFERRED_PRESSURE_HIGH: "DEFERRED_PRESSURE_HIGH",
    DEFERRED_OBSERVER_UNAVAILABLE: "DEFERRED_OBSERVER_UNAVAILABLE",
    LIMIT_GLOBAL_CONCURRENCY: "LIMIT_GLOBAL_CONCURRENCY",
    LIMIT_GROUP_CONCURRENCY: "LIMIT_GROUP_CONCURRENCY",
    LIMIT_CLASS_CONCURRENCY: "LIMIT_CLASS_CONCURRENCY",
    PRESSURE_CRITICAL_HEAVY: "PRESSURE_CRITICAL_HEAVY",
    MEMORY_HARD_CEILING: "MEMORY_HARD_CEILING",
    QUEUE_FULL: "QUEUE_FULL",
    INVALID_DEMAND: "INVALID_DEMAND",
    INVALID_WORKLOAD_ID: "INVALID_WORKLOAD_ID",
    UNKNOWN_GROUP: "UNKNOWN_GROUP",
    OBSERVER_UNAVAILABLE: "OBSERVER_UNAVAILABLE",
    INTERNAL_FAULT: "INTERNAL_FAULT"
});

const RECOMMENDATION_TYPES = Object.freeze([
    "REDUCE_CONCURRENCY", "PAUSE_BACKGROUND",
    "RELEASE_IDLE_LEASES", "CANCEL_PREEMPTIBLE"
]);

const HEAVY_CLASSES = Object.freeze([
    "AGENT", "RE_ANALYSIS", "BACKGROUND", "MAINTENANCE", "TEST", "UNKNOWN"
]);

const LIGHT_CLASSES = Object.freeze(["INTERACTIVE", "VOICE", "TOOL"]);

const CLASS_DEFAULT_PRIORITY = Object.freeze({
    INTERACTIVE: 90, VOICE: 95, TOOL: 70, AGENT: 60,
    RE_ANALYSIS: 40, BACKGROUND: 20, MAINTENANCE: 15,
    TEST: 30, UNKNOWN: 10
});

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }

function validateDemandShape(raw, demandMaxima, workloadClass = "UNKNOWN") {
    const errors = [];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("INVALID_DEMAND: demand must be a plain object");
    }
    const out = {};
    const max = demandMaxima;

    for (const field of ["cpuWeight", "ioWeight", "networkWeight"]) {
        const v = raw[field] ?? 0;
        if (!isFiniteNumber(v) || v < 0 || v > 100) errors.push(`${field} must be a number in [0,100]`);
        else out[field] = v;
    }
    const mem = raw.memoryBytesHint ?? 0;
    if (!isFiniteNumber(mem) || mem < 0 || mem > max.memoryBytesMax) {
        errors.push(`memoryBytesHint must be in [0,${max.memoryBytesMax}]`);
    } else out.memoryBytesHint = mem;

    const dur = raw.expectedDurationMs ?? 0;
    if (!isFiniteNumber(dur) || dur < 0 || dur > max.expectedDurationMsMax) {
        errors.push(`expectedDurationMs must be in [0,${max.expectedDurationMsMax}]`);
    } else out.expectedDurationMs = dur;

    const prio = raw.priority;
    if (prio === undefined || prio === null) {
        out.priority = CLASS_DEFAULT_PRIORITY[workloadClass] ?? 10;
    } else if (!isFiniteNumber(prio) || prio < 0 || prio > 100) {
        errors.push("priority must be in [0,100]");
    } else out.priority = prio;

    const lat = raw.latencyClass ?? "NORMAL";
    if (!LATENCY_CLASSES.includes(lat)) errors.push(`latencyClass must be one of ${LATENCY_CLASSES.join("|")}`);
    else out.latencyClass = lat;

    const group = raw.concurrencyGroup ?? "default";
    if (typeof group !== "string" || group.length === 0 || group.length > 64 || /\s/.test(group)) {
        errors.push("concurrencyGroup must be a short whitespace-free string");
    } else out.concurrencyGroup = group;

    out.preemptible = raw.preemptible === true;
    const prov = raw.provenance ?? "unspecified";
    if (typeof prov !== "string" || prov.length > 128) errors.push("provenance must be a string <=128 chars");
    else out.provenance = prov;

    if (errors.length > 0) throw new Error(`INVALID_DEMAND: ${errors.join("; ")}`);
    return freezeDeep(out);
}

function createResourceDemand(spec, demandMaxima) {
    if (spec === null || typeof spec !== "object") {
        throw new Error("INVALID_DEMAND: demand must be a plain object");
    }
    const { workloadClass, ...rest } = spec;
    if (!WORKLOAD_CLASSES.includes(workloadClass)) {
        throw new Error(`INVALID_DEMAND: workloadClass must be one of ${WORKLOAD_CLASSES.join("|")}`);
    }
    const max = demandMaxima ?? {
        memoryBytesMax: Number.MAX_SAFE_INTEGER,
        expectedDurationMsMax: Number.MAX_SAFE_INTEGER
    };
    const shape = validateDemandShape(rest, max, workloadClass);
    return freezeDeep({ workloadClass, ...shape });
}

function createAdmissionDecision({ outcome, reason, workloadId, lease = null, queuePosition = null }) {
    if (!Object.values(ADMISSION_OUTCOMES).includes(outcome)) {
        throw new Error(`INVALID_DECISION: outcome ${outcome}`);
    }
    if (!Object.values(REASONS).includes(reason)) {
        throw new Error(`INVALID_DECISION: reason ${reason}`);
    }
    return freezeDeep({ outcome, reason, workloadId, lease, queuePosition });
}

module.exports = {
    freezeDeep,
    WORKLOAD_CLASSES, LATENCY_CLASSES, PRESSURE_BANDS,
    ADMISSION_OUTCOMES, REASONS, RECOMMENDATION_TYPES,
    HEAVY_CLASSES, LIGHT_CLASSES, CLASS_DEFAULT_PRIORITY,
    createResourceDemand, createAdmissionDecision, validateDemandShape,
    isFiniteNumber
};
