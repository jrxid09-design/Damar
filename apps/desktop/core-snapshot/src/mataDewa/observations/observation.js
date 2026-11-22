/**
 * SpatialObservation — unit data spasial ternormalisasi (MD-005 ketat).
 *
 * Setiap provider memetakan respons mentahnya ke bentuk kanonik ini sehingga
 * UI, fusion, watch, dan Manager tidak berurusan dengan semantik per-provider.
 *
 * HUKUM MD-005:
 *  - REJECT bukan clamp: confidence/quality di luar [0,1] DITOLAK; NaN/
 *    Infinity DITOLAK; epoch negatif DITOLAK; timestamp masa depan di luar
 *    toleransi clock-skew DITOLAK (skew ditandai jujur bila diminta).
 *  - Deep canonicalization: setelah konstruksi, mutasi objek input pemanggil
 *    TIDAK mengubah rekaman kanonik (deep copy + deep freeze, termasuk
 *    attributes/geometry/evidence bersarang).
 *  - Prototype/getter hostil DITOLAK tanpa eksekusi getter.
 *  - String dibatasi; metadata dibatasi; geometry hanya bentuk terdukung
 *    (point / linestring / polygon) dengan jumlah koordinat bounded.
 *
 * Skema:
 *   SpatialObservation {
 *     schemaVersion, id, source, type, geometry, observedAt, receivedAt,
 *     epistemic, confidence, quality, accessClass, attributes,
 *     mediaReference, attribution, license, lineage
 *   }
 */

const { isValidPoint, isFiniteNumber } = require("../spatial/geo");
const { ACCESS_CLASS, canonical: canonicalAccess } = require("../spatial/accessClass");
const { EPISTEMIC_STATUS, canonical: canonicalEpistemic, freshnessBand } = require("../spatial/epistemic");
const {
    CanonError, boundedString, deepCanonicalize, strictConfidence,
    strictTimestamp, CANON_LIMITS
} = require("../spatial/strictSchemas");

const SCHEMA_VERSION = 1;

/** Kunci prototype-hostil + accessor: REJECT di pintu masuk (MD-005). */
const HOSTILE_INPUT_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

/**
 * Pemeriksaan pintu masuk: objek input TIDAK boleh membawa kunci
 * prototype-hostil atau property accessor (getter/setter) — REJECT tanpa
 * mengeksekusi getter apa pun (MD-012: tidak ada bypass level atas;
 * deepCanonicalize hanya mencakup field bersarang).
 */
function assertSafeInputObject(input) {
    for (const key of Object.getOwnPropertyNames(input)) {
        if (HOSTILE_INPUT_KEYS.has(key)) {
            throw new CanonError(`kunci prototype-hostil '${key}' ditolak`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor && (descriptor.get !== undefined || descriptor.set !== undefined)) {
            throw new CanonError(`accessor property '${key}' ditolak (getter tidak pernah dieksekusi)`);
        }
    }
}

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
    RF_CSI_CHANNEL_STATE: "rf.csi.channel_state",
    RF_CHANNEL_CHANGE: "rf.channel_change",
    RF_MOTION_ESTIMATE: "rf.motion_estimate",
    RF_PRESENCE_ESTIMATE: "rf.presence_estimate",
    RF_ZONE_OCCUPANCY_ESTIMATE: "rf.zone_occupancy_estimate",
    GENERIC: "generic"
});

const MAX_SOURCE_CHARS = 128;
const MAX_TYPE_CHARS = 64;
const MAX_GEOMETRY_COORDINATES = 20000;

let counter = 0;
function nextId(prefix = "obs") {
    counter = (counter + 1) % 0xffffff;
    return `${prefix}_${Date.now().toString(36)}_${counter.toString(36).padStart(4, "0")}`;
}

/** Geometry kanonik terdukung: point | linestring | polygon. */
function canonicalGeometry(input) {
    if (input === null || input === undefined) return null;
    if (typeof input !== "object") {
        throw new CanonError("geometry tidak sah (bukan objek)");
    }
    const type = input.type;
    if (type === "point") {
        if (!isValidPoint(input)) {
            throw new CanonError("koordinat point tidak valid (lat/lon di luar rentang)");
        }
        return { type: "point", lat: input.lat, lon: input.lon };
    }
    if (type === "linestring" || type === "polygon") {
        const coords = input.coordinates;
        if (!Array.isArray(coords) || coords.length === 0) {
            throw new CanonError(`${type} butuh coordinates array non-kosong`);
        }
        if (coords.length > MAX_GEOMETRY_COORDINATES) {
            throw new CanonError(`jumlah koordinat > ${MAX_GEOMETRY_COORDINATES}`);
        }
        for (const c of coords) {
            if (!Array.isArray(c) || c.length < 2 ||
                !isFiniteNumber(c[0]) || !isFiniteNumber(c[1]) ||
                c[1] < -90 || c[1] > 90 || c[0] < -180 || c[0] > 180) {
                throw new CanonError(`koordinat ${type} tidak valid`);
            }
        }
        if (type === "polygon" && coords.length >= 3) {
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                throw new CanonError("ring poligon tidak tertutup");
            }
        }
        return Object.freeze({
            type,
            coordinates: Object.freeze(coords.map(c => Object.freeze([c[0], c[1]])))
        });
    }
    throw new CanonError(`tipe geometry tidak didukung: ${String(type)}`);
}

/**
 * Normalisasi input mentah menjadi SpatialObservation beku — KETAT.
 * Mengembalikan { ok:true, observation } atau { ok:false, reason }.
 */
function normalizeObservation(input = {}, { nowMs = Date.now(), futureSkewMs = CANON_LIMITS.FUTURE_SKEW_MS } = {}) {
    try {
        if (input === null || typeof input !== "object") {
            return { ok: false, reason: "input wajib objek" };
        }
        // Pintu masuk ketat: kunci hostil + accessor DITOLAK sebelum baca
        // (MD-012: level atas TIDAK bypass; getter tidak pernah dieksekusi).
        assertSafeInputObject(input);

        // Geometry: dari field geometry atau location; WAJIB.
        let geometry;
        if (input.geometry !== undefined && input.geometry !== null) {
            geometry = canonicalGeometry(input.geometry);
        }
        else if (isValidPoint(input.location)) {
            geometry = { type: "point", lat: input.location.lat, lon: input.location.lon };
        }
        else {
            return { ok: false, reason: "geometry wajib ada (point {lat,lon} atau bentuk lain)" };
        }

        // Timestamps KETAT (epoch ms, non-negatif, skew masa depan dibatasi).
        const observedAt = strictTimestamp(input.observedAt, "observedAt", { nowMs, skewMs: futureSkewMs });
        const receivedAt = input.receivedAt === undefined
            ? nowMs
            : strictTimestamp(input.receivedAt, "receivedAt", { nowMs, skewMs: futureSkewMs });

        // Confidence/quality KETAT [0,1] — reject bukan clamp.
        const confidence = input.confidence === undefined
            ? 0.5 : strictConfidence(input.confidence, "confidence");
        const quality = input.quality === undefined
            ? 0.5 : strictConfidence(input.quality, "quality");

        const source = boundedString(input.source, MAX_SOURCE_CHARS) ?? "unknown";
        const type = boundedString(input.type, MAX_TYPE_CHARS) ?? OBSERVATION_TYPE.GENERIC;

        // Attributes: deep canonicalize (bounded, prototype-safe, frozen).
        const attributes = deepCanonicalize(input.attributes ?? {});

        const id = boundedString(input.id, 128) ?? nextId();

        const observation = deepFreezeObservation({
            schemaVersion: SCHEMA_VERSION,
            id,
            source,
            type,
            geometry: geometry.type === "point"
                ? Object.freeze({ type: "point", lat: geometry.lat, lon: geometry.lon })
                : geometry,
            observedAt,
            receivedAt,
            epistemic: canonicalEpistemic(input.epistemic, EPISTEMIC_STATUS.OBSERVED),
            confidence,
            quality,
            accessClass: canonicalAccess(input.accessClass, ACCESS_CLASS.PUBLIC),
            attributes,
            // Lineage MD-006: identitas keturunan sumber (bounded).
            lineage: deepCanonicalize(input.lineage ?? null),
            mediaReference: input.mediaReference === undefined || input.mediaReference === null
                ? null
                : boundedString(input.mediaReference, 512) ?? null,
            attribution: input.attribution === undefined || input.attribution === null
                ? null
                : boundedString(input.attribution, 512) ?? null,
            license: input.license === undefined || input.license === null
                ? null
                : boundedString(input.license, 256) ?? null
        });

        return { ok: true, observation };
    }
    catch (error) {
        if (error instanceof CanonError) {
            return { ok: false, reason: error.message };
        }
        throw error;
    }
}

function deepFreezeObservation(record) {
    // Struktur dalam sudah canonical-frozen oleh helper; pastikan seluruh
    // grafik beku (idempoten terhadap Object.freeze).
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
    describeFreshness,
    canonicalGeometry
});
