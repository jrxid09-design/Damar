/**
 * SpatialEvent — hasil fusi satu/lebih SpatialObservation yang kompatibel
 * (MD-005 ketat + MD-006 lineage).
 *
 * JANGAN disamakan dengan observasi: observasi adalah satu titik data mentah;
 * event adalah kesimpulan terkorelasi dengan garis keturunan bukti (evidence
 * lineage) yang dipertahankan.
 *
 * HUKUM MD-005:
 *  - REJECT bukan clamp: severity tidak dikenal → INFO fallback eksplisit
 *    (bukan kegagalan diam); confidence/quality di luar [0,1] DITOLAK;
 *    NaN/Infinity/epoch negatif/skew masa depan DITOLAK.
 *  - Deep canonicalization: mutasi input pemanggil setelah konstruksi tidak
 *    bisa mengubah event (deep copy + deep freeze penuh, termasuk evidence
 *    bersarang dan affectedRoutes).
 *  - String bounded; prototype/getter hostil ditolak.
 *
 * Skema:
 *   SpatialEvent {
 *     schemaVersion, id, type, location, radiusM, firstObservedAt,
 *     lastObservedAt, severity, confidence, epistemic, sources[],
 *     evidence[], affectedRoutes[], recommendedContext, lineage, createdAt
 *   }
 */

const { isValidPoint, isFiniteNumber } = require("../spatial/geo");
const { EPISTEMIC_STATUS, canonical: canonicalEpistemic, freshnessBand } = require("../spatial/epistemic");
const {
    CanonError, boundedString, deepCanonicalize, strictConfidence,
    strictTimestamp, CANON_LIMITS
} = require("../spatial/strictSchemas");

const SCHEMA_VERSION = 1;

const SEVERITY = Object.freeze({
    INFO: "info",
    WATCH: "watch",
    WARNING: "warning",
    CRITICAL: "critical"
});

const SEVERITY_ORDER = Object.freeze({ info: 0, watch: 1, warning: 2, critical: 3 });

const MAX_EVENT_TYPE_CHARS = 64;
const MAX_SOURCES = 64;
const MAX_EVIDENCE = 256;
const MAX_ROUTES = 128;
const MAX_RADIUS_M = 200_000; // 200 km — di luar ini bukan event lokal yang sah

let counter = 0;
function nextId(prefix = "evt") {
    counter = (counter + 1) % 0xffffff;
    return `${prefix}_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

function canonicalSeverity(value, fallback = SEVERITY.INFO) {
    return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, value) ? value : fallback;
}

function severityAtLeast(value, threshold) {
    return (SEVERITY_ORDER[canonicalSeverity(value)] ?? 0) >=
        (SEVERITY_ORDER[canonicalSeverity(threshold)] ?? 0);
}

/**
 * Buat SpatialEvent beku — KETAT.
 * Mengembalikan { ok:true, event } atau { ok:false, reason }.
 */
function createEvent(input = {}, { nowMs = Date.now(), futureSkewMs = CANON_LIMITS.FUTURE_SKEW_MS } = {}) {
    try {
        if (input === null || typeof input !== "object") {
            return { ok: false, reason: "input wajib objek" };
        }
        const location = input.location;
        if (!isValidPoint(location)) {
            return { ok: false, reason: "event.location wajib berupa titik valid {lat,lon}" };
        }

        // Timestamps KETAT.
        const firstObservedAt = strictTimestamp(input.firstObservedAt, "firstObservedAt", { nowMs, skewMs: futureSkewMs });
        const lastObservedAt = input.lastObservedAt === undefined
            ? firstObservedAt
            : strictTimestamp(input.lastObservedAt, "lastObservedAt", { nowMs, skewMs: futureSkewMs });
        if (lastObservedAt < firstObservedAt) {
            return { ok: false, reason: "lastObservedAt < firstObservedAt — kronologi tidak sah" };
        }

        // Confidence KETAT [0,1].
        const confidence = input.confidence === undefined
            ? 0.5 : strictConfidence(input.confidence, "confidence");

        // Radius bounded.
        let radiusM = 0;
        if (input.radiusM !== undefined) {
            if (!isFiniteNumber(input.radiusM) || input.radiusM < 0) {
                return { ok: false, reason: "radiusM wajib number finite >= 0" };
            }
            if (input.radiusM > MAX_RADIUS_M) {
                return { ok: false, reason: `radiusM > ${MAX_RADIUS_M} — di luar skala event lokal yang sah` };
            }
            radiusM = input.radiusM;
        }

        // Sources: string bounded, dedup, bounded count.
        const rawSources = Array.isArray(input.sources) ? input.sources : [];
        if (rawSources.length > MAX_SOURCES) {
            return { ok: false, reason: `sources > ${MAX_SOURCES}` };
        }
        const sources = [...new Set(rawSources.map(s => boundedString(s, 128)).filter(Boolean))];

        // Evidence: deep canonicalize (bounded, frozen) — mutasi input tidak
        // bisa menembus event.
        const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
        if (rawEvidence.length > MAX_EVIDENCE) {
            return { ok: false, reason: `evidence > ${MAX_EVIDENCE} entri` };
        }
        const evidence = deepCanonicalize(rawEvidence);

        // Routes: bounded strings.
        const rawRoutes = Array.isArray(input.affectedRoutes) ? input.affectedRoutes : [];
        if (rawRoutes.length > MAX_ROUTES) {
            return { ok: false, reason: `affectedRoutes > ${MAX_ROUTES}` };
        }
        const affectedRoutes = deepCanonicalize(
            rawRoutes.map(r => boundedString(r, 256)).filter(Boolean));

        const event = deepFreezeEvent({
            schemaVersion: SCHEMA_VERSION,
            id: boundedString(input.id, 128) ?? nextId(),
            type: boundedString(input.type, MAX_EVENT_TYPE_CHARS) ?? "generic",
            location: Object.freeze({ lat: location.lat, lon: location.lon }),
            radiusM,
            firstObservedAt,
            lastObservedAt,
            severity: canonicalSeverity(input.severity, SEVERITY.INFO),
            confidence,
            epistemic: canonicalEpistemic(input.epistemic, EPISTEMIC_STATUS.INFERRED),
            sources: Object.freeze(sources),
            evidence,
            affectedRoutes,
            // Lineage MD-006: keturunan sumber terstruktur (bounded).
            lineage: deepCanonicalize(input.lineage ?? null),
            recommendedContext: input.recommendedContext === undefined || input.recommendedContext === null
                ? null
                : deepCanonicalize(input.recommendedContext),
            createdAt: isFiniteNumber(input.createdAt)
                ? strictTimestamp(input.createdAt, "createdAt", { nowMs, skewMs: futureSkewMs })
                : nowMs
        });

        return { ok: true, event };
    }
    catch (error) {
        if (error instanceof CanonError) {
            return { ok: false, reason: error.message };
        }
        throw error;
    }
}

function deepFreezeEvent(record) {
    const stack = [record];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || typeof node !== "object" || Object.isFrozen(node)) continue;
        Object.freeze(node);
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (value !== null && typeof value === "object") stack.push(value);
        }
    }
    return Object.freeze(record);
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
