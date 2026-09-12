"use strict";

/**
 * W6-R5-03 — REAL PRODUCTION OWNER-TRUST PROVISIONING / COMPOSITION ROOT.
 *
 * Before R5-03 the production daemon NEVER bound the canonical
 * AuthorityRegistry: `createProductionRuntimeComposition` had zero production
 * callers, so `dexec/router.js` -> `getCanonicalAuthorityBridge()` always threw
 * ("not yet bound") and governed distributed execution fail-closed forever.
 * Owner trust was composed (Wave 5 Lane 4) but its proof-verified ratification
 * bridge was never connected to the canonical authority registry.
 *
 * This module is the ONE real production composition that:
 *   1. Opens the BOOTSTRAP-OWNED durable authority store (sqlite; env-overridable
 *      via DAMAR_AUTHORITY_DB; "memory" disables durability for tests).
 *   2. Constructs the canonical AuthorityRegistry inside the deep-internal
 *      composition root (`createProductionRuntimeComposition`) and installs it
 *      into the module-private distributed authority source. A caller-created
 *      `new AuthorityRegistry(...)` can never be installed (R3-01/R4-01).
 *   3. Binds the canonical Evolution pipeline to that registry so canary
 *      ratification resolves LIVE from the canonical owner (R2-01).
 *   4. Composes the SEALED canonical Owner/Admin trust composition
 *      (`ownerTrustComposition.ensureCanonicalComposed`) — the real production
 *      path, not the test seam.
 *   5. Connects the Owner proof-verified ratification bridge to the canonical
 *      registry. `ratifyAsOwner` requires a genuine one-use proof-of-possession
 *      and a stored proposal; a raw ownerIdentity string is never authority.
 *
 * LAWS:
 *   - Idempotent + single-flight: composition runs ONCE per process.
 *   - No privileged mutator is exported: the registry mark/install primitive
 *     stays lexical to `canonicalComposition.js`.
 *   - `provisionAuthority` mints a capability ONLY from a STORED owner
 *     ratification bound to the canonical proposal digest/revision — never from
 *     caller-shaped authority.
 */

const os = require("node:os");
const path = require("node:path");

const {
    createProductionRuntimeComposition,
    isCanonicalAuthorityBound
} = require("./canonicalComposition");
const { ensureCanonicalComposed } = require("./ownerTrustComposition");

// ---------------------------------------------------------------------------
// Canonical durable authority store location (bootstrap-owned). Tests isolate
// via DAMAR_AUTHORITY_DB (see tests/helpers/testEnv.js).
// ---------------------------------------------------------------------------
function resolveProductionAuthorityStore() {
    const setting = process.env.DAMAR_AUTHORITY_DB;
    if (setting === "memory") return null;
    if (typeof setting === "string" && setting.length > 0) {
        return path.resolve(setting);
    }
    return path.join(os.homedir(), ".damar", "authority-v1.db");
}

function productionClock() {
    return {
        nowIso: () => new Date().toISOString(),
        nowMs: () => Date.now()
    };
}

/**
 * Open the bootstrap-owned authority store. Durable mode uses the same sqlite
 * wrapper + migrations as the memory service (WAL, authority tables 009/010);
 * memory mode is a NON-DURABLE test/isolated mode.
 */
async function openProductionAuthorityStore() {
    const file = resolveProductionAuthorityStore();
    if (file === null) {
        const { createMemoryAuthorityStore } = require("./store");
        return { store: createMemoryAuthorityStore(), durable: false, file: null, database: null };
    }
    const Database = require("../memory/db/Database");
    const migrate = require("../memory/db/migrate");
    const { createSqliteAuthorityStore } = require("./store");
    const database = new Database(file);
    await database.open();
    await migrate(database, {});
    return { store: createSqliteAuthorityStore(database), durable: true, file, database };
}

/**
 * Build the canonical authority root + canonical Evolution pipeline. The
 * pipeline is bound INSIDE the composition closure (`evolutionPipeline`), so
 * its `authorityRegistry` is THE canonical owner.
 */
async function composeProductionAuthority() {
    const opened = await openProductionAuthorityStore();
    const evo = require("../evolution");
    const authorityModel = require("./model");
    const evolutionPipeline = new evo.EvolutionPipeline({ authorityModel });
    const root = createProductionRuntimeComposition({
        store: opened.store,
        clock: productionClock(),
        evolutionPipeline
    });
    return { root, evolutionPipeline, durable: opened.durable, file: opened.file, opened };
}

// ---------------------------------------------------------------------------
// Module-private composition state (single-flight, bootstrap-owned).
// ---------------------------------------------------------------------------
let productionComposition = null;
let compositionPromise = null;

/**
 * Idempotent, single-flight production composition.
 *
 * @returns {Promise<object>} frozen composition (see fields below)
 */
async function ensureProductionAuthorityComposed() {
    if (productionComposition !== null) return productionComposition;
    if (compositionPromise === null) {
        compositionPromise = (async () => {
            const authority = await composeProductionAuthority();
            // Real production owner-trust composition (sealed, durable path).
            // A trust-domain failure must NOT erase the canonical authority
            // binding; record it and keep the composition fail-closed for
            // owner-gated operations.
            let ownerTrust = null;
            let ownerTrustError = null;
            try {
                ownerTrust = await ensureCanonicalComposed();
            } catch (error) {
                ownerTrustError = error;
            }

            const canonicalOwner = authority.root.canonicalOwner;

            const comp = Object.freeze({
                marker: "production-owner-trust-composition",
                authority: authority.root,
                canonicalOwner,
                ownerTrust,
                ownerTrustError,
                evolutionPipeline: authority.evolutionPipeline,
                durableAuthority: authority.durable,
                authorityStoreFile: authority.file,

                /**
                 * Owner proof-verified ratification bridge bound to THE
                 * canonical AuthorityRegistry. `proof` must be a genuine
                 * owner-proof; `ratification` names a STORED proposal. This
                 * delegates to the sealed owner-trust verifier and then to the
                 * canonical registry — never to a caller-supplied identity.
                 */
                async ratifyAsOwner({ proof, ratification } = {}) {
                    if (!ownerTrust) {
                        return Object.freeze({ applied: false, reasonCode: "OT_NOT_COMPOSED" });
                    }
                    return ownerTrust.ratifyAsOwner({
                        authorityRegistry: canonicalOwner,
                        proof,
                        ratification
                    });
                },

                /**
                 * Provision (mint) the authority for an Owner-ratified proposal.
                 * `issueRatifiedRootGrant` resolves the ratification LIVE from
                 * the canonical store and binds it to the exact proposal
                 * digest/revision; a caller-held or forged ratification cannot
                 * mint. Only an APPROVED stored ratification passes.
                 */
                async provisionAuthority({ proposalId, ratificationId, actor = "owner" } = {}) {
                    return canonicalOwner.issueRatifiedRootGrant({
                        proposalId,
                        ratificationId,
                        actor
                    });
                },

                /** Live trust/authority status (read-only). */
                status() {
                    return Object.freeze({
                        marker: "production-owner-trust-composition",
                        authorityBound: isCanonicalAuthorityBound(),
                        authorityDurable: authority.durable,
                        authorityStoreFile: authority.file,
                        ownerTrustComposed: ownerTrust !== null,
                        ownerTrustDurable: ownerTrust ? ownerTrust.durable : false,
                        ownerEnrolled: ownerTrust
                            ? ownerTrust.registry.getOwner() !== null
                            : false,
                        ownerTrustError: ownerTrustError ? String(ownerTrustError.message || ownerTrustError) : null
                    });
                },

                /** Graceful shutdown: release the owner-trust audit sink lock. */
                close() {
                    if (ownerTrust && typeof ownerTrust.close === "function") {
                        ownerTrust.close();
                    }
                }
            });

            productionComposition = comp;
            return comp;
        })();
    }
    return compositionPromise;
}

/**
 * Sync accessor for the already-composed production composition, or null.
 * Use this at route time; use `ensureProductionAuthorityComposed()` at boot.
 */
function getProductionAuthorityComposition() {
    return productionComposition;
}

module.exports = Object.freeze({
    resolveProductionAuthorityStore,
    ensureProductionAuthorityComposed,
    getProductionAuthorityComposition
});
