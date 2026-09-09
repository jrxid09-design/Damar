"use strict";

/**
 * WAVE 6 R1 (W6-02 integration) — canonical authority bridge.
 *
 * The narrow adapter between the DistributedExecutionRouter and the FROZEN
 * Authority owner. It exists ONLY to hand the router a provenance artifact
 * derived from a BRANDED canonical evaluation; it never mints authority,
 * never accepts caller digests, and never bypasses the store.
 *
 * Production wiring: the Manager's authorized action path constructs the
 * evaluation via `loadAndEvaluateAuthority` (frozen owner) and passes it
 * here — the router cannot receive anything else.
 */

const { mintAuthorityArtifact, isCanonicalAuthorityEvaluation } = require("./authorityAdapter");

function createCanonicalAuthorityBridge({ defaultTtlMs = 60_000 } = {}) {
 return Object.freeze({
 id: "canonical-authority-bridge",
 authorize({ evaluation, actionIntentId, actionIntentCanonical, capabilityId, toolId, targetNodeId, ttlMs = null }) {
 return mintAuthorityArtifact({
 evaluation, actionIntentId, actionIntentCanonical, capabilityId, toolId,
 targetNodeId, ttlMs: ttlMs ?? defaultTtlMs
 });
 },
 isCanonicalAuthorityEvaluation(evaluation) { return isCanonicalAuthorityEvaluation(evaluation); },
 verifyArtifact(artifact, facts) {
 return require("./authorityAdapter").verifyAuthorityArtifact(artifact, facts);
 }
 });
}

module.exports = Object.freeze({ createCanonicalAuthorityBridge });
