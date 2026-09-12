"use strict";

/**
 * W6-R5-01 — CANONICAL AUTHORITY BRAND (leaf predicate module, no dependencies).
 *
 * This module owns the PUBLIC read-only `isCanonicalAuthorityRegistry` predicate
 * used across the authority surface. The actual brand (the closure-private
 * WeakSet that marks the ONE canonical AuthorityRegistry, plus the marking
 * function) lives LEXICALLY inside the single production owner
 * (`src/authority/canonicalComposition.js`). That module registers its predicate
 * here via `registerCanonicalPredicate` at load time.
 *
 * Consequences:
 *   - No marking / minting primitive is exported from this module or from
 *     canonicalComposition.js. A repo-local direct `require` of either file
 *     yields NO mutator.
 *   - There is no reverse dependency (this module does NOT require
 *     canonicalComposition), so load order / cycles are impossible.
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER.
 */

let _predicate = null;

/** Called once by the single production owner at module load. */
function registerCanonicalPredicate(fn) {
    if (typeof fn === "function") _predicate = fn;
    return registerCanonicalPredicate;
}

/** Brand-first ownership predicate (read-only, delegates to the registered owner). */
function isCanonicalAuthorityRegistry(value) {
    return typeof _predicate === "function" ? Boolean(_predicate(value)) : false;
}

module.exports = Object.freeze({
    isCanonicalAuthorityRegistry,
    registerCanonicalPredicate
});
