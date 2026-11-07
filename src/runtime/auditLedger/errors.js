"use strict";

/**
 * Audit Ledger V1 — typed errors.
 *
 * Every append/query failure carries a stable machine code. A malformed
 * event MUST fail atomically (nothing mutated), so validation errors are
 * thrown BEFORE any internal state change; callers who must never crash
 * use appendSafe() which converts these into { ok:false } results.
 */

class LedgerError extends Error {
    /**
     * @param {string} code stable machine code (E_*)
     * @param {string} message human-readable detail
     * @param {object} [detail] bounded extra context (never raw payloads)
     */
    constructor(code, message, detail = null) {
        super(message);
        this.name = "LedgerError";
        this.code = code;
        this.detail = detail;
    }
}

const CODES = Object.freeze({
    INVALID_EVENT: "E_INVALID_EVENT",
    DUPLICATE_EVENT_ID: "E_DUPLICATE_EVENT_ID",
    BOUNDS_EXCEEDED: "E_BOUNDS_EXCEEDED",
    MALFORMED_REF: "E_MALFORMED_REF",
    REDACTION_FAILED: "E_REDACTION_FAILED",
    NOT_APPENDABLE: "E_NOT_APPENDABLE",
    NO_SINK: "E_NO_SINK",
    PERSIST_FAILED: "E_PERSIST_FAILED",
    INVALID_BOUNDS: "E_INVALID_BOUNDS",
    INVALID_QUERY: "E_INVALID_QUERY"
});

module.exports = Object.freeze({ LedgerError, CODES });
