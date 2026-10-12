"use strict";

const { BOUNDS } = require("./bounds");

const STATES = Object.freeze({
    DISCOVERED:  "DISCOVERED",
    QUARANTINED: "QUARANTINED",
    INSPECTED:   "INSPECTED",
    VALIDATED:   "VALIDATED",
    ENABLED:     "ENABLED",
    REVOKED:     "REVOKED",
});

const VALID_TRANSITIONS = Object.freeze({
    DISCOVERED:  new Set(["QUARANTINED"]),
    QUARANTINED: new Set(["INSPECTED", "REVOKED"]),
    INSPECTED:   new Set(["VALIDATED", "REVOKED"]),
    VALIDATED:   new Set(["ENABLED", "REVOKED"]),
    ENABLED:     new Set(["REVOKED"]),
    REVOKED:     new Set(),
});

function assertTransitionAllowed(from, to) {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.has(to)) {
        throw new Error(`Illegal agent state transition: ${from} -> ${to}`);
    }
}

function validateAgentId(id) {
    if (typeof id !== "string" || id.length === 0 || Buffer.byteLength(id) > BOUNDS.MAX_AGENT_ID_BYTES) {
        throw new Error("Invalid agent ID");
    }
}

module.exports = { STATES, VALID_TRANSITIONS, assertTransitionAllowed, validateAgentId };
