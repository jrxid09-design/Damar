"use strict";

const { createRedactionRegistry } = require("./redact");

/**
 * Bounded, redacted diagnostics ring for vault operations.
 *
 * LAW: logging != permission to reveal secrets. Every entry passes
 * through the redaction registry before storage, entries are capped,
 * and there is deliberately NO API that dumps raw operation inputs.
 */
function createVaultDiagnostics(config) {
    const registry = createRedactionRegistry(config);
    let entries = [];
    const max = config.maxDiagnosticHistory;

    /**
     * Single validated object parameter — no positional ambiguity (B4).
     * Schema (all bounded, all scrubbed where textual):
     *   { at, op, secretId, outcome, detail }
     */
    function record(entry) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new TypeError("diagnostic entry must be an object");
        }
        const op = typeof entry.op === "string" ? entry.op.slice(0, 32) : "unknown";
        const secretId = typeof entry.secretId === "string" ? entry.secretId.slice(0, 64) : null;
        const outcome = typeof entry.outcome === "string"
            ? entry.outcome.slice(0, 32)
            : "unknown";
        // Only the detail field is free-form text: it MUST pass through
        // the redaction registry before storage.
        const rawDetail = entry.detail === undefined || entry.detail === null
            ? null
            : String(entry.detail).slice(0, 256);
        const detail = rawDetail === null ? null : registry.scrubText(rawDetail);
        const frozen = Object.freeze({
            at: Number.isSafeInteger(entry.at) ? entry.at : null,
            op,
            secretId,
            outcome,
            detail
        });
        entries.push(frozen);
        if (entries.length > max) {
            entries = entries.slice(-max);
        }
        return frozen;
    }

    function recent(limit) {
        const n = Math.min(Math.max(1, limit | 0 || 20), max);
        return entries.slice(-n);
    }

    function size() {
        return entries.length;
    }

    return Object.freeze({
        record,
        recent,
        size,
        registry
    });
}

module.exports = Object.freeze({
    createVaultDiagnostics
});
