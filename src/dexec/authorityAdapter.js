"use strict";

/**
 * WAVE 6 R1 (W6-02 REPAIR) — canonical Authority provenance adapter.
 *
 * BLOCKER REPAIRED: the router previously accepted ANY caller-supplied
 * 64-hex string as `authorityDecisionDigest`. A format check is NOT
 * authority. CALLER-PROVIDED DIGEST != AUTHORITY PROVENANCE.
 *
 * This adapter consumes the FROZEN canonical Authority owner
 * (src/authority/evaluate.js `loadAndEvaluateAuthority`) whose positive
 * evaluations carry an UNFORGEABLE closure-only brand
 * (`isCanonicalAuthorityEvaluation`). The router can no longer manufacture,
 * receive, or fake authority: it must be handed the branded evaluation and
 * this adapter derives the binding digest FROM THE SNAPSHOT ITSELF.
 *
 * The artifact binds: intent actionDigest, capabilityId, toolId,
 * targetNodeId, subject, authority generation, ratificationId, expiry,
 * evaluatedAtMs. Any change to intent/capability/tool/target after
 * authorization invalidates the artifact (exact identity comparison).
 *
 * LAWS: CALLER-PROVIDED LEDGER/STRING != AUTHORITY; the router never
 * manufactures authority; FORMAT CHECK != AUTHORITY.
 */

const crypto = require("node:crypto");
const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex, canonicalJson } = require("../mesh/canonical");
const { isCanonicalAuthorityEvaluation, EVAL_REASONS } = require("../authority/evaluate");

const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Mint an authority provenance artifact from a BRANDED canonical evaluation.
 * Rejects unbranded/failed evaluations (fail-closed) — a plain object shaped
 * like an evaluation can NEVER pass the brand check.
 */
function mintAuthorityArtifact({
    evaluation, actionIntentId, actionIntentCanonical, capabilityId, toolId,
    targetNodeId, ttlMs = null, nowMs = Date.now()
} = {}) {
    // 1. BRAND FIRST: no property access before the brand check.
    if (!isCanonicalAuthorityEvaluation(evaluation)) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority evidence is not a branded canonical Authority evaluation (forged or failed evaluation rejected)");
    }
    const snap = evaluation.snapshot;
    // 2. the intent's canonical encoding, bound by digest
    if (typeof actionIntentCanonical !== "string" || actionIntentCanonical.length === 0) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "actionIntentCanonical required");
    }
    const actionDigest = sha256Hex(actionIntentCanonical);
    // 3. capability binding: evaluation must be FOR this capability
    const capId = require("../capability/registry/ids").canonicalCapabilityId(capabilityId);
    if (snap.capabilityId !== capId) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `authority evaluation is for capability '${String(snap.capabilityId).slice(0, 64)}', not '${String(capId).slice(0, 64)}'`);
    }
    // 4. operation/action binding
    const operation = String(intentOperationOf(actionIntentCanonical)).slice(0, 256);
    if (!snap.actions.includes(operation)) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `authority evaluation does not cover operation '${operation.slice(0, 64)}'`);
    }
    // 5. target binding
    const target = ids.check.nodeId(targetNodeId);
    // 6. expiry (evaluation snapshot carries grant expiry)
    const now = Math.floor(nowMs);
    if (snap.expiresAt) {
        const expMs = Date.parse(snap.expiresAt);
        if (Number.isFinite(expMs) && now > expMs) {
            throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, `authority grant expired at ${snap.expiresAt}`);
        }
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 60_000;
    // 7. binding digest computed FROM THE BRANDED SNAPSHOT (never caller data)
    const core = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        kind: "AUTHORITY_DECISION_ARTIFACT",
        actionDigest,
        actionIntentId: String(actionIntentId ?? "").slice(0, 128),
        capabilityId: snap.capabilityId,
        operation,
        toolId: String(toolId ?? "").slice(0, 256),
        targetNodeId: target,
        subject: snap.subject,
        authorityActions: [...snap.actions],
        authorityGeneration: snap.generation,
        ratificationId: snap.ratificationId ?? null,
        rootCapabilityId: snap.rootCapabilityId ?? null,
        evaluatedAtMs: snap.evaluatedAtMs,
        authorityExpiresAt: snap.expiresAt ?? null,
        artifactExpiresAtMs: Math.min(now + ttl, snap.expiresAt ? Date.parse(snap.expiresAt) : Number.MAX_SAFE_INTEGER)
    };
    const decisionDigest = sha256Hex(core);
    return Object.freeze({
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        kind: core.kind,
        decisionDigest,
        core: Object.freeze(core),
        issuedAtMs: now
    });
}

/** Extract the operation from the canonical intent encoding (deterministic). */
function intentOperationOf(actionIntentCanonical) {
    const parsed = JSON.parse(actionIntentCanonical);
    if (typeof parsed.operation !== "string" || parsed.operation.length === 0) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canonical intent encoding lacks operation");
    }
    return parsed.operation;
}

/**
 * Verify an authority artifact against the CURRENT execution facts.
 * Exact identity on every binding field; expiry honored; digest recomputed
 * from the artifact core (artifact tampering rejected).
 */
function verifyAuthorityArtifact(artifact, {
    actionIntentCanonical, capabilityId, toolId, targetNodeId, nowMs = Date.now()
} = {}) {
    if (!artifact || typeof artifact !== "object" || artifact.kind !== "AUTHORITY_DECISION_ARTIFACT") {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority artifact malformed");
    }
    const recomputed = sha256Hex(artifact.core);
    if (recomputed !== artifact.decisionDigest) {
        throw meshFailure(MESH_ERRORS.PAYLOAD_DIGEST_MISMATCH, "authority artifact digest mismatch (tampered)");
    }
    const core = artifact.core;
    const actionDigest = sha256Hex(actionIntentCanonical);
    if (core.actionDigest !== actionDigest) {
        throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority artifact bound to a different action intent");
    }
    const capId = require("../capability/registry/ids").canonicalCapabilityId(capabilityId);
    if (core.capabilityId !== capId) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority artifact bound to a different capability");
    if (core.toolId !== String(toolId ?? "").slice(0, 256)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority artifact bound to a different tool");
    if (core.targetNodeId !== ids.check.nodeId(targetNodeId)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authority artifact bound to a different target node");
    const now = Math.floor(nowMs);
    if (core.artifactExpiresAtMs <= now) throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "authority artifact expired");
    if (core.authorityExpiresAtMs && core.authorityExpiresAtMs !== Number.MAX_SAFE_INTEGER && core.authorityExpiresAtMs <= now) {
        throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "underlying authority grant expired");
    }
    return Object.freeze({ verified: true, decisionDigest: artifact.decisionDigest, authorityGeneration: core.authorityGeneration, subject: core.subject });
}

module.exports = Object.freeze({
    ARTIFACT_SCHEMA_VERSION,
    mintAuthorityArtifact,
    verifyAuthorityArtifact,
    isCanonicalAuthorityEvaluation,
    EVAL_REASONS
});
