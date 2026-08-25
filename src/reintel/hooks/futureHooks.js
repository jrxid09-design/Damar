/**
 * RE Intelligence — hook masa depan (interface saja, TANPA implementasi
 * eksekusi/intersepsi di V0).
 *
 * 1. DynamicAnalysisRequest   — permintaan analisis dinamis untuk tahap
 *    LANJUT. Objek ini sengaja TIDAK membawa kemampuan eksekusi apa pun:
 *    hanya deskriptor beku. V0 tidak pernah mengeksekusi artifact.
 *
 * 2. ProtocolCaptureInput     — representasi input analisis protokol
 *    (USB/serial/network capture) untuk milestone berikutnya. V0 tidak
 *    melakukan intersepsi maupun probing aktif.
 *
 * 3. ReIntelInbox             — antrean masuk generik agar subsistem
 *    lain (Sensorium, Semantic Desktop) nanti bisa menyerahkan
 *    artifact/evidence tanpa RE Intel bergantung pada mereka.
 *    Arah dependensi: pihak luar → inbox. Bukan sebaliknya.
 *
 * Invarian otoritas: tidak ada hook di sini yang memberi izin operasi
 * material (flash firmware, kirim data, dsb). Itu domain Authority.
 */

"use strict";

const { freezeDeep } = require("../model/model");

const HOOK_EVENTS = Object.freeze({
    UNKNOWN_ARTIFACT_REQUIRES_ANALYSIS: "reintel.unknown_artifact_requires_analysis",
    UNKNOWN_DEVICE_REQUIRES_ANALYSIS: "reintel.unknown_device_requires_analysis"
});

const CAPTURE_KINDS = new Set(["usb", "serial", "network", "other"]);

/**
 * Buat permintaan analisis dinamis — PLACEHOLDER non-eksekusi.
 * Hasil selalu beku dan tidak memiliki method execute().
 */
function createDynamicAnalysisRequest({ artifactId, dimensions = [], reason = "" }) {
    if (!artifactId) {
        throw new Error("REI_INVALID_REQUEST: dynamic analysis request butuh artifactId");
    }
    return freezeDeep({
        type: "DYNAMIC_ANALYSIS_REQUEST",
        v0Status: "non-executing-placeholder",
        artifactId,
        dimensions: [...dimensions],
        reason,
        /** Eksplisit: tidak ada executor di objek ini. */
        executionAvailable: false
    });
}

/** Representasi input tangkapan protokol untuk milestone berikutnya. */
function createProtocolCaptureInput({ kind, sourceRef, recordedAtEpochMs = null }) {
    if (!CAPTURE_KINDS.has(kind)) {
        throw new Error(`REI_INVALID_CAPTURE: kind "${kind}" tidak dikenal`);
    }
    return freezeDeep({
        type: "PROTOCOL_CAPTURE_INPUT",
        kind,
        sourceRef,
        recordedAtEpochMs,
        interceptionImplementedInV0: false
    });
}

/**
 * Inbox generik: jembatan masuk untuk Sensorium / Semantic Desktop.
 * Validasi bentuk minimum; tidak mengimpor modul subsistem mana pun.
 */
function createReIntelInbox() {
    const queue = [];
    return freezeDeep({
        /**
         * Terima descriptor artifact dari subsistem luar.
         * Mengembalikan true bila bentuk valid dan masuk antrean.
         */
        offerArtifact(descriptor) {
            if (!descriptor || typeof descriptor.path !== "string" ||
                typeof descriptor.buffer !== "object" && descriptor.buffer !== undefined) {
                return false;
            }
            queue.push({ kind: "artifact", descriptor, offeredAtSeq: queue.length + 1 });
            return true;
        },
        /** Terima evidence perangkat dari Sensorium (bentuk bebas, divalidasi ringan). */
        offerDeviceEvidence(evidence) {
            if (!evidence || typeof evidence.sourceDeviceId !== "string") return false;
            queue.push({ kind: "device_evidence", evidence, offeredAtSeq: queue.length + 1 });
            return true;
        },
        drain() {
            const items = [...queue];
            queue.length = 0;
            return items;
        },
        get size() { return queue.length; }
    });
}

module.exports = { HOOK_EVENTS, createDynamicAnalysisRequest, createProtocolCaptureInput, createReIntelInbox };
