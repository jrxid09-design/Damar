"use strict";

/**
 * CAPABILITY REGISTRY V1 — availability state model.
 *
 * Availability is EXPLICITLY separate from authorization. These states
 * describe whether a capability is currently observable in the runtime —
 * never whether its use is permitted.
 *
 *   UNKNOWN     — no observation yet (the default for a fresh descriptor)
 *   AVAILABLE   — currently observable (provider loaded, extension healthy,
 *                 device present, runtime dependency present, ...)
 *   UNAVAILABLE — currently not observable (offline/revoked device, disabled
 *                 extension, missing runtime dependency, ...)
 *   DEGRADED    — observable but impaired (resource pressure, partial health)
 *
 * Deliberately ABSENT from the vocabulary: AUTHORIZED, APPROVED, TRUSTED.
 * Availability is evidence only; it grants nothing.
 *
 * Availability observations are GENERATION-AWARE: each update carries a
 * generation counter, and a stale (older-generation) observation is rejected
 * so it can never overwrite a newer observation.
 */

const { fail, REASONS } = require("./errors");

const AVAILABILITY = Object.freeze({
    UNKNOWN: "UNKNOWN",
    AVAILABLE: "AVAILABLE",
    UNAVAILABLE: "UNAVAILABLE",
    DEGRADED: "DEGRADED"
});

const AVAILABILITY_SET = Object.freeze(new Set(Object.values(AVAILABILITY)));

function canonicalAvailability(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.INVALID_AVAILABILITY,
            `availability must be string, got ${typeof raw}`);
    }
    const value = raw.trim().toUpperCase();
    if (!AVAILABILITY_SET.has(value)) {
        throw fail(REASONS.INVALID_AVAILABILITY,
            `unknown availability state '${String(raw).slice(0, 80)}'`,
            { received: String(raw).slice(0, 80), allowed: [...AVAILABILITY_SET] });
    }
    return value;
}

module.exports = { AVAILABILITY, AVAILABILITY_SET, canonicalAvailability };
