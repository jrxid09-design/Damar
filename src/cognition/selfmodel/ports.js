"use strict";

const { REASONS, fail } = require("./errors");

/**
 * capabilityRegistry adalah dependensi HARD (spec §W7_CONTRACTS L1
 * UPSTREAM). Port lain (presence/mesh/health/governor/provider) SOFT —
 * absen berarti UNKNOWN/STALE, bukan galat.
 */
function requireCapabilityRegistryPort(port) {
    if (!port || typeof port !== "object" ||
        typeof port.get !== "function" ||
        typeof port.has !== "function" ||
        typeof port.getAvailability !== "function") {
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
