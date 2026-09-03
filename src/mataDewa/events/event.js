/**
 * SpatialEvent — hasil fusi satu/lebih SpatialObservation yang kompatibel.
 *
 * JANGAN disamakan dengan observasi: observasi adalah satu titik data mentah;
 * event adalah kesimpulan terkorelasi dengan garis keturunan bukti (evidence
 * lineage) yang dipertahankan.
 *
 * Skema (konsep):
 *   SpatialEvent {
 *     id, type, location, radiusM, firstObservedAt, lastObservedAt,
 *     severity, confidence, epistemic, sources[], evidence[],
 *     affectedRoutes[], recommendedContext
 *   }
 */

const { isValidPoint, isFiniteNumber } = require("../spatial/geo");
const { EPISTEMIC_STATUS, canonical: canonicalEpistemic, freshnessBand } = require("../spatial/epistemic");

const SCHEMA_VERSION = 1;

const SEVERITY = Object.freeze({
    INFO: "info",
    WATCH: "watch",
    WARNING: "warning",
    CRITICAL: "critical"
});

const SEVERITY_ORDER = Object.freeze({ info: 0, watch: 1, warning: 2, critical: 3 });

let counter = 0;
function nextId(prefix = "evt") {
    counter = (counter + 1) % 0xffffff;
    return `${prefix}_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

function clamp01(value, fallback = 0.5) {
    if (!isFiniteNumber(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

function canonicalSeverity(value, fallback = SEVERITY.INFO) {
    return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, value) ? value : fallback;
}

function severityAtLeast(value, threshold) {
    return (SEVERITY_ORDER[canonicalSeverity(value)] ?? 0) >=
        (SEVERITY_ORDER[canonicalSeverity(threshold)] ?? 0);
}

/**
 * Buat SpatialEvent beku.
 * Mengembalikan { ok:true, event } atau { ok:false, reason }.
 */
function createEvent(input = {}, { nowMs = Date.now() } = {}) {
    const location = input.location;
    if (!isValidPoint(location)) {
        return { ok: false, reason: "event.location wajib berupa titik valid {lat,lon}" };
    }

    const firstObservedAt = isFiniteNumber(input.firstObservedAt) ? input.firstObservedAt : null;
    const lastObservedAt = isFiniteNumber(input.lastObservedAt) ? input.lastObservedAt : firstObservedAt;
    if (firstObservedAt === null) {
        return { ok: false, reason: "event.firstObservedAt wajib (epoch ms)" };
    }

    const sources = Array.isArray(input.sources) ? [...new Set(input.sources.filter(Boolean))] : [];
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice() : [];

    const event = Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        id: typeof input.id === "string" && input.id ? input.id : nextId(),
        type: typeof input.type === "string" && input.type ? input.type : "generic",
        location: Object.freeze({ lat: location.lat, lon: location.lon }),
        radiusM: isFiniteNumber(input.radiusM) ? Math.max(0, input.radiusM) : 0,
        firstObservedAt,
        lastObservedAt,
        severity: canonicalSeverity(input.severity, SEVERITY.INFO),
        confidence: clamp01(input.confidence, 0.5),
        epistemic: canonicalEpistemic(input.epistemic, EPISTEMIC_STATUS.INFERRED),
        sources: Object.freeze(sources),
        evidence: Object.freeze(evidence),
        affectedRoutes: Object.freeze(Array.isArray(input.affectedRoutes) ? input.affectedRoutes.slice() : []),
        recommendedContext: input.recommendedContext ?? null,
        createdAt: isFiniteNumber(input.createdAt) ? input.createdAt : nowMs
    });

    return { ok: true, event };
}

/** Freshness event mengacu pada observasi TERAKHIR yang membentuknya. */
function describeEventFreshness(event, opts, nowMs = Date.now()) {
    return {
        band: freshnessBand(event?.lastObservedAt, opts, nowMs),
        ageMs: Number.isFinite(event?.lastObservedAt)
            ? Math.max(0, nowMs - event.lastObservedAt) : Infinity
    };
}

module.exports = Object.freeze({
    SCHEMA_VERSION,
    SEVERITY,
    SEVERITY_ORDER,
    canonicalSeverity,
    severityAtLeast,
    createEvent,
    describeEventFreshness
});
