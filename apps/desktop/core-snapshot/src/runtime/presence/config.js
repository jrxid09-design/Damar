/**
 * Presence Runtime V0 — konfigurasi terpusat. Semua struktur presence
 * berbatas (bounded): tidak ada Map/Set/Array tanpa batas.
 */

const DEFAULT_PRESENCE_CONFIG = Object.freeze({
    maxActivities: 16,
    maxActivityTombstones: 64,
    maxOwnerWaits: 8,
    maxDegradedReasons: 8,
    maxHistory: 256,
    maxDiagnostics: 64,
    maxSubscribers: 32,
    maxDedupeLedger: 1024,
    activityTtlMs: 30 * 60 * 1000,
    ownerWaitTtlMs: 24 * 60 * 60 * 1000
});

function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}

/** Validasi config: gagal tertutup dengan TypeError bila tidak sah. */
function validatePresenceConfig(config) {
    const errors = [];
    for (const [key, value] of Object.entries(config)) {
        if (!(key in DEFAULT_PRESENCE_CONFIG)) {
            errors.push(`kunci tak dikenal: ${key}`);
        }
        else if (!isPositiveInt(value)) {
            errors.push(`${key} harus integer positif, dapat: ${String(value)}`);
        }
    }
    if (errors.length > 0) {
        throw new TypeError(`PRESENCE_CONFIG_INVALID: ${errors.join("; ")}`);
    }
    return Object.freeze({ ...DEFAULT_PRESENCE_CONFIG, ...config });
}

module.exports = { DEFAULT_PRESENCE_CONFIG, validatePresenceConfig };
