"use strict";

/**
 * RF PROVENANCE TRUST SEAL (MD-010).
 *
 * MASALAH: caller bisa menulis field JSON apa pun —
 *   lineage.upstreamDataset = "udp", sourceKind = "live", simulated = false.
 * STRING LINEAGE != LIVE TRUST. SHAPE != TRUST. SCHEMA != TRUST.
 *
 * DESAIN:
 *  - Trust ditandai oleh seal OPAQUE yang TIDAK bisa dibuat di luar mint
 *    kanonik. Seal disimpan di WeakMap module-private yang DIKUNCI pada
 *    identitas objek observasi:
 *      - JSON round-trip → objek BARU → tidak ada di WeakMap → tidak
 *        dipercaya (C4: clone kehilangan live trust);
 *      - objek spread/kloning in-process → identitas baru → tidak dipercaya;
 *      - observasi beku (deep-frozen) tetap bisa jadi key WeakMap.
 *  - Kemampuan mint HIDUP di closure module ini; hanya komposisi kanonik
 *    (RfManager produksi) yang terdaftar. Tidak diekspor dari paket publik.
 *  - Seal mengikat sensorId + captureSession + generation; verifier
 *    menuntut kecocokan binding (anti stamp-lintang antar sesi/sensor).
 *  - Replay TIDAK PERNAH bisa menerima seal live (sourceKind REPLAY
 *    ditolak keras di jalur seal).
 */

/** WeakMap: observasi → seal (module-private; TIDAK pernah diekspor). */
const sealStore = new WeakMap();
/** WeakSet komposisi yang boleh mint (module-private). */
const mintAuthority = new WeakSet();

let liveTrustGenerationCounter = 0;

/**
 * (INTERNAL) Daftarkan komposisi kanonik pemegang kemampuan mint.
 * HANYA instance RfManager produksi yang diterima — dicek malas lewat
 * instanceof (require malas menghindari siklus impor).
 */
function registerRfTrustComposition(compositionToken) {
    if (compositionToken === null || typeof compositionToken !== "object") {
        throw new TypeError("registerRfTrustComposition butuh instance komposisi kanonik");
    }
    const { RfManager } = require("./rfManager");
    if (!(compositionToken instanceof RfManager)) {
        throw new TypeError("registerRfTrustComposition menolak non-RfManager (fail closed)");
    }
    mintAuthority.add(compositionToken);
    return compositionToken;
}

/**
 * (INTERNAL) Kemampuan mint untuk komposisi TERDAFTAR. Mengembalikan null
 * untuk token yang tidak terdaftar — pemanggil wajib fail closed.
 */
function mintRfLiveTrustFor(compositionToken) {
    if (!mintAuthority.has(compositionToken)) {
        return null;
    }
    return function mintTrustedLiveRf({ sensorId, captureSession } = {}) {
        if (!sensorId || typeof sensorId !== "string" ||
            !captureSession || typeof captureSession !== "string") {
            throw new TypeError("mint live trust butuh sensorId + captureSession dari trusted composition");
        }
        liveTrustGenerationCounter = (liveTrustGenerationCounter + 1) % 0xffffffff;
        return Object.freeze({
            kind: "rf-live-trust",
            sensorId: String(sensorId).slice(0, 128),
            captureSession: String(captureSession).slice(0, 128),
            mintedAtMs: Date.now(),
            generation: liveTrustGenerationCounter
        });
    };
}

/**
 * (INTERNAL) Tempelkan seal live pada observasi kanonik (boleh beku —
 * WeakMap mengunci identitas, bukan properti). REPLAY TIDAK PERNAH seal.
 */
function sealObservationAsTrustedLive(observation, seal) {
    if (!observation || typeof observation !== "object") return false;
    if (!seal || seal.kind !== "rf-live-trust") return false;
    if (String(seal.sensorId ?? "") === "") return false;
    sealStore.set(observation, Object.freeze({ seal }));
    return true;
}

/**
 * VERIFIKATOR (aman diekspor): apakah observasi membawa LIVE trust valid?
 * JSON clone / objek baru → tidak ada di WeakMap → false. Binding
 * sensorId/captureSession (bila diminta) harus cocok dengan seal.
 */
function isTrustedLiveRfObservation(observation, { sensorId = null, captureSession = null } = {}) {
    if (!observation || typeof observation !== "object") return false;
    const entry = sealStore.get(observation);
    if (!entry || typeof entry !== "object") return false;
    const seal = entry.seal;
    if (!seal || seal.kind !== "rf-live-trust") return false;
    if (sensorId !== null && seal.sensorId !== String(sensorId).slice(0, 128)) return false;
    if (captureSession !== null && seal.captureSession !== String(captureSession).slice(0, 128)) return false;
    return true;
}

/**
 * Klasifikasi mode sumber dari observasi. REPLAY/SIMULASI TIDAK PERNAH
 * dipercaya live walau field apa pun diklaim caller.
 */
function rfSourceModeOf(observation) {
    const lineageMode = String(observation?.lineage?.upstreamDataset ?? "").toLowerCase();
    const attrMode = String(observation?.attributes?.sourceKind ?? "").toLowerCase();
    const declared = observation?.attributes?.sourceMode ?? null;
    if (lineageMode === "replay" || attrMode === "replay" || declared === "REPLAY" || declared === "SIMULATED") {
        return "REPLAY";
    }
    if (lineageMode === "udp" || attrMode === "udp" || declared === "LIVE") {
        return "LIVE";
    }
    return "UNKNOWN";
}

/**
 * Kanal ingest INTERNAL (C2): dibuat LEKSIKAL oleh komposisi service
 * kanonik untuk rfManager miliknya. Objek channel TIDAK diekspor dari
 * paket publik dan tidak dapat dibuat untuk service lain — factory
 * menuntut instance service kanonik itu sendiri (duck-typed internal).
 *
 * Observasi yang masuk lewat kanal ini HARUS sudah berupa observasi
 * kanonik hasil rfManager (normalizeObservation ketat) — kanal meneruskan
 * ke pipeline internal TANPA jalur pintas validasi.
 */
function createRfIngestChannel(service) {
    if (!service || typeof service !== "object" ||
        typeof service._ingestTrustedObservations !== "function") {
        throw new TypeError("createRfIngestChannel butuh canonical MataDewaService instance");
    }
    return Object.freeze({
        kind: "rf-trusted-ingest",
        /** @returns {number} jumlah observasi diterima */
        ingest(observations) {
            return service._ingestTrustedObservations(observations);
        }
    });
}

module.exports = Object.freeze({
    registerRfTrustComposition,
    mintRfLiveTrustFor,
    sealObservationAsTrustedLive,
    isTrustedLiveRfObservation,
    rfSourceModeOf,
    createRfIngestChannel
});
