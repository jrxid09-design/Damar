"use strict";

// Surface-safe projection primitives shared by the canonical DP domains.
//
// PRIVACY (DP §55, R2-4): ONE sensitivity vocabulary for every canonical free-text
// field. Notification already ratchets NORMAL < SENSITIVE < SECRET; approval
// purpose uses the same levels. A missing or unknown classification counts as
// SECRET, never as unrestricted.
//
// DETACHMENT (DP §27, R2-2): every surface read returns a deep copy. A caller can
// never reach canonical state through a returned object, whatever its depth.

const SENSITIVITY = Object.freeze(["NORMAL", "SENSITIVE", "SECRET"]);
const SENSITIVITY_RANK = Object.freeze({ NORMAL: 0, SENSITIVE: 1, SECRET: 2 });
const REDACTED = "[REDACTED]";

function sensitivityOf(value) {
    return Object.prototype.hasOwnProperty.call(SENSITIVITY_RANK, value) ? value : "SECRET";
}

// Monotonic ratchet: the stronger classification always wins (F1).
function maxSensitivity(a, b) {
    return SENSITIVITY_RANK[sensitivityOf(b)] > SENSITIVITY_RANK[sensitivityOf(a)] ? sensitivityOf(b) : sensitivityOf(a);
}

function detach(value) {
    if (value === null || value === undefined) return null;
    return structuredClone(value);
}

// Surface value of one free-text field: the text only when NORMAL (or revealed by
// an explicit caller reveal), otherwise the redaction token.
function surfaceText(value, sensitivity, { reveal = false } = {}) {
    if (value === null || value === undefined) return null;
    return reveal || sensitivityOf(sensitivity) === "NORMAL" ? detach(value) : REDACTED;
}

module.exports = { SENSITIVITY, SENSITIVITY_RANK, REDACTED, sensitivityOf, maxSensitivity, detach, surfaceText };
