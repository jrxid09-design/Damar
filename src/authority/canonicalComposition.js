"use strict";

/**
 * W6-R5-01 — CANONICAL AUTHORITY COMPOSITION ROOT (single lexical owner).
 *
 * PURPOSE
 *   This module is the ONE lexical compartment where the production
 *   AuthorityRegistry is constructed, marked canonical, installed into the
 *   distributed-execution authority source, and bound to an Evolution pipeline.
 *
 *   NONE of the privileged operations are exported. A repo-local direct
 *   `require("./canonicalComposition")` yields NO minting / marking /
 *   installing primitive — only read-only predicates and bridge accessors.
 *
 * SECURITY MODEL
 *   CONSTRUCTED INSTANCE != CANONICAL OWNER.
 *   `new AuthorityRegistry(...)` from ANY caller is NEVER canonical. Only the
 *   instance constructed INSIDE this closure over the bootstrap-owned store is
 *   marked (closure-private WeakSet in canonicalBrand.js). Cloned/spread/
 *   serialized/monkey-patched copies remain non-canonical (object identity).
 *
 *   - `markCanonicalAuthorityRegistry` (the brand) is consumed ONLY via the
 *     internal require below; it is never on module.exports.
 *   - `installCanonicalAuthorityRegistry` is internal to this module and
 *     called ONLY from `buildCanonicalAuthorityRoot` (the composition closure).
 *   - The production entry `createProductionRuntimeComposition` returns a
 *     completed runtime; it does NOT return any privileged mutator.
 *
 * DEPRECATION / TEST SEAM
 *   The legacy name `composeCanonicalAuthorityRoot` is intentionally gone. A
 *   single TEST-ONLY export `createCanonicalAuthorityRootTestOnly` exists so
 *   the JS repair harness can build isolated canonical owners without importing
 *   a production mutator by name; it is NOT re-exported from any public index
 *   and MUST NOT be used by production code.
 */

const { AuthorityRegistry } = require("./registry");
const { registerCanonicalPredicate } = require("./canonicalBrand");
const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { mintAuthorityArtifact } = require("../dexec/authorityAdapter");

// R5-01: the canonical brand (closure-private WeakSet + marking function) lives
// LEXICALLY in this single production owner module. It is NOT exported. The
// read-only predicate is published to canonicalBrand via registerCanonicalPredicate
// at load time, so downstream modules keep a stable `isCanonicalAuthorityRegistry`
// import without creating a reverse dependency / load cycle.
const CANONICAL_REGISTRIES = new WeakSet();

function markCanonicalAuthorityRegistry(registry) {
    if (registry === null || typeof registry !== "object") {
        throw new TypeError("markCanonicalAuthorityRegistry requires an AuthorityRegistry instance");
    }
    CANONICAL_REGISTRIES.add(registry);
    return registry;
}

function isCanonicalAuthorityRegistry(value) {
    return value !== null && typeof value === "object" && CANONICAL_REGISTRIES.has(value);
}

registerCanonicalPredicate(isCanonicalAuthorityRegistry);

// Module-private canonical authority source state (formerly in dexec/authoritySource).
let _canonicalRegistry = null; // the ONE canonical AuthorityRegistry instance

/**
 * LEXICAL-ONLY: capture the canonical registry produced by the composition
 * closure. A caller-created `new AuthorityRegistry(...)` is NOT canonical, so
 * it cannot be installed. First-wins protects displacement, but the only
 * installable object is the one produced inside buildCanonicalAuthorityRoot.
 */
function installCanonicalAuthorityRegistry(registry) {
    if (!isCanonicalAuthorityRegistry(registry)) {
        throw new TypeError("installCanonicalAuthorityRegistry requires a canonical AuthorityRegistry produced by the composition root");
    }
    if (_canonicalRegistry !== null && _canonicalRegistry !== registry) {
        throw new Error("canonical AuthorityRegistry already bound (the production composition cannot be displaced)");
    }
    _canonicalRegistry = registry;
    return true;
}

/** Whether the canonical authority source has been bound. */
function isCanonicalAuthorityBound() {
    return _canonicalRegistry !== null;
}

/**
 * The module-private canonical bridge — never exported as a mutable object.
 * Every call performs a LIVE evaluation against the bound canonical registry
 * store, so decisions reflect CURRENT grant state (not a caller-held artifact).
 */
function getCanonicalAuthorityBridge() {
    if (_canonicalRegistry === null) {
        throw new Error("canonical AuthorityRegistry not yet bound — router construction before canonical bootstrap is forbidden (R3-01)");
    }
    const registry = _canonicalRegistry;
    return Object.freeze({
        id: "canonical-authority-source",
        async authorize({ intent, capabilityId, toolId, targetNodeId, ttlMs = null, subject = "damar" }) {
            if (!registry.store || typeof registry.store.getCapability !== "function") {
                throw new Error("canonical authority store unavailable (R2-02 fail-closed)");
            }
            const evaluation = await loadAndEvaluateAuthority(registry.store, {
                capabilityId, action: intent.operation, scope: ["."],
                identity: { principal: subject },
                nowMs: Date.now()
            });
            if (!evaluation.allowed) {
                const err = new Error(`canonical authority DENY: ${evaluation.reasonCode}`);
                err.failureClass = "AUTHORITY_DENIED";
                err.reasonCode = evaluation.reasonCode;
                throw err;
            }
            const actionIntentCanonical = JSON.stringify({
                capabilityId: intent.capabilityId, operation: intent.operation,
                arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "",
                createdAtMs: intent.createdAtMs ?? null
            });
            return mintAuthorityArtifact({
                evaluation, actionIntentId: intent.intentId,
                actionIntentCanonical, capabilityId, toolId,
                targetNodeId, ttlMs, nowMs: Date.now()
            });
        },
        verifyArtifact(artifact, facts) {
            return require("../dexec/authorityAdapter").verifyAuthorityArtifact(artifact, facts);
        },
        isCanonicalAuthorityEvaluation(evaluation) {
            return isCanonicalAuthorityEvaluation(evaluation);
        },
        async getCurrentRatification(proposalId) {
            return registry.getCurrentRatification(proposalId);
        }
    });
}

/**
 * LEXICAL-ONLY: construct the one canonical AuthorityRegistry over a
 * bootstrap-owned store and clock, mark it canonical, install it into the
 * module-private distributed authority source, and bind it to an Evolution
 * pipeline when given. Not exported.
 */
function buildCanonicalAuthorityRoot({ store, clock, evolutionPipeline = null, installDistributed = true } = {}) {
    if (!store || typeof store.getCapability !== "function") {
        throw new TypeError("buildCanonicalAuthorityRoot requires a functional store");
    }
    if (!clock || typeof clock.nowIso !== "function" || typeof clock.nowMs !== "function") {
        throw new TypeError("buildCanonicalAuthorityRoot requires a clock { nowIso, nowMs }");
    }
    const registry = markCanonicalAuthorityRegistry(new AuthorityRegistry({ store, clock }));
    if (evolutionPipeline !== null && evolutionPipeline !== undefined) {
        if (typeof evolutionPipeline !== "object") {
            throw new TypeError("evolutionPipeline must be an EvolutionPipeline-shaped object or null");
        }
        evolutionPipeline.authorityRegistry = registry;
    }
    if (installDistributed) {
        installCanonicalAuthorityRegistry(registry);
    }
    return Object.freeze({
        marker: "canonical-authority-root",
        isCanonical: isCanonicalAuthorityRegistry(registry),
        owner: registry
    });
}

/**
 * TEST-ONLY seam (R5-01). Builds an isolated canonical AuthorityRegistry owner
 * for the repair harness. NOT part of any production public surface and MUST
 * NOT be imported by production code. Tests that need a canonical owner call
 * this; production code uses createProductionRuntimeComposition instead.
 *
 * @returns {Promise<{ owner: object, isCanonical: boolean, marker: string }>}
 */
async function createCanonicalAuthorityRootTestOnly({ store, clock, evolutionPipeline = null, installDistributed = true } = {}) {
    const root = buildCanonicalAuthorityRoot({ store, clock, evolutionPipeline, installDistributed });
    return {
        owner: root.owner,
        isCanonical: root.isCanonical,
        marker: root.marker
    };
}

/**
 * R5-03/PRODUCTION ENTRY — the real production composition that establishes a
 * completed runtime. Owner-trust provisioning is performed by the caller
 * (composition wiring) and the canonical authority is constructed HERE, inside
 * the single lexical owner, never returned as a mutator.
 *
 * This is intentionally a thin public facade over buildCanonicalAuthorityRoot +
 * the runtime composition; it returns only completed runtime owners.
 */
function createProductionRuntimeComposition({ store, clock, evolutionPipeline = null } = {}) {
    const root = buildCanonicalAuthorityRoot({ store, clock, evolutionPipeline, installDistributed: true });
    return Object.freeze({
        marker: root.marker,
        isCanonical: root.isCanonical,
        // NOTE: `owner` is exposed read-only for composition wiring (e.g. to
        // grant legitimate scoped authority during owner provisioning) but is
        // NEVER a returned minting/installing primitive.
        canonicalOwner: root.owner,
        getCanonicalAuthorityBridge
    });
}

module.exports = Object.freeze({
    isCanonicalAuthorityRegistry,
    isCanonicalAuthorityBound,
    getCanonicalAuthorityBridge,
    // TEST-ONLY — not a production minting/installing path.
    createCanonicalAuthorityRootTestOnly,
    // PRODUCTION public entry (no privileged mutators returned).
    createProductionRuntimeComposition
});
