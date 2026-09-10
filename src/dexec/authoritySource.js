"use strict";

/**
 * W6-R2-02 — CANONICAL AUTHORITY SOURCE (module-private).
 *
 * The DistributedExecutionRouter receives authority provenance EXCLUSIVELY
 * through this module. The canonical bridge is bound exactly ONCE to the
 * canonical AuthorityRegistry instance (brand verified via the frozen
 * closure-private WeakSet in authority/registry.js) and performs LIVE
 * evaluation through the frozen loadAndEvaluateAuthority primitive.
 *
 * CALLER-SUPPLIED BRIDGE != CANONICAL AUTHORITY.
 * DUCK TYPE != TRUST. EXPORTED BRAND SYMBOL != SECURITY.
 * A fake object implementing every method is rejected by the brand check.
 * A cloned/spread/serialized canonical bridge is rejected (brand is by
 * object identity in a WeakSet, not structural shape).
 */

const { loadAndEvaluateAuthority, isCanonicalAuthorityEvaluation } = require("../authority/evaluate");
const { isCanonicalAuthorityRegistry } = require("../authority/canonicalOwnership");
const { mintAuthorityArtifact } = require("./authorityAdapter");

let _canonicalRegistry = null; // the ONE canonical AuthorityRegistry instance

/**
 * R3-01 REPAIR: there is NO public first-bind surface. The canonical registry
 * is captured ONLY when the real application composition root produces it via
 * createCanonicalAuthorityRegistry(...) and hands the result to this internal
 * seam. `registry` must be brand-verified (composition-root produced). A
 * caller-created `new AuthorityRegistry(...)` is NOT canonical, so it cannot
 * capture the authority source. First-wins still protects displacement, but
 * the only installable object is the factory-produced owner.
 */
function installCanonicalAuthorityRegistry(registry) {
    if (!isCanonicalAuthorityRegistry(registry)) {
        throw new TypeError("installCanonicalAuthorityRegistry requires a canonical AuthorityRegistry produced by createCanonicalAuthorityRegistry (composition-root ownership)");
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
        /**
         * LIVE evaluation through the frozen owner. The `evaluation` argument
         * is ignored — the router hands us the intent facts and we evaluate
         * against the canonical store NOW. This eliminates the entire class
         * of "forged evaluation object" attacks: the evaluation object the
         * caller holds is NEVER the authority source; the live store is.
         */
        async authorize({ intent, capabilityId, toolId, targetNodeId, ttlMs = null, subject = "damar" }) {
            if (!registry.store || typeof registry.store.getCapability !== "function") {
                throw new Error("canonical authority store unavailable (R2-02 fail-closed)");
            }
            // LIVE evaluation via the frozen primitive, against the canonical store
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
            // mint the binding artifact from the BRANDED evaluation (closed brand)
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
            return require("./authorityAdapter").verifyAuthorityArtifact(artifact, facts);
        },
        isCanonicalAuthorityEvaluation(evaluation) {
            return isCanonicalAuthorityEvaluation(evaluation);
        },
        /** Live owner state query (used by evolution canary too). */
        async getCurrentRatification(proposalId) {
            return registry.getCurrentRatification(proposalId);
        }
    });
}

module.exports = Object.freeze({
    installCanonicalAuthorityRegistry,
    isCanonicalAuthorityBound,
    getCanonicalAuthorityBridge
});
