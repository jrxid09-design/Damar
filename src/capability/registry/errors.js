"use strict";

/**
 * CAPABILITY REGISTRY V1 — error contract.
 *
 * Every rejection carries a stable `reasonCode` so callers branch on
 * machine-readable causes without parsing messages. All failures are
 * fail-closed: malformed input is rejected, never silently repaired into a
 * different canonical value.
 *
 * This registry is DESCRIPTIVE ONLY. Its error vocabulary therefore never
 * encodes an Authority decision (no "UNAUTHORIZED", no "DENIED"): every code
 * describes a shape/identity/graph/state problem, never a permission one.
 */

class CapabilityRegistryError extends Error {
    constructor(reasonCode, message, details = null) {
        super(message);
        this.name = "CapabilityRegistryError";
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

const REASONS = Object.freeze({
    // descriptor / input validation
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

    // identity
    INVALID_CAPABILITY_ID: "INVALID_CAPABILITY_ID",
    INVALID_PROVENANCE: "INVALID_PROVENANCE",
    UNKNOWN_KIND: "UNKNOWN_KIND",

    // registry semantics
    DUPLICATE_CONFLICT: "DUPLICATE_CONFLICT",
    UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
    REGISTRY_FULL: "REGISTRY_FULL",

    // graph semantics
    INVALID_DEPENDENCY: "INVALID_DEPENDENCY",
    DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
    GRAPH_TRAVERSAL_BOUND: "GRAPH_TRAVERSAL_BOUND",

    // availability / generation / lifetime
    INVALID_AVAILABILITY: "INVALID_AVAILABILITY",
    STALE_OBSERVATION: "STALE_OBSERVATION",
    INVALID_GENERATION: "INVALID_GENERATION",
    INVALID_INCARNATION: "INVALID_INCARNATION",
    CONFLICTING_OBSERVATION: "CONFLICTING_OBSERVATION",

    // removal / authority-shaped provenance guard
    INVALID_PROVENANCE_SCOPE: "INVALID_PROVENANCE_SCOPE",

    // provenance identity / registrar model
    FORBIDDEN_PROVENANCE: "FORBIDDEN_PROVENANCE",
    KIND_PROVENANCE_MISMATCH: "KIND_PROVENANCE_MISMATCH",
    INVALID_REGISTRAR: "INVALID_REGISTRAR",

    // authority-shaped metadata
    AUTHORITY_METADATA: "AUTHORITY_METADATA",

    // untrusted boundary
    OBJECT_INPUT_NOT_ALLOWED: "OBJECT_INPUT_NOT_ALLOWED"
});

function fail(reasonCode, message, details = null) {
    return new CapabilityRegistryError(reasonCode, message, details);
}

module.exports = { CapabilityRegistryError, REASONS, fail };
