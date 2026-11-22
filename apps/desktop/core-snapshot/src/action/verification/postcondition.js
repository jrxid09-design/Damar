"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION V1 — expected-postcondition vocabulary
 * (Lane 4, inert grammar ONLY — no evaluator, no former, no registry).
 *
 * CORE LAW — DECLARATIVE POSTCONDITIONS ONLY:
 *
 *   Downstream callers may provide DECLARATIVE expected values only. An
 *   arbitrary executable predicate (function, compiled predicate, evaluator
 *   object with an exec/eval/apply surface, class instance) is NEVER accepted
 *   as an expected postcondition. The canonical evaluator implementation —
 *   owned by the trusted bootstrap's private composition closure — decides
 *   how declarative expectations are evaluated against canonical evidence.
 *
 *   PLAN != AUTHORITY  — an expected postcondition is descriptive intent,
 *   never a verification claim and never an authority token.
 *
 * CANONICAL DECLARATIVE SHAPE (informational, for consumers):
 *
 *   {
 *     schemaVersion: 1,
 *     kind: "postcondition.v1",
 *     expect: {
 *       <dottedPath>: { op: "eq"|"ne"|"exists"|"absent"|"gt"|"gte"|"lt"|"lte"|"in"|"type",
 *                       value?: <declarative value> }
 *     } | null,
 *     forbid: { <dottedPath>: <declarative value or true> } | null
 *   }
 *
 *   - expect: map of dotted paths into the observed evidence to comparisons.
 *   - forbid: paths that must be absent/absent-or-not-equal (used for
 *     "service stopped", "record absent", "state must not equal X").
 *   - All comparison values are plain JSON-compatible declarative values.
 *     No functions, no symbols, no accessors, no cycles (enforced by the
 *     trusted former via the same hostile-input detachment used everywhere).
 *
 * The trusted evaluator treats a MISSING expectation as INCONCLUSIVE — an
 * empty expect/forbid set cannot mint VERIFIED_SUCCESS (no false positive
 * from a vacuous postcondition).
 */

const POSTCONDITION_SCHEMA_VERSION = 1;
const POSTCONDITION_KIND = "postcondition.v1";

/** Allowed comparison operators (frozen; closed set). */
const POSTCONDITION_OPS = Object.freeze({
    EQ: "eq",
    NE: "ne",
    EXISTS: "exists",
    ABSENT: "absent",
    GT: "gt",
    GTE: "gte",
    LT: "lt",
    LTE: "lte",
    IN: "in",
    TYPE: "type"
});

/** Allowed type names for the `type` operator. */
const POSTCONDITION_TYPES = Object.freeze({
    STRING: "string",
    NUMBER: "number",
    BOOLEAN: "boolean",
    OBJECT: "object",
    ARRAY: "array",
    NULL: "null"
});

const BOUNDS = Object.freeze({
    MAX_EXPECT_ENTRIES: 32,
    MAX_PATH_CHARS: 128,
    MAX_PATH_DEPTH: 8,
    MAX_VALUE_NODES: 256,
    MAX_VALUE_STRING_CHARS: 1024,
    MAX_ARRAY_LENGTH: 64
});

/** PURE predicate — is `op` a valid postcondition operator? */
function isPostconditionOp(op) {
    return typeof op === "string" &&
        Object.values(POSTCONDITION_OPS).includes(op);
}

/** PURE predicate — is `t` a valid postcondition type name? */
function isPostconditionType(t) {
    return typeof t === "string" &&
        Object.values(POSTCONDITION_TYPES).includes(t);
}

/** PURE predicate — is `path` a syntactically valid dotted path? */
function isValidPostconditionPath(path) {
    if (typeof path !== "string" || path.length === 0 ||
        path.length > BOUNDS.MAX_PATH_CHARS) {
        return false;
    }
    const segments = path.split(".");
    if (segments.length > BOUNDS.MAX_PATH_DEPTH) return false;
    for (const seg of segments) {
        // segment must be a plain identifier-ish token; rejects empty
        // segments, "__proto__", "constructor", "prototype" at any position.
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(seg)) return false;
        const lower = seg.toLowerCase();
        if (lower === "__proto__" || lower === "constructor" || lower === "prototype") {
            return false;
        }
    }
    return true;
}

module.exports = {
    // inert frozen vocabulary + pure predicates ONLY
    POSTCONDITION_SCHEMA_VERSION,
    POSTCONDITION_KIND,
    POSTCONDITION_OPS,
    POSTCONDITION_TYPES,
    BOUNDS,
    isPostconditionOp,
    isPostconditionType,
    isValidPostconditionPath
};

// NOT exported: any postcondition evaluator/former/validator constructor.
