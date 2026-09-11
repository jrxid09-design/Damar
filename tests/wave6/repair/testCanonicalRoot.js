"use strict";

/**
 * TEST-ONLY — canonical authority root harness for Repair3/4 suites.
 *
 * This module is NOT part of production exports or package surfaces. It is a
 * thin test helper that invokes the deep-internal production composition
 * (`src/authority/canonicalComposition.js`), which is itself not re-exported
 * from any public index. Tests use this harness to obtain an isolated
 * canonical AuthorityRegistry owner + install it into the module-private
 * distributed authority source.
 *
 * The production RuntimeHost composition uses the SAME deep-internal
 * composition module. This helper exists ONLY so test suites can legitimately
 * construct an isolated canonical composition without reaching into a public
 * factory (there is none).
 */

const { composeCanonicalAuthorityRoot } = require("../../../src/authority/canonicalComposition");
const dexec = require("../../../src/dexec");

/**
 * Build an isolated canonical authority root.
 * @returns {Promise<{ owner, isCanonical, install }>}
 */
async function makeCanonicalAuthorityRoot({ store, clock, evolutionPipeline = null, installDistributed = true } = {}) {
    const root = composeCanonicalAuthorityRoot({
        store,
        clock,
        evolutionPipeline,
        installDistributed
    });
    return {
        owner: root.owner,
        isCanonical: root.isCanonical,
        marker: root.marker,
        // Test-only convenience: install is done by composition when requested.
        install: () => (root.canInstallForDistributed ? true : undefined)
    };
}

module.exports = { makeCanonicalAuthorityRoot };