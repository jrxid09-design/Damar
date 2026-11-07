"use strict";

/**
 * EXTENSION KERNEL V1 — health model, independent from enablement.
 *
 * Health reports arrive ONLY through the trusted lifecycle path
 * (registry.reportHealth). Diagnostics are bounded and sanitized: the kernel
 * never stores raw hostile objects, only short frozen string records.
 */

const { fail, REASONS } = require("./errors");

const HEALTH_STATUSES = Object.freeze({
    UNKNOWN: "UNKNOWN",
    HEALTHY: "HEALTHY",
    DEGRADED: "DEGRADED",
    FAILED: "FAILED"
});

const BOUNDS = Object.freeze({
    MAX_DIAGNOSTIC_ENTRIES: 32,
    MAX_DIAGNOSTIC_CODE_CHARS: 64,
    MAX_DIAGNOSTIC_MESSAGE_CHARS: 256,
    MAX_DROPPED_ENTRIES_RECORDED: 1 // "droppedCount" replaces overflow
});

const REPORTABLE = Object.freeze(new Set([
    HEALTH_STATUSES.HEALTHY, HEALTH_STATUSES.DEGRADED, HEALTH_STATUSES.FAILED
]));

function safeString(value, maxChars) {
    let s;
    try {
        s = String(value);
    } catch {
        return "[unprintable]";
    }
    if (s.length > maxChars) s = s.slice(0, maxChars);
    // strip control characters that could poison logs/state consumers
    return s.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/**
 * Build a frozen bounded health report.
 * diagnostics: array of { code?, message?, ...anything } — coerced to
 * { code, message } strings; extra fields are discarded; overflow dropped
 * and counted (never accumulated).
 */
function createHealthReport(status, diagnostics, { atMs = null } = {}) {
    if (typeof status !== "string" || !REPORTABLE.has(status)) {
        throw fail(REASONS.INVALID_HEALTH_STATUS,
            `health status must be one of ${[...REPORTABLE].join("|")}`, { received: status });
    }
    const entries = [];
    let dropped = 0;
    if (diagnostics !== undefined && diagnostics !== null) {
        if (!Array.isArray(diagnostics)) {
            throw fail(REASONS.MALFORMED_INPUT, "diagnostics must be an array");
        }
        for (let i = 0; i < diagnostics.length; i++) {
            if (entries.length >= BOUNDS.MAX_DIAGNOSTIC_ENTRIES) {
                dropped += diagnostics.length - i;
                break;
            }
            const raw = diagnostics[i];
            const obj = (raw !== null && typeof raw === "object") ? raw : {};
            entries.push(Object.freeze({
                code: safeString(obj.code ?? `DIAG_${i}`, BOUNDS.MAX_DIAGNOSTIC_CODE_CHARS),
                message: safeString(obj.message ?? "", BOUNDS.MAX_DIAGNOSTIC_MESSAGE_CHARS)
            }));
        }
    }
    return Object.freeze({
        status,
        atMs,
        diagnostics: Object.freeze(entries),
        droppedDiagnostics: dropped
    });
}

module.exports = { HEALTH_STATUSES, createHealthReport, REPORTABLE, BOUNDS };
