"use strict";

/**
 * OWNER TRUST COMPOSITION ROOT — the SEALED canonical Owner/Admin trust
 * composition (Wave 5 Lane 4).
 *
 * This is the single lexical owner that wires:
 *   OwnerTrustRegistry  (trust records, generations, bindings)
 *   + ProofVerifier     (one-use purpose-bound proof verification)
 *   + FirstOwnerBootstrap (sealed local first-Owner ceremony)
 *   + Owner/Admin auth verifier (proof → principal, for the canonical auth
 *     bridge in action/bootstrap.js)
 *
 * LAWS:
 *   PUBLIC DI != TRUST.  PUBLIC IMPORT != TRUST.  PUBLIC FACTORY != ROOT.
 *   Importing or calling this module confers NO trust, NO Authority, NO
 *   authenticated principal.  The ONLY authority it feeds is the canonical
 *   proof VERIFIER that action/bootstrap.js's bootstrap-owned adapter
 *   consults — and that verifier authenticates ONLY a genuine
 *   proof-of-possession (Ed25519 signature over a canonical one-use
 *   challenge).  Raw principal/owner/admin/telegramUserId/jid/deviceId
 *   payload fields are NEVER accepted.
 *
 * The canonical composition's durable Owner trust state lives at the
 * canonical per-user runtime state location (owner-controlled, sealed — not
 * caller-supplied, not channel-supplied, not model-supplied).
 */

const os = require("node:os");
const path = require("node:path");

const {
    createOwnerTrustRegistry,
    createOwnerTrustStore,
    createProofVerifier,
    createFirstOwnerBootstrap,
    createPrincipalBindings,
    createChannelBinders,
    createContinuityLinker,
    canonicalChallenge,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
} = require("./ownerTrust");

// ---------------------------------------------------------------------------
// Canonical production state location (bootstrap-owned; env-overridable for
// tests via DAMAR_OWNER_TRUST_STATE; "memory" disables durability).
// ---------------------------------------------------------------------------
function resolveProductionOwnerTrustStore() {
    const setting = process.env.DAMAR_OWNER_TRUST_STATE;
    if (setting === "memory") return null;
    if (typeof setting === "string" && setting.length > 0) {
        return path.resolve(setting);
    }
    return path.join(os.homedir(), ".damar", "ownertrust-v1.json");
}

// ---------------------------------------------------------------------------
// Canonical composition state (lazily composed, bootstrap-owned).
// ---------------------------------------------------------------------------
let canonicalComposition = null;
let compositionPromise = null;

/**
 * Build the sealed composition: registry + verifier + bootstrap + verifier.
 * `stateFile` is the durable ownerTrust snapshot path (null => in-memory).
 */
async function compose(stateFile) {
    const store = stateFile === null ? null : createOwnerTrustStore(stateFile);
    const clock = () => Date.now();
    const registry = await createOwnerTrustRegistry({ store, clock });
    await registry.restore();
    const proofVerifier = createProofVerifier({ registry, clock });
    const firstOwnerBootstrap = createFirstOwnerBootstrap({ registry, proofVerifier, clock });

    // The per-composition Owner/Admin auth verifier (bound to THIS
    // composition's registry/verifier, never the module-global singleton).
    const authVerifier = makeAuthVerifier(registry, proofVerifier);
    const ownerRatify = makeRatifyAsOwner(registry, proofVerifier);
    const principalBindings = createPrincipalBindings({ registry, proofVerifier });
    const channelBinders = createChannelBinders({ registry, proofVerifier });
    const continuityLinker = createContinuityLinker({ registry, principalBindings });

    return Object.freeze({
        registry, proofVerifier, firstOwnerBootstrap, authVerifier,
        ratifyAsOwner: ownerRatify, principalBindings, channelBinders,
        continuityLinker, store
    });
}

/** Composition-bound Owner ratification gate. */
function makeRatifyAsOwner(registry, proofVerifier) {
    return async function ratifyAsOwner({ authorityRegistry, proof, ratification } = {}) {
        if (!authorityRegistry || typeof authorityRegistry.ratify !== "function") {
            return Object.freeze({ applied: false, reasonCode: "OT_AUTHORITY_INVALID" });
        }
        if (!proof || typeof proof !== "object" || !ratification || typeof ratification !== "object") {
            return Object.freeze({ applied: false, reasonCode: "OT_PROOF_REQUIRED" });
        }
        const verdict = proofVerifier.verifyProof({
            nonce: proof.nonce,
            signature: proof.signature,
            expectedPurpose: "owner-proof"
        });
        if (!verdict.ok) {
            return Object.freeze({ applied: false, reasonCode: verdict.code ?? "OT_PROOF_INVALID" });
        }
        const owner = registry.getOwner();
        if (!owner || owner.principalId !== verdict.principalId ||
            registry.principalState(verdict.principalId) !== "ACTIVE") {
            return Object.freeze({ applied: false, reasonCode: "OT_NOT_OWNER" });
        }
        return authorityRegistry.ratify({
            ratificationId: ratification.ratificationId,
            proposalId: ratification.proposalId,
            ownerIdentity: verdict.principalId,
            decision: ratification.decision,
            expiryAt: ratification.expiryAt ?? null,
            supersedes: ratification.supersedes ?? null
        });
    };
}

/** Shared verifier factory (used by both the canonical singleton and
 *  per-composition roots). */
function makeAuthVerifier(registry, proofVerifier) {    return function ownerAuthVerifier(evidence) {
        if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
            return null;
        }
        const kind = evidence.kind;
        if (kind !== "owner-proof" && kind !== "admin-proof") {
            return null;
        }
        const credentialId = evidence.credentialId;
        const nonce = evidence.nonce;
        const signature = evidence.signature;
        if (typeof credentialId !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
            return null;
        }
        const verdict = proofVerifier.verifyProof({ nonce, signature, expectedPurpose: kind });
        if (!verdict.ok) {
            return null;
        }
        const principal = registry.getPrincipal(verdict.principalId);
        if (!principal || principal.revokedAtMs) {
            return null;
        }
        if (registry.principalState(verdict.principalId) !== "ACTIVE") {
            return null;
        }
        return { principal: verdict.principalId };
    };
}

async function canonical() {
    if (canonicalComposition !== null) return canonicalComposition;
    if (compositionPromise === null) {
        compositionPromise = compose(resolveProductionOwnerTrustStore())
            .then((c) => {
                canonicalComposition = c;
                // Install the canonical Owner/Admin proof verifier into the
                // canonical action facade's bootstrap-owned adapter (sealed,
                // first-wins, non-enumerable).  authority → action require
                // direction (action never requires authority — structural
                // invariant preserved).
                try {
                    const actionBootstrap = require("../action/bootstrap");
                    if (actionBootstrap && typeof actionBootstrap._setOwnerAuthVerifier === "function") {
                        actionBootstrap._setOwnerAuthVerifier(c.authVerifier);
                    }
                } catch { /* adapter stays fail-closed if the seam is unavailable */ }
                return c;
            });
    }
    return compositionPromise;
}

/** Drive canonical composition (called by the canonical host composition). */
async function ensureCanonicalComposed() {
    return canonical();
}

/**
 * OWNER RATIFICATION BRIDGE (Stage 5) — the ONLY canonical production path for
 * Owner ratification into the existing AuthorityRegistry.
 *
 * `AuthorityRegistry.ratify({ ownerIdentity })` historically accepted an
 * unconstrained owner identity STRING.  This bridge hardens the canonical
 * production path: ratification requires a GENUINE authenticated active Owner
 * result — a proof-of-possession verified against the canonical registry —
 * NOT a caller-supplied identity string.
 *
 *   ratifyAsOwner({
 *     authorityRegistry,          // the canonical AuthorityRegistry
 *     proof: { credentialId, nonce, signature },   // owner-proof evidence
 *     ratification: { ratificationId, proposalId, decision, expiryAt?, supersedes? }
 *   })
 *
 * The bridge verifies the proof via the composition's proof verifier (real
 * Ed25519 check, one-use, purpose-bound, expiring), asserts the principal is
 * the ACTIVE Owner, and only then delegates to authorityRegistry.ratify with
 * ownerIdentity = the VERIFIED principalId.  A raw ownerIdentity string, a
 * fake proof, a replay, or a revoked/not-active principal is rejected.
 * AuthorityRegistry grant semantics are NOT redesigned — this is a sealed
 * gate in front of the existing ratify.
 */
async function ratifyAsOwner(args = {}) {
    if (canonicalComposition === null) {
        return Object.freeze({ applied: false, reasonCode: "OT_NOT_COMPOSED" });
    }
    return canonicalComposition.ratifyAsOwner(args);
}

/**
 * resolveOwnerAuthVerifier() — the canonical proof verifier that
 * action/bootstrap.js's bootstrap-owned adapter consults at composition time.
 *
 * Returns a verifier function (evidence) => ({ principal } | null), or null
 * when the canonical composition is not yet composed / no Owner is enrolled
 * (fail-closed).  The verifier authenticates ONLY a genuine
 * proof-of-possession:
 *
 *   evidence = {
 *     kind: "owner-proof" | "admin-proof",
 *     credentialId,
 *     nonce,
 *     signature,          // base64url Ed25519 over canonicalChallenge
 *     context?            // optional device/transport binding context
 *   }
 *
 * On a fully valid, purpose-matching, one-use, non-expired, non-revoked proof
 * for an ACTIVE principal, the verifier returns the verified principalId.
 * Everything else returns null (fail closed).  Raw claimed-principal fields
 * are ignored entirely.
 */
function resolveOwnerAuthVerifier() {
    // Return a verifier that lazily consults the canonical composition at
    // call time, so it works whether the composition was completed before or
    // after the canonical action facade was created.  When no Owner is
    // enrolled (or the composition is absent) it fail-closes to null.
    return function ownerAuthVerifier(evidence) {
        if (canonicalComposition === null) return null;
        const { registry, proofVerifier } = canonicalComposition;
        return makeAuthVerifier(registry, proofVerifier)(evidence);
    };
}

/**
 * composeOwnerTrustForTest({ stateFile }) — SEALED composition-root factory
 * used by the canonical host composition and by tests.  It composes a FRESH
 * registry/verifier/bootstrap over the given durable state file (or memory).
 * This does NOT install anything into the canonical auth adapter; it returns
 * the composition so the sealed host composition can wire it.
 */
async function composeOwnerTrustForTest({ stateFile = null } = {}) {
    return compose(stateFile === null ? null : path.resolve(stateFile));
}

module.exports = Object.freeze({
    resolveProductionOwnerTrustStore,
    resolveOwnerAuthVerifier,
    composeOwnerTrustForTest,
    ensureCanonicalComposed,
    ratifyAsOwner,
    canonicalChallenge,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
});
