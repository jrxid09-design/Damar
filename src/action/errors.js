"use strict";

/**
 * ACTION INTENT + AUTHORITY GATE V1 — error contract.
 *
 * Every rejection carries a stable `reasonCode` so callers branch on
 * machine-readable causes without parsing messages. All failures are
 * fail-closed: malformed input is rejected, never silently repaired.
 *
 * This domain is EVALUATIVE + DESCRIPTIVE ONLY. Its error vocabulary never
 * encodes an Authority decision as truth (ALLOW/DENY come from the decision
 * model, not from errors); errors describe shape/identity/state problems.
 */

class ActionError extends Error {
    constructor(reasonCode, message, details = null) {
        super(message);
        this.name = "ActionError";
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

const REASONS = Object.freeze({
    // intent input validation
    MALFORMED_INPUT: "MALFORMED_INPUT",
    MALFORMED_JSON: "MALFORMED_JSON",
    UNKNOWN_FIELD: "UNKNOWN_FIELD",
    DANGEROUS_KEY: "DANGEROUS_KEY",
    UNSUPPORTED_SCHEMA: "UNSUPPORTED_SCHEMA",
    NON_PLAIN_OBJECT: "NON_PLAIN_OBJECT",
    CYCLIC_INPUT: "CYCLIC_INPUT",
    FUNCTION_VALUE: "FUNCTION_VALUE",
    SYMBOL_VALUE: "SYMBOL_VALUE",
    ACCESSOR_PROPERTY: "ACCESSOR_PROPERTY",
    UNBOUNDED_STRING: "UNBOUNDED_STRING",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",

    // intent identity / shape
    INVALID_INTENT: "INVALID_INTENT",
    INVALID_CAPABILITY_ID: "INVALID_CAPABILITY_ID",
    INVALID_OPERATION: "INVALID_OPERATION",

    // authority-shaped payload guard
    AUTHORITY_METADATA: "AUTHORITY_METADATA",

    // untrusted boundary
    OBJECT_INPUT_NOT_ALLOWED: "OBJECT_INPUT_NOT_ALLOWED",

    // gate / decision model (typed decision reasons live in the decision, but
    // these are used when the gate itself is asked to evaluate malformed
    // inputs rather than emit a decision)
    INVALID_DECISION_STATE: "INVALID_DECISION_STATE"
});

function fail(reasonCode, message, details = null) {
    return new ActionError(reasonCode, message, details);
}

module.exports = { ActionError, REASONS, fail };
