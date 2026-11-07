"use strict";

/**
 * W6-R5-01 — CANONICAL AUTHORITY BRAND (leaf predicate module, no dependencies).
 *
 * This module exposes only the PUBLIC read-only predicate. The actual brand
 * (the closure-private WeakSet and predicate) lives lexically in the single
 * production owner (`canonicalComposition.js`). The lazy bridge avoids a
 * reverse dependency during registry bootstrap and has no mutable hook.
 *
 * Consequences:
 *   - No marking / minting primitive is exported from this module or from
 *     canonicalComposition.js. A repo-local direct `require` of either file
 *     yields NO mutator.
 *   - There is no registration or replacement primitive. Load order cannot
 *     poison recognition because the owner predicate is resolved by module
 *     identity at call time.
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER.
 */

/** Brand-first ownership predicate (read-only, delegates to the lexical owner). */
function isCanonicalAuthorityRegistry(value) {
    const owner = require("./canonicalComposition");
    return typeof owner.isCanonicalAuthorityRegistry === "function" &&
        owner.isCanonicalAuthorityRegistry(value) === true;
}

module.exports = Object.freeze({
    isCanonicalAuthorityRegistry
});
