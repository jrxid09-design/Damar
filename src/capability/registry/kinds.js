"use strict";

/**
 * CAPABILITY REGISTRY V1 — bounded canonical kind vocabulary.
 *
 * A small, closed set sufficient for future Aether. Unknown kinds fail
 * closed. These labels describe WHAT a descriptor IS (shape of origin),
 * never whether it is permitted, trusted, or authorized.
 */

const { fail, REASONS } = require("./errors");

const KINDS = Object.freeze({
    TOOL: "tool",
    EXTENSION: "extension",
    DEVICE: "device",
    RUNTIME: "runtime",
    PROVIDER: "provider",
    SYSTEM: "system"
});

const KIND_SET = Object.freeze(new Set(Object.values(KINDS)));

function canonicalKind(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.UNKNOWN_KIND, `kind must be string, got ${typeof raw}`);
    }
    const value = raw.trim().toLowerCase();
    if (!KIND_SET.has(value)) {
        throw fail(REASONS.UNKNOWN_KIND,
            `unknown capability kind '${String(raw).slice(0, 80)}'`,
            { received: String(raw).slice(0, 80), allowed: [...KIND_SET] });
    }
    return value;
}

module.exports = { KINDS, KIND_SET, canonicalKind };
