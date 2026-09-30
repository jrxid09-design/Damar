"use strict";

/**
 * DCD ASSURANCE PLANE — verification, evidence, audit, cleanup, rollback.
 *
 * Registers cyber verifiers through the existing verification fabric.
 * DCD mints no T1 (VERIFIED) records. Evidence is append-only and immutable.
 *
 * Invariants enforced here:
 *   DC-03: NO_SECOND_AUDIT_LEDGER
 *   DC-60: NO_TRUSTED_COMPLETION_WITHOUT_REQUIRED_VERIFICATION
 *   DC-61: DCD_OWNS_NO_T1 — verifiers register; T1 comes from verification fabric
 *   DC-62: VERIFICATION_PROFILE_DERIVED_FROM_TIER_NOT_CONFIDENCE
 *   DC-64: CLEANUP_OBLIGATION_BLOCKS_TRUSTED_COMPLETION
 *   DC-73: EVIDENCE_IS_IMMUTABLE_AND_SUPERSEDED — no deletion
 */

const contracts = require("../contracts");
const {
    verifyCompletion, verifyCleanup,
    ALLOWED_TIERS, DCD_FORBIDDEN_TIERS, EPISTEMIC_CLASSES,
} = contracts;

const _verifiers = Object.create(null);  // null-prototype
const _evidence  = Object.create(null);  // null-prototype, append-only

/**
 * Register a cyber verifier descriptor.
 * Descriptor only — the canonical verification fabric owns T1 minting.
 * Returns { ok, errors }.
 */
function registerCyberVerifier(descriptor) {
    const { verifierId, verifies } = descriptor || {};
    if (typeof verifierId !== "string" || !verifierId) {
        return { ok: false, errors: ["verifierId required"] };
    }
    if (!Array.isArray(verifies) || verifies.length === 0) {
        return { ok: false, errors: ["verifies array required"] };
    }
    if (_verifiers[verifierId]) {
        return { ok: false, errors: [`verifier '${verifierId}' already registered`] };
    }
    _verifiers[verifierId] = Object.freeze({
        verifierId,
        verifies: Object.freeze([...verifies]),
        registeredAt: Date.now(),
    });
    return { ok: true, errors: [] };
}

/**
 * Record an evidence item (append-only, DC-73).
 * T1/T3 are forbidden — DC-61, DC-08.
 * Returns { ok, evidenceId, errors }.
 */
function recordEvidence(params) {
    const { evidenceId, kind, sourceRef, observedAt, tier, epistemicClass, supersedes } = params || {};

    if (typeof evidenceId !== "string" || !evidenceId) {
        return { ok: false, evidenceId: null, errors: ["evidenceId required"] };
    }
    if (_evidence[evidenceId]) {
        return { ok: false, evidenceId, errors: [`evidence '${evidenceId}' already recorded`] };
    }
    if (tier && DCD_FORBIDDEN_TIERS.includes(tier)) {
        return { ok: false, evidenceId: null, errors: [`DCD cannot record tier '${tier}' (DC-61/DC-08)`] };
    }
    if (tier && !ALLOWED_TIERS.includes(tier)) {
        return { ok: false, evidenceId: null, errors: [`unknown tier '${tier}'`] };
    }
    // DC-61: VERIFIED is the T1 epistemic class; DCD cannot record it
    if (epistemicClass && !EPISTEMIC_CLASSES.includes(epistemicClass)) {
        return { ok: false, evidenceId: null, errors: [`unknown epistemicClass '${epistemicClass}'`] };
    }
    if (epistemicClass === "VERIFIED") {
        return { ok: false, evidenceId: null, errors: ["DCD cannot record VERIFIED epistemicClass (DC-61: T1 belongs to verification fabric)"] };
    }
    if (!Number.isFinite(observedAt)) {
        return { ok: false, evidenceId: null, errors: ["observedAt must be finite epoch-ms"] };
    }

    _evidence[evidenceId] = Object.freeze({
        evidenceId,
        kind:          typeof kind === "string" && kind ? kind : "OBSERVATION",
        sourceRef:     typeof sourceRef === "string" ? sourceRef : null,
        observedAt,
        tier:          tier || "T7",
        epistemicClass: epistemicClass || "INFERRED",
        supersedes:    typeof supersedes === "string" ? supersedes : null,
        recordedAt:    Date.now(),
    });
    return { ok: true, evidenceId, errors: [] };
}

/**
 * Verify an effect completion claim.
 * DC-61: DCD does not mint T1; the canonical verifier does.
 * DC-62: profile derived from tier, not confidence.
 */
function verifyEffect(profile, evidenceKeys, envelope, capability) {
    return verifyCompletion(profile, evidenceKeys, envelope, capability);
}

/**
 * Check cleanup obligations are satisfied before completion.
 * DC-64: CLEANUP_OBLIGATION_BLOCKS_TRUSTED_COMPLETION
 */
function checkCleanup(envelope, evidenceKeys) {
    return verifyCleanup(envelope, evidenceKeys);
}

function getEvidence(evidenceId) { return _evidence[evidenceId] || null; }
function listVerifiers() { return Object.values(_verifiers); }

module.exports = Object.freeze({
    registerCyberVerifier,
    recordEvidence,
    verifyEffect,
    checkCleanup,
    getEvidence,
    listVerifiers,
});
