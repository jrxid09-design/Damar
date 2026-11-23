"use strict";

// Inert policy vocabulary/validation only. No requirement or evidence mint.
const PREFIX = "require-human-confirmation:";
function readConfirmationPolicy(restrictions) {
    const items = restrictions.kind === "set" ? restrictions.items : [];
    const candidates = items.filter(item => item.startsWith("require-human-confirmation"));
    if (!candidates.length) return null;
    if (candidates.length !== 1 || items.length !== 1) {
        throw new Error("confirmation cannot satisfy other grant restrictions");
    }
    const match = /^require-human-confirmation:([a-z0-9][a-z0-9._-]{0,63}):([1-9][0-9]{0,8})$/.exec(candidates[0]);
    if (!match) throw new Error("malformed human-confirmation policy restriction");
    return Object.freeze({ policyId: match[1], policyRevision: Number(match[2]) });
}
module.exports = Object.freeze({ readConfirmationPolicy });
