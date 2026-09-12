"use strict";

/**
 * TEST-ONLY — canonical authority root harness for Repair5 suites.
 *
 * This module is NOT part of production exports or package surfaces. It uses the
 * sanctioned TEST-ONLY seam exported by `src/authority/canonicalComposition`
 * (`createCanonicalAuthorityRootTestOnly`). It does NOT import any production
 * privileged mutator by name (`__markCanonical`, `composeCanonicalAuthorityRoot`,
 * `installCanonicalAuthorityRegistry` are all absent from production exports).
 *
 * The production RuntimeHost composition owns the canonical authority via
 * `createProductionRuntimeComposition`; this helper exists ONLY so repair tests
 * can build isolated canonical owners for assertions.
 */

const { createCanonicalAuthorityRootTestOnly } = require("../../../src/authority/canonicalComposition");
const dexec = require("../../../src/dexec");

/**
 * Build an isolated canonical authority root.
 * @returns {Promise<{ owner, isCanonical, marker }>}
 */
async function makeCanonicalAuthorityRoot({ store, clock, evolutionPipeline = null, installDistributed = true } = {}) {
    const root = await createCanonicalAuthorityRootTestOnly({
        store,
        clock,
        evolutionPipeline,
        installDistributed
    });
    return {
        owner: root.owner,
        isCanonical: root.isCanonical,
        marker: root.marker
    };
}

module.exports = { makeCanonicalAuthorityRoot };