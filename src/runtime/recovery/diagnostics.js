"use strict";

/**
 * Bounded, immutable recovery diagnostics (R19).
 *
 * Diagnostics DESCRIBE failure. They never grant recovery permission,
 * never carry capability semantics, and never embed raw section payload.
 */

const DIAGNOSTIC_CODES = Object.freeze([
    "INVALID_DIGEST",
    "UNKNOWN_PROVIDER",
    "UNSUPPORTED_VERSION",
    "INCOMPLETE_CAPSULE",
    "LINEAGE_FORK",
    "LINEAGE_CYCLE",
    "LINEAGE_MISSING_PARENT",
    "LINEAGE_CONFLICTING_EPOCH",
    "LINEAGE_TOO_DEEP",
    "SECTION_TOO_LARGE",
    "CAPSULE_TOO_LARGE",
    "TOO_MANY_SECTIONS",
    "CANDIDATE_COUNT_OVERFLOW",
    "MALFORMED_ID",
    "MALFORMED_SECTION",
    "SCHEMA_INVALID",
    "PROVIDER_REJECTED",
    "PREPARE_FAILED",
    "COMMIT_FAILED",
    "ROLLBACK_FAILED",
    "AUTHORITY_REVALIDATION_REQUIRED",
    "NON_RESUMABLE_STATE",
    "EPHEMERAL_SECTION_SKIPPED",
    "CHECKPOINT_ABORTED",
    "SELECTION_AMBIGUOUS",
    "EXPLICIT_SELECTION_NOT_FOUND",
    "UNKNOWN"
].reduce((m, c) => ((m[c] = c), m), {}));

class RecoveryDiagnosticError extends Error {
    constructor(code, message) {
        super(message ?? code);
        this.name = "RecoveryDiagnosticError";
        this.code = code;
    }
}

function createDiagnostic(code, details = {}) {
    if (!Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODES, code)) {
        return createDiagnostic("UNKNOWN", { ...details, unknownRequestedCode: String(code) });
    }
    const diag = {
        code,
        capsuleId: typeof details.capsuleId === "string" ? details.capsuleId.slice(0, 64) : null,
        sectionId: typeof details.sectionId === "string" ? details.sectionId.slice(0, 64) : null,
        message: typeof details.message === "string" ? details.message.slice(0, 256) : null
    };
    return Object.freeze(diag);
}

class DiagnosticCollector {
    constructor(maxDiagnostics) {
        this.max = maxDiagnostics;
        this.items = [];
    }

    add(code, details) {
        if (this.items.length >= this.max) {
            return null;
        }
        const diag = createDiagnostic(code, details);
        this.items.push(diag);
        return diag;
    }

    snapshot() {
        return Object.freeze(this.items.slice());
    }
}

module.exports = Object.freeze({
    DIAGNOSTIC_CODES,
    RecoveryDiagnosticError,
    createDiagnostic,
    DiagnosticCollector
});
