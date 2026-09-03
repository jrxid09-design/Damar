/**
 * SpatialObservation — unit data spasial ternormalisasi.
 *
 * Setiap provider memetakan respons mentahnya ke bentuk kanonik ini sehingga
 * UI, fusion, watch, dan Manager tidak berurusan dengan semantik per-provider.
 *
 * Skema (konsep):
 *   SpatialObservation {
 *     id, source, type, geometry, observedAt, receivedAt, freshness,
 *     confidence, attributes, mediaReference, attribution, quality, accessClass
 *   }
 */

const { isValidPoint, isFiniteNumber } = require("../spatial/geo");
const { ACCESS_CLASS, canonical: canonicalAccess } = require("../spatial/accessClass");
const { EPISTEMIC_STATUS, canonical: canonicalEpistemic, freshnessBand } = require("../spatial/epistemic");

const SCHEMA_VERSION = 1;

/** Jenis observasi yang dikenal (bebas diperluas provider). */
const OBSERVATION_TYPE = Object.freeze({
    EARTHQUAKE: "earthquake",
    SATELLITE: "satellite",
    FLIGHT: "flight",
    VESSEL: "vessel",
    WEATHER: "weather",
    LIGHTNING: "lightning",
    FIRE: "fire",
    FLOOD: "flood",
    CCTV_FRAME: "cctv_frame",
    TRAFFIC: "traffic",
    ASSET: "asset",
    GENERIC: "generic"
});

let counter = 0;
function nextId(prefix = "obs") {
    counter = (counter + 1) % 0xffffff;
    return `${prefix}_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

function clamp01(value, fallback = 0.5) {
    if (!isFiniteNumber(value)) return fallback;
    return Math.min(1, Math.max(0, value));
}

/**
 * Normalisasi input mentah menjadi SpatialObservation beku.
 * Mengembalikan { ok:true, observation } atau { ok:false, reason }.
 */
function normalizeObservation(input = {}, { nowMs = Date.now() } = {}) {
    const geometry = input.geometry ??
        (isValidPoint(input.location) ? { type: "point", lat: input.location.lat, lon: input.location.lon } : null);

    if (!geometry) {
        return { ok: false, reason: "geometry wajib ada (point {lat,lon} atau bentuk lain)" };
    }
    if (geometry.type === "point" && !isValidPoint(geometry)) {
        return { ok: false, reason: "koordinat point tidak valid (lat/lon di luar rentang)" };
    }

    const observedAt = isFiniteNumber(input.observedAt) ? input.observedAt : null;
    if (observedAt === null) {
        return { ok: false, reason: "observedAt wajib (epoch ms) — observasi tanpa waktu tidak dapat dinilai kesegarannya" };
    }
    const receivedAt = isFiniteNumber(input.receivedAt) ? input.receivedAt : nowMs;

    const source = typeof input.source === "string" && input.source.trim()
        ? input.source.trim() : "unknown";

    const observation = Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        id: typeof input.id === "string" && input.id ? input.id : nextId(),
        source,
        type: typeof input.type === "string" && input.type ? input.type : OBSERVATION_TYPE.GENERIC,
        geometry: Object.freeze({ ...geometry }),
        observedAt,
        receivedAt,
        epistemic: canonicalEpistemic(input.epistemic, EPISTEMIC_STATUS.OBSERVED),
        confidence: clamp01(input.confidence, 0.5),
        quality: clamp01(input.quality, 0.5),
        accessClass: canonicalAccess(input.accessClass, ACCESS_CLASS.PUBLIC),
        attributes: Object.freeze({ ...(input.attributes ?? {}) }),
        mediaReference: input.mediaReference ?? null,
        attribution: input.attribution ?? null,
        license: input.license ?? null
    });

    return { ok: true, observation };
}

/** Ringkasan freshness untuk tampilan/alert (tidak mengubah observasi). */
function describeFreshness(observation, opts, nowMs = Date.now()) {
    return {
        band: freshnessBand(observation?.observedAt, opts, nowMs),
        ageMs: Number.isFinite(observation?.observedAt)
            ? Math.max(0, nowMs - observation.observedAt) : Infinity
    };
}

module.exports = Object.freeze({
    SCHEMA_VERSION,
    OBSERVATION_TYPE,
    normalizeObservation,
    describeFreshness
});
