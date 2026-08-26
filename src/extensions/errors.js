"use strict";

/**
 * EXTENSION KERNEL V1 — error contract.
 *
 * Every rejection carries a stable reasonCode so callers can branch on
 * machine-readable causes without parsing messages. All kernel failures are
 * fail-closed: malformed input is rejected, never silently repaired into a
 * different canonical value.
 */
class ExtensionKernelError extends Error {
    constructor(reasonCode, message, details = null) {
        super(message);
        this.name = "ExtensionKernelError";
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

const REASONS = Object.freeze({
    MALFORMED_INPUT: "MALFORMED_INPUT",
    MALFORMED_JSON: "MALFORMED_JSON",
    MANIFEST_TOO_LARGE: "MANIFEST_TOO_LARGE",
    UNSUPPORTED_SCHEMA: "UNSUPPORTED_SCHEMA",
    DANGEROUS_KEY: "DANGEROUS_KEY",
    INVALID_EXTENSION_ID: "INVALID_EXTENSION_ID",
    INVALID_PROJECT_ID: "INVALID_PROJECT_ID",
    INVALID_CAPABILITY_ID: "INVALID_CAPABILITY_ID",
    INVALID_VERSION: "INVALID_VERSION",
    INVALID_VERSION_RANGE: "INVALID_VERSION_RANGE",
    UNKNOWN_FIELD: "UNKNOWN_FIELD",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    DUPLICATE_EXTENSION: "DUPLICATE_EXTENSION",
    REGISTRY_FULL: "REGISTRY_FULL",
    UNKNOWN_EXTENSION: "UNKNOWN_EXTENSION",
    INVALID_TRANSITION: "INVALID_TRANSITION",
    DEPENDENCY_UNSATISFIED: "DEPENDENCY_UNSATISFIED",
    INVALID_HEALTH_STATUS: "INVALID_HEALTH_STATUS",
    ACTIVATION_REJECTED: "ACTIVATION_REJECTED"
});

function fail(reasonCode, message, details = null) {
    return new ExtensionKernelError(reasonCode, message, details);
}

module.exports = { ExtensionKernelError, REASONS, fail };
