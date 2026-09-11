"use strict";

/**
 * W6-R4-01 — CANONICAL AUTHORITY COMPOSITION ROOT (deep-internal closure).
 *
 * PURPOSE
 *   Provide ONE lexical compartment where the production AuthorityRegistry is
 *   constructed, marked canonical, installed into the distributed-execution
 *   authority source, and bound to an Evolution pipeline.
 *
 *   This module is intentionally NOT re-exported from any public package
 *   surface: `src/authority/index.js` re-exports only
 *   `isCanonicalAuthorityRegistry` (read-only predicate) via canonicalOwnership;
 *   `src/dexec/index.js` does NOT export an installer. Ordinary callers who
 *   import the production authority/manager surfaces cannot construct, mark,
 *   install, or rebind a canonical AuthorityRegistry.
 *
 * SECURITY MODEL
 *   CONSTRUCTED INSTANCE != CANONICAL OWNER.
 *   `new AuthorityRegistry(...)` from ANY caller is NEVER canonical. Only the
 *   instance constructed INSIDE this closure over the bootstrap-owned store is
 *   marked (closure-private WeakSet). Cloned/spread/serialized/monkey-patched
 *   copies remain non-canonical (object identity).
 *
 *   - `__markCanonical` comes from the leaf brand module (canonicalBrand.js) —
 *     it is never exported to callers.
 *   - `installCanonicalAuthorityRegistry` is internal to dexec/authoritySource
 *     and called ONLY from this composition closure.
 *   - The returned `owner` handle exists ONLY for composition-internal wiring
 *     (grants, ratification) inside the production closure / a test-only
 *     harness. It is NEVER forwarded to the RuntimeHost public facade.
 */

const { AuthorityRegistry } = require("./registry");
const { __markCanonical } = require("./canonicalBrand");
const { isCanonicalAuthorityRegistry } = require("./canonicalBrand");

/**
 * Deep-internal composition entrypoint.
 *
 * Constructs the ONE canonical AuthorityRegistry over a bootstrap-owned store
 * and clock, marks it canonical, installs it into the module-private
 * distributed authority source (when `installDistributed` is true), and binds
 * it to an Evolution pipeline (when given).
 *
 * @param {object} opts
 * @param {object}   opts.store                functional authority store
 * @param {object}   opts.clock                { nowIso, nowMs }
 * @param {object|null} [opts.evolutionPipeline] EvolutionPipeline to bind
 * @param {boolean}  [opts.installDistributed=true]
 * @returns {object} frozen { marker, isCanonical, owner }
 */
function composeCanonicalAuthorityRoot({ store, clock, evolutionPipeline = null, installDistributed = true } = {}) {
    if (!store || typeof store.getCapability !== "function") {
        throw new TypeError("composeCanonicalAuthorityRoot requires a functional store");
    }
    if (!clock || typeof clock.nowIso !== "function" || typeof clock.nowMs !== "function") {
        throw new TypeError("composeCanonicalAuthorityRoot requires a clock { nowIso, nowMs }");
    }

    // ----- construct the canonical owner INSIDE this closure -----
    const registry = __markCanonical(new AuthorityRegistry({ store, clock }));

    // ----- bind Evolution (live canary ratification) -----
    if (evolutionPipeline !== null && evolutionPipeline !== undefined) {
        if (typeof evolutionPipeline !== "object") {
            throw new TypeError("evolutionPipeline must be an EvolutionPipeline-shaped object or null");
        }
        evolutionPipeline.authorityRegistry = registry;
    }

    // ----- install as distributed authority source (module-private seam) -----
    if (installDistributed) {
        require("../dexec/authoritySource").installCanonicalAuthorityRegistry(registry);
    }

    return Object.freeze({
        marker: "canonical-authority-root",
        isCanonical: isCanonicalAuthorityRegistry(registry),
        owner: registry, // composition-internal only; never a public surface value
    });
}

module.exports = Object.freeze({
    composeCanonicalAuthorityRoot,
    isCanonicalAuthorityRegistry,
    // __markCanonical intentionally NOT exported.
});