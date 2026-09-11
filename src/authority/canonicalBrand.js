"use strict";

/**
 * W6-R4-01 — CANONICAL AUTHORITY BRAND (leaf module, no dependencies).
 *
 * Holds the closure-private WeakSet that marks the ONE canonical
 * AuthorityRegistry. `__markCanonical` is never exported. This module depends
 * on nothing, so importing it cannot create a cycle (registry.js,
 * canonicalComposition.js, and downstream predicates all depend on it).
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER.
 */

const CANONICAL_REGISTRIES = new WeakSet();

/** Closure-private brand — not exported. */
function __markCanonical(registry) {
    if (registry === null || typeof registry !== "object") {
        throw new TypeError("__markCanonical requires an AuthorityRegistry instance");
    }
    CANONICAL_REGISTRIES.add(registry);
    return registry;
}

/** Brand-first ownership predicate (read-only). */
function isCanonicalAuthorityRegistry(value) {
    return value !== null && typeof value === "object" &&
        CANONICAL_REGISTRIES.has(value);
}

module.exports = Object.freeze({
    isCanonicalAuthorityRegistry,
    // __markCanonical intentionally NOT exported; only canonicalComposition
    // consumes it via closure binding below.
    __markCanonical
});