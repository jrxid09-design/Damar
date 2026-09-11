"use strict";

/**
 * W6-R4-01 — CANONICAL AUTHORITY READ-ONLY PREDICATE.
 *
 * This module exports ONLY a read-only ownership predicate. There is NO
 * canonical factory, NO installer, NO binder, NO registry mutator exported
 * here. Construction+marking+installation of the canonical AuthorityRegistry
 * happens exclusively inside `src/authority/canonicalComposition.js` (the
 * deep-internal composition closure), which is NOT re-exported from any public
 * package surface.
 *
 * R3-01/R4-01: `new AuthorityRegistry(...)` is NEVER canonical. The ONLY way
 * an instance becomes canonical is construction inside the composition root.
 */

const { isCanonicalAuthorityRegistry } = require("./canonicalBrand");

module.exports = Object.freeze({
    isCanonicalAuthorityRegistry
});