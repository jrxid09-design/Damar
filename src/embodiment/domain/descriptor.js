/**
 * Deskriptor perangkat (B§4) — normalisasi gagal-tutup.
 *
 * Skema FIELD BERSIH: field di luar whitelist ditolak dengan kode
 * EMB_UNKNOWN_DESCRIPTOR_FIELD. Ini adalah bukti struktural invariant
 * keamanan A dan D — deskriptor TIDAK MEMILIKI tempat untuk menyatakan
 * otoritas/izin ("authority", "grants", "allowed", ...). Penemuan
 * perangkat tidak akan pernah bisa membawa kuasa, sebab bentuk datanya
 * bahkan tidak bisa mengungkapkannya.
 */

const { deepFreeze, clamp01, fail } = require("../core/util");
const { validateDeviceId } = require("../core/identity");
const {
    DEVICE_CLASSES, DEVICE_STATES, HEALTH_STATES,
    IDENTITY_STABILITY, isValidCapability
} = require("../domain/types");

const DESCRIPTOR_FIELDS = Object.freeze(new Set([
    "deviceId", "deviceClass", "displayName",
    "manufacturer", "model", "identity",
    "capabilities", "health", "state", "metadata"
]));

const CLAIM_FIELDS = Object.freeze(new Set([
    "name", "confidence", "source", "claimedAt"
]));

function assertCapability(name) {
    if (!isValidCapability(name)) {
        throw fail("EMB_INVALID_CAPABILITY",
            `token kemampuan tidak sah: '${String(name).slice(0, 60)}'`);
    }
    return name;
}

/** Klaim kemampuan = FAKTA observasi + provenance + confidence. */
function normalizeCapabilityClaim(raw) {
    if (typeof raw === "string") raw = { name: raw };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw fail("EMB_INVALID_CAPABILITY", "klaim kemampuan bukan objek");
    }
    for (const key of Object.keys(raw)) {
        if (!CLAIM_FIELDS.has(key)) {
            throw fail("EMB_UNKNOWN_CLAIM_FIELD",
                `field klaim tak dikenal: '${key}'`);
        }
    }
    assertCapability(raw.name);
    return deepFreeze({
        name: raw.name,
        confidence: clamp01(raw.confidence ?? 0.5),
        source: String(raw.source ?? "unknown").slice(0, 120),
        claimedAt: String(raw.claimedAt ?? "").slice(0, 40) || null
    });
}

/**
 * Normalisasi deskriptor mentah dari adapter menjadi rekaman beku.
 * IDEM POTEN: menormalisasi hasil normalisasi menghasilkan byte yang
 * sama — syarat agar digest durable stabil lintas siklus restore.
 * (Stempel waktu kesehatan diisi penuh oleh jalur event, bukan di sini.)
 */
function normalizeDescriptor(raw) {

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw fail("EMB_INVALID_DESCRIPTOR", "deskriptor bukan objek");
    }

    for (const key of Object.keys(raw)) {
        if (!DESCRIPTOR_FIELDS.has(key)) {
            throw fail("EMB_UNKNOWN_DESCRIPTOR_FIELD",
                `field deskriptor tak dikenal: '${key}'`);
        }
    }

    if (!validateDeviceId(raw.deviceId)) {
        throw fail("EMB_INVALID_DEVICE_ID",
            `deviceId tidak sah: '${String(raw.deviceId).slice(0, 60)}'`);
    }
    const deviceClass = raw.deviceClass;
    if (!DEVICE_CLASSES[deviceClass]) {
        throw fail("EMB_UNKNOWN_DEVICE_CLASS",
            `kelas perangkat tidak terdaftar: '${deviceClass}'`);
    }

    const displayName = raw.displayName == null
        ? "(tanpa nama)"
        : String(raw.displayName).slice(0, 120);

    let identity = null;
    if (raw.identity != null) {
        if (typeof raw.identity !== "object" || Array.isArray(raw.identity)) {
            throw fail("EMB_INVALID_IDENTITY", "identity bukan objek");
        }
        const stability = raw.identity.stability;
        if (!IDENTITY_STABILITY[stability]) {
            throw fail("EMB_UNKNOWN_IDENTITY_STABILITY",
                `klaim kestabilan tidak dikenal: '${stability}'`);
        }
        identity = deepFreeze({
            namespace: String(raw.identity.namespace ?? "").slice(0, 40),
            stableKey: String(raw.identity.stableKey ?? "").slice(0, 260),
            stability
        });
    }

    const capabilities = (raw.capabilities ?? []).map(normalizeCapabilityClaim);

    // Bentuk kanonik PENUH sejak default — kunci idempotensi digest.
    let health = { status: HEALTH_STATES.unknown, detail: null, checkedAt: null };
    if (raw.health != null) {
        if (!HEALTH_STATES[raw.health.status]) {
            throw fail("EMB_UNKNOWN_HEALTH_STATE",
                `status kesehatan tidak dikenal: '${raw.health.status}'`);
        }
        health = {
            status: raw.health.status,
            detail: raw.health.detail != null
                ? String(raw.health.detail).slice(0, 200) : null,
            checkedAt: raw.health.checkedAt != null
                ? String(raw.health.checkedAt).slice(0, 40) : null
        };
    }

    const state = raw.state ?? DEVICE_STATES.ONLINE;
    if (!Object.values(DEVICE_STATES).includes(state)) {
        throw fail("EMB_UNKNOWN_DEVICE_STATE", `state tidak dikenal: '${state}'`);
    }

    let metadata = {};
    if (raw.metadata != null) {
        if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
            throw fail("EMB_INVALID_METADATA", "metadata bukan objek");
        }
        const keys = Object.keys(raw.metadata);
        if (keys.length > 32) {
            throw fail("EMB_METADATA_TOO_LARGE", "metadata > 32 field");
        }
        // Kunci prototipe berbahaya gagal-tutup — bukan hilang diam-diam.
        for (const key of keys) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") {
                throw fail("EMB_INVALID_METADATA",
                    `kunci metadata terlarang: '${key}'`);
            }
        }
        metadata = structuredMetadata(raw.metadata);
    }

    return deepFreeze({
        deviceId: raw.deviceId,
        deviceClass,
        displayName,
        manufacturer: raw.manufacturer != null
            ? String(raw.manufacturer).slice(0, 80) : null,
        model: raw.model != null ? String(raw.model).slice(0, 80) : null,
        identity,
        capabilities,
        health,
        state,
        metadata
    });
}

/** Metadata dibatasi nilai primitif agar kanonik & mudah didigest. */
function structuredMetadata(input) {
    const out = {};
    for (const key of Object.keys(input)) {
        const value = input[key];
        out[key] = (typeof value === "object" && value !== null)
            ? JSON.stringify(value).slice(0, 200)
            : value;
    }
    return out;
}

module.exports = {
    DESCRIPTOR_FIELDS, CLAIM_FIELDS,
    normalizeDescriptor, normalizeCapabilityClaim, assertCapability
};
