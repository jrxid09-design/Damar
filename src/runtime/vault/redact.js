"use strict";

const { invalidInput } = require("./errors");

/**
 * Defensive redaction.
 *
 * The RedactionRegistry keeps a BOUNDED set of currently-active secret
 * value strings so that any text leaving the vault boundary (diagnostics,
 * error context, test-visible snapshots) can be scrubbed of accidental
 * value leakage. Entries are dropped on rotation/revoke/delete.
 *
 * The registry is a defense-in-depth sink, not a permission: values are
 * never exposed *because* they are registered here.
 */

function createRedactionRegistry(config) {
    let entries = new Map(); // value string -> replacement token

    function track(rawValue, label) {
        if (typeof rawValue !== "string" || rawValue.length === 0) {
            return;
        }
        if (rawValue.length > config.maxRedactionValueBytes) {
            // Oversized values are still scrubbed, but by prefix window.
            rawValue = rawValue.slice(0, config.maxRedactionValueBytes);
        }
        if (!entries.has(rawValue) && entries.size >= config.maxRedactionTrackedValues) {
            // Bound: evict oldest insertion.
            const firstKey = entries.keys().next().value;
            entries.delete(firstKey);
        }
        entries.set(rawValue, `[secret:${label || "redacted"}]`);
    }

    function untrack(rawValue) {
        if (typeof rawValue !== "string") {
            return;
        }
        entries.delete(rawValue.slice(0, config.maxRedactionValueBytes));
    }

    function scrubText(text) {
        if (typeof text !== "string" || text.length === 0 || entries.size === 0) {
            return typeof text === "string" ? text : "";
        }
        let out = text;
        for (const [value, marker] of entries) {
            if (out.includes(value)) {
                out = out.split(value).join(marker);
            }
        }
        return out;
    }

    /** Scrub any JSON-serializable structure recursively (bounded). */
    function scrubDeep(value, depth = 0) {
        if (depth > 8) {
            return "[deep]";
        }
        if (typeof value === "string") {
            return scrubText(value);
        }
        if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
            return value;
        }
        try {
            if (Array.isArray(value)) {
                return value.slice(0, 256).map((v) => scrubDeep(v, depth + 1));
            }
            if (typeof value === "object") {
                const out = {};
                for (const k of Object.keys(value).slice(0, 256)) {
                    out[k] = scrubDeep(value[k], depth + 1);
                }
                return out;
            }
        } catch (_) {
            return "[unscrubbable]";
        }
        return String(value);
    }

    function size() {
        return entries.size;
    }

    function reset() {
        entries = new Map();
    }

    return Object.freeze({ track, untrack, scrubText, scrubDeep, size, reset });
}

/** Best-effort scrubber for arbitrary text without a registry. */
function redactMatches(text, candidates) {
    if (typeof text !== "string") {
        throw invalidInput("redactMatches requires text");
    }
    let out = text;
    for (const c of candidates) {
        if (typeof c === "string" && c.length > 0 && out.includes(c)) {
            out = out.split(c).join("[secret]");
        }
    }
    return out;
}

module.exports = Object.freeze({
    createRedactionRegistry,
    redactMatches
});
