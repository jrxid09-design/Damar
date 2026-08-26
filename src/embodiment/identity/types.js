/**
 * Device identity & pairing domain types (I§1) — closed enums, fail-closed.
 *
 * LAWS ENCODED HERE:
 *   paired != authorized        — no state in this module grants capability
 *   trust != permission         — trustState is relationship metadata only
 *   observed != granted         — observedCapabilities is observation only
 *   offline != revoked          — presence never mutates pairing/trust
 *   session != identity         — sessions reference a canonical deviceId
 */

const PAIRING_STATES = Object.freeze([
    "UNPAIRED", "CHALLENGE_ISSUED", "AWAITING_OWNER_CONFIRMATION",
    "PAIRED", "TRUSTED", "LIMITED", "REVOKED", "EXPIRED", "FAILED"
].reduce((m, s) => (m[s] = s, m), {}));

/** Deterministic transition table. Anything not listed is rejected. */
const PAIRING_TRANSITIONS = Object.freeze({
    UNPAIRED: ["CHALLENGE_ISSUED"],
    CHALLENGE_ISSUED: ["AWAITING_OWNER_CONFIRMATION", "EXPIRED", "FAILED"],
    AWAITING_OWNER_CONFIRMATION: ["PAIRED", "FAILED"],
    PAIRED: ["TRUSTED", "LIMITED", "REVOKED"],
    TRUSTED: ["LIMITED", "PAIRED", "REVOKED"],
    LIMITED: ["TRUSTED", "PAIRED", "REVOKED"],
    REVOKED: [],
    EXPIRED: [],
    FAILED: []
});

/**
 * Mirrored trust metadata (derived from pairing lifecycle; readable
 * without exposing the machine). NEVER consulted for authorization —
 * privileged actions require canonical Authority, not this field.
 */
const TRUST_STATES = Object.freeze([
    "UNKNOWN", "PAIRED", "TRUSTED", "LIMITED", "REVOKED"
].reduce((m, s) => (m[s] = s, m), {}));

const TRUST_BY_PAIRING_STATE = Object.freeze({
    UNPAIRED: "UNKNOWN",
    CHALLENGE_ISSUED: "UNKNOWN",
    AWAITING_OWNER_CONFIRMATION: "UNKNOWN",
    EXPIRED: "UNKNOWN",
    FAILED: "UNKNOWN",
    PAIRED: "PAIRED",
    TRUSTED: "TRUSTED",
    LIMITED: "LIMITED",
    REVOKED: "REVOKED"
});

const BODY_RELATIONS = Object.freeze([
    "PRIMARY", "COMPANION", "SENSOR", "DISPLAY",
    "ENVIRONMENTAL", "INFRASTRUCTURE", "UNKNOWN"
].reduce((m, r) => (m[r] = r, m), {}));

/**
 * Observation-only vocabulary. Presence of a name here describes what a
 * device ADVERTISES — it never means Aether may use it.
 */
const OBSERVED_CAPABILITIES = Object.freeze([
    "camera", "microphone", "location", "notifications",
    "display", "storage", "sensor", "input"
].reduce((m, c) => (m[c] = c, m), {}));

const SESSION_STATES = Object.freeze({
    ACTIVE: "ACTIVE",
    DISCONNECTED: "DISCONNECTED"
});

const PRESENCE_STATES = Object.freeze([
    "ONLINE", "OFFLINE", "STALE", "UNKNOWN"
].reduce((m, p) => (m[p] = p, m), {}));

const TX_FINAL_STATES = Object.freeze(new Set(["CONFIRMED", "EXPIRED", "FAILED"]));

function canTransition(from, to) {
    return (PAIRING_TRANSITIONS[from] ?? []).includes(to);
}

module.exports = {
    PAIRING_STATES, PAIRING_TRANSITIONS, TRUST_STATES,
    TRUST_BY_PAIRING_STATE, BODY_RELATIONS, OBSERVED_CAPABILITIES,
    SESSION_STATES, PRESENCE_STATES, TX_FINAL_STATES,
    canTransition
};
