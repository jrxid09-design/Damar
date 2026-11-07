/**
 * Presence Runtime V0 — token aktivitas (P7).
 *
 * Aktivitas di dalam ACTIVE memakai handle internal autentik. Token
 * ber-brand: plain object palsu ditolak (FORGED_TOKEN). Token terikat
 * ke generasi — token dari generasi lama gagal (STALE_GENERATION).
 */

const TOKEN_BRAND = Symbol("damar.presence.activityToken");

let activityCounter = 0;

class ActivityToken {
    constructor({ mode, generation, startedAtMs, expiresAtMs }) {
        activityCounter += 1;
        this[TOKEN_BRAND] = true;
        this.id = `activity:${String(activityCounter).padStart(6, "0")}`;
        this.mode = mode;
        this.generation = generation;
        this.startedAtMs = startedAtMs;
        this.expiresAtMs = expiresAtMs;
        Object.freeze(this);
    }
}

function isGenuineActivityToken(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        value[TOKEN_BRAND] === true &&
        typeof value.id === "string"
    );
}

module.exports = { ActivityToken, isGenuineActivityToken };
