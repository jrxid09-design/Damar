"use strict";

/**
 * Source lineage — identitas keturunan sumber observasi (MD-006).
 *
 * MASALAH: dua string sumber berbeda (mis. "usgs-mirror-a", "usgs-mirror-b")
 * TIDAK berarti dua provider independen — mereka bisa mencerminkan dataset
 * hulu yang sama. Memberi bonus confidence untuk cermin ganda = menggandakan
 * kepercayaan tanpa bukti.
 *
 * MODEL:
 *   lineage {
 *     providerId        — identitas provider Mata Dewa (mis. "usgs-earthquakes")
 *     providerFamily    — keluarga teknologi/organisasi (mis. "usgs",
 *                         "openstreetmap", "noaa") — cermin biasanya satu family
 *     upstreamDataset   — dataset hulu (mis. "anss-comcat", "overpass-api")
 *     independenceGroup — grup kemandirian: hanya grup BERBEDA dianggap
 *                         independen; fallback: providerId
 *     sensorId          — identitas sensor fisik bila ada (RF, kamera)
 *     captureSession    — sesi perekaman (CSI capture, dll)
 *     kind              — "provider" | "sensor" | "derived"
 *   }
 *
 * HUKUM:
 *  - Dua observasi dianggap independen HANYA bila independenceGroup-nya
 *    berbeda (fallback: providerId berbeda).
 *  - Lineage tidak pernah menimpa accessClass atau epistemic status.
 *  - Bounded (string dibatasi, struktur dibekukan).
 */

const {
    CanonError, boundedString, deepCanonicalize
} = require("../spatial/strictSchemas");

const LINEAGE_KIND = Object.freeze({
    PROVIDER: "provider",
    SENSOR: "sensor",
    DERIVED: "derived"
});

const MAX_FIELD = 128;

/**
 * Bangun lineage kanonik dari input parsial.
 * @returns {{ ok:true, lineage:object } | { ok:false, reason:string }}
 */
function createLineage(input = {}) {
    try {
        if (input === null || typeof input !== "object" || Array.isArray(input)) {
            return { ok: false, reason: "lineage wajib objek" };
        }
        const kind = Object.values(LINEAGE_KIND).includes(input.kind)
            ? input.kind : LINEAGE_KIND.PROVIDER;
        const providerId = boundedString(input.providerId, MAX_FIELD) ?? "unknown";
        const lineage = deepCanonicalize({
            kind,
            providerId,
            providerFamily: boundedString(input.providerFamily, MAX_FIELD) ?? providerId,
            upstreamDataset: boundedString(input.upstreamDataset, MAX_FIELD) ?? null,
            // Grup kemandirian: EKSPLISIT bila ada; fallback providerId —
            // dua string sumber berbeda TIDAK otomatis independen tanpa
            // deklarasi ini.
            independenceGroup: boundedString(input.independenceGroup, MAX_FIELD) ?? providerId,
            sensorId: boundedString(input.sensorId, MAX_FIELD) ?? null,
            captureSession: boundedString(input.captureSession, MAX_FIELD) ?? null
        });
        return { ok: true, lineage };
    }
    catch (error) {
        if (error instanceof CanonError) return { ok: false, reason: error.message };
        throw error;
    }
}

/**
 * Grup kemandirian sebuah observasi: lineage.independenceGroup bila ada,
 * fallback providerId, fallback source string.
 */
function independenceGroupOf(observation) {
    const lineage = observation?.lineage;
    if (lineage && typeof lineage === "object") {
        if (typeof lineage.independenceGroup === "string" && lineage.independenceGroup) {
            return lineage.independenceGroup;
        }
        if (typeof lineage.providerId === "string" && lineage.providerId) {
            return lineage.providerId;
        }
    }
    return String(observation?.source ?? "unknown");
}

/**
 * Berapa banyak grup kemandirian BERBEDA dalam sekumpulan observasi.
 * Cermin upstream yang sama (grup sama) dihitung SATU.
 */
function independentGroupCount(observations) {
    const groups = new Set();
    for (const obs of observations ?? []) groups.add(independenceGroupOf(obs));
    return groups.size;
}

/**
 * Apakah dua observasi independen (grup kemandirian berbeda)?
 */
function areIndependent(a, b) {
    return independenceGroupOf(a) !== independenceGroupOf(b);
}

module.exports = Object.freeze({
    LINEAGE_KIND,
    createLineage,
    independenceGroupOf,
    independentGroupCount,
    areIndependent
});
