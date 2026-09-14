"use strict";

const { REASONS, fail } = require("./errors");

/**
 * capabilityRegistry adalah dependensi HARD (spec §W7_CONTRACTS L1
 * UPSTREAM). Port lain (presence/mesh/health/governor/provider) SOFT —
 * absen berarti UNKNOWN/STALE, bukan galat.
 */
function requireCapabilityRegistryPort(port) {
    // Bug review independen (audit putaran-52, W7R52-P2-2): `port.get`/
    // `.has`/`.getAvailability` adalah [[Get]] mentah -- Proxy yang
    // di-revoke melempar TypeError mentah persis pada guard yang wujudnya
    // MEMANG untuk menolak dependency tidak sah, bukan crash keluar
    // dari API publik. Dibungkus try/catch; kegagalan APA PUN
    // diperlakukan sama seperti port tidak punya method yang dibutuhkan.
    let isValid;
    try {
        isValid = !!port && typeof port === "object" &&
            typeof port.get === "function" &&
            typeof port.has === "function" &&
            typeof port.getAvailability === "function";
    } catch {
        isValid = false;
    }
    if (!isValid) {
        fail(REASONS.INVALID_PORT,
            "capabilityRegistry port wajib punya get()/has()/getAvailability()");
    }
    return port;
}

/** Panggil port SOFT dengan aman: kegagalan apa pun -> null, tidak pernah throw. */
function safeCall(fn) {
    if (typeof fn !== "function") return null;
    try {
        return fn();
    } catch {
        return null;
    }
}

module.exports = { requireCapabilityRegistryPort, safeCall };
