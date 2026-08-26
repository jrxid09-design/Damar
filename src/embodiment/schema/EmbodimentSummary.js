/**
 * Jembatan model-diri (B§7) — proyeksi BACA-SAJA.
 *
 * getEmbodimentSummary() menerjemahkan BodySchema menjadi ringkasan
 * terstruktur yang kelak dibaca AetherSelf: "ini telingaku, ini mataku,
 * ini layarku". Proyeksi ini TIDAK memberi referensi ke state hidup
 * dan TIDAK menyediakan metode mutasi apa pun — model bahasa boleh
 * MELIHAT tubuhnya, tidak pernah MENYENTUHNYA.
 *
 * Catatan V0: modul ini sengaja TIDAK menulis ke AetherSelf/ACC.
 */

const { deepFreeze } = require("../core/util");
const { DEVICE_CLASSES, DEVICE_STATES, HEALTH_STATES } = require("../domain/types");

/**
 * @param {import("../schema/BodySchema").BodySchema} schema
 */
function getEmbodimentSummary(schema) {

    const devices = schema.listDevices();
    const online = devices.filter(d => d.descriptor.state === DEVICE_STATES.ONLINE);

    const byClass = (cls) => online.filter(d => d.descriptor.deviceClass === cls);

    // Pendengaran: semua AUDIO_INPUT online yang benar-benar menyatakan
    // audio.capture. Preferred = resolusi preferensi operator.
    const hearingInputs = byClass(DEVICE_CLASSES.AUDIO_INPUT)
        .filter(d => d.descriptor.capabilities.some(c => c.name === "audio.capture"));
    const preferredHearing =
        schema.resolvePreferred("audio.capture")[0]?.descriptor ?? null;

    // Penglihatan: kamera lokal vs jaringan dipisah lewat metadata
    // transport — klaim eksplisit adapter, bukan tebakan dari nama.
    const cameras = byClass(DEVICE_CLASSES.CAMERA);
    const isNetwork = (d) => d.descriptor.metadata?.transport === "network";

    const degraded = online
        .filter(d => d.descriptor.health.status === HEALTH_STATES.degraded)
        .map(d => d.descriptor.deviceId);
    const failed = online
        .filter(d => d.descriptor.health.status === HEALTH_STATES.failing)
        .map(d => d.descriptor.deviceId);

    return deepFreeze({
        hearing: {
            availableInputs: hearingInputs.length,
            preferredInput: preferredHearing ? {
                deviceId: preferredHearing.deviceId,
                displayName: preferredHearing.displayName
            } : null
        },
        vision: {
            localCameras: cameras.filter(d => !isNetwork(d)).length,
            networkCameras: cameras.filter(isNetwork).length
        },
        display: {
            monitors: byClass(DEVICE_CLASSES.DISPLAY).length
        },
        health: {
            degradedDevices: degraded.sort(),
            failedDevices: failed.sort()
        },
        totals: {
            ...schema.counts(),
            onlineDevices: online.length
        }
    });
}

module.exports = { getEmbodimentSummary };
