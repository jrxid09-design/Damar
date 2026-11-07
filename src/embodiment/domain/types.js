/**
 * Tipe domain tubuh komputasi (B§2) — enum tertutup, gagal-tutup.
 *
 * Prinsip inti milestone ini:
 *
 *   PERANGKAT != KEMAMPUAN != OTORITAS
 *
 * Enum di sini hanya mendeskripsikan APA YANG DIAMATI. Tidak ada satu
 * pun tipe yang bisa menyatakan "boleh dipakai" — itu ranah Authority
 * yang dibangun terpisah.
 */

const DEVICE_CLASSES = Object.freeze([
    "HOST", "CPU", "MEMORY", "STORAGE", "NETWORK_INTERFACE",
    "AUDIO_INPUT", "AUDIO_OUTPUT", "CAMERA", "DISPLAY",
    "KEYBOARD", "POINTER", "HID", "USB", "SERIAL", "BLUETOOTH",
    "NETWORK_DEVICE", "SMART_HOME_DEVICE", "UNKNOWN"
].reduce((m, c) => (m[c] = c, m), {}));

const DEVICE_STATES = Object.freeze({
    ONLINE: "online",
    OFFLINE: "offline",
    REMOVED: "removed"
});

const HEALTH_STATES = Object.freeze([
    "healthy", "degraded", "failing", "unknown"
].reduce((m, h) => (m[h] = h, m), {}));

/**
 * Klaim kestabilan identitas. Adapter WAJB jujur: jangan pernah
 * mengklaim "stable" bila sumbernya (mis. nama perangkat Bluetooth)
 * tidak menjamin kestabilan.
 */
const IDENTITY_STABILITY = Object.freeze([
    "stable", "session", "ephemeral"
].reduce((m, s) => (m[s] = s, m), {}));

const RELATIONSHIP_TYPES = Object.freeze([
    "attached_to", "connected_via", "provides", "depends_on",
    "default_for", "preferred_for", "fallback_for",
    "located_on", "network_peer", "logical_child"
].reduce((m, r) => (m[r] = r, m), {}));

/** Relasi preferensi — target-nya token kemampuan (tujuan/fungsi). */
const PREFERENCE_TYPES = Object.freeze(new Set([
    "default_for", "preferred_for", "fallback_for"
]));

/* ------------------------- klasifikasi kanal --------------------------- */

/*
 * Kemampuan dipetakan deterministik ke arah sensor/aktuator berdasar
 * VERBA terakhir pada token. Kemampuan tak-dikenal yang bentuknya sah
 * tetap disimpan di perangkat, tapi tidak muncul sebagai kanal sampai
 * ada pemetaan — tidak ada klasifikasi diam-diam.
 */

const SENSOR_VERBS = Object.freeze(new Set([
    "capture", "observe", "snapshot", "read", "ir"
]));

const ACTUATOR_VERBS = Object.freeze(new Set([
    "playback", "render", "write", "ptz"
]));

const MODALITY_BY_DOMAIN = Object.freeze({
    audio: "audio",
    vision: "vision",
    camera: "vision",
    display: "display",
    input: "hid",
    storage: "storage",
    network: "network",
    device: "telemetry"
});

function isValidCapability(name) {
    return typeof name === "string"
        && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/.test(name);
}

/** {direction, modality} atau null bila verba tidak dikenal. */
function classifyCapability(name) {
    if (!isValidCapability(name)) return null;
    const segments = name.split(".");
    const verb = segments[segments.length - 1];
    const modality = MODALITY_BY_DOMAIN[segments[0]] ?? "generic";
    if (SENSOR_VERBS.has(verb)) {
        return Object.freeze({ direction: "sensor", modality });
    }
    if (ACTUATOR_VERBS.has(verb)) {
        return Object.freeze({ direction: "actuator", modality });
    }
    return null;
}

module.exports = {
    DEVICE_CLASSES, DEVICE_STATES, HEALTH_STATES,
    IDENTITY_STABILITY, RELATIONSHIP_TYPES, PREFERENCE_TYPES,
    SENSOR_VERBS, ACTUATOR_VERBS, MODALITY_BY_DOMAIN,
    isValidCapability, classifyCapability
};
