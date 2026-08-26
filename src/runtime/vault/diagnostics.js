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

    function record(op, secretId, outcome, detail) {
        const entry = Object.freeze({
            at: op.at ?? null,
            op: String(op).slice(0, 32),
            secretId: secretId ?? null,
            outcome: String(outcome).slice(0, 32),
            detail: detail === undefined ? null : registry.scrubText(String(detail).slice(0, 256))
        });
        entries.push(entry);
        if (entries.length > max) {
            entries = entries.slice(-max);
        }
        return entry;
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
