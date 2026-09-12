"use strict";

/**
 * W6-R5-01 — CANONICAL AUTHORITY SOURCE (read-only facade).
 *
 * The privileged authority binding state and the install primitive now live
 * LEXICALLY inside `src/authority/canonicalComposition.js` (the single lexical
 * owner). This module is a thin, read-only delegation facade so existing
 * importers (`dexec/index.js`) keep working without exposing any mutator.
 *
 * CALLER-SUPPLIED BRIDGE != CANONICAL AUTHORITY.
 * DUCK TYPE != TRUST. EXPORTED BRAND SYMBOL != SECURITY.
 */

const composition = require("../authority/canonicalComposition");

/** Whether the canonical authority source has been bound. */
function isCanonicalAuthorityBound() {
    return composition.isCanonicalAuthorityBound();
}

/** Read-only bridge accessor (delegates to the single lexical owner). */
function getCanonicalAuthorityBridge() {
    return composition.getCanonicalAuthorityBridge();
}

// R5-01: NO install / first-bind / mint primitive is exported here. The only
// installable object is produced inside canonicalComposition's closure.
module.exports = Object.freeze({
    isCanonicalAuthorityBound,
    getCanonicalAuthorityBridge
});
