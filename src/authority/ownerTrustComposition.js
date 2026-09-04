"use strict";

/**
 * OWNER TRUST COMPOSITION ROOT — the SEALED canonical Owner/Admin trust
 * composition (Wave 5 Lane 4 repair).
 *
 * This is the single lexical owner that wires:
 *   OwnerTrustRegistry   (trust records, generations, bindings)
 *   + ProofVerifier      (one-use purpose-bound proof verification)
 *   + SecretVault        (durable sealed storage for Owner key material)
 *   + AuditLedger + TrustAuditGate (MANDATORY audit path for every trust
 *     mutation, durable, TF-001 auto-resume)
 *   + FirstOwnerBootstrap (ceremony-bound, reservation-guarded, anchored,
 *     vault-backed local first-Owner ceremony)
 *   + Provenance issuers + transport ingress adapters (OT-006)
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
 * SEALING (Gate 1):
 *   - The mint capability for TransportPeerProvenance lives ONLY inside
 *     this composition: `ingress` exposes attach/adapt helpers bound to the
 *     internal issuers; the issuer objects themselves never escape.
 *   - The audit gate is constructed here and injected into the registry;
 *     every trust mutation flows through the canonical ledger.
 *   - The Vault is constructed here (durable mode: file store + production
 *     AES-256-GCM adapter); the bootstrap ceremony receives it internally.
 *
 * The canonical composition's durable Owner trust state lives at the
 * canonical per-user runtime state location (owner-controlled, sealed — not
 * caller-supplied, not channel-supplied, not model-supplied).
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

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

const { createTrustAuditGate } = require("./ownerTrust/trustAuditGate");
const {
    createCanonicalIngressIssuers,
    attachTelegramIngress,
    attachWhatsappIngress,
    mintConsoleProvenance,
    consoleProvenanceMiddleware,
    currentPeerProvenance
} = require("./ownerTrust/transportAdapters");
const { createAuditLedger, createFileAuditSink } = require("../runtime/auditLedger");
const { createSecretVault } = require("../runtime/vault");
const { createFileSecretStore } = require("../runtime/vault/store");
const { createProductionCipherAdapter } = require("../runtime/vaultProviders");

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
// Vault master-key provisioning (OT-005): the canonical composition owns the
// key lifecycle.  A 32-byte random key is created ONCE, atomically, at a
// 0600 path beside the trust state; later compositions load the same key.
// On Windows, POSIX mode bits are not ACL protection (TF-005): the canonical
// composition provisions the file itself and explicitly acknowledges the
// externally-managed platform protection — the key never travels through
// env vars or caller input.
// ---------------------------------------------------------------------------
function provisionVaultMasterKey(keyPath) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    try {
        fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
        try { fs.chmodSync(keyPath, 0o600); } catch { /* best-effort (Windows) */ }
    } catch (error) {
        if (error && error.code !== "EEXIST") throw error;
    }
    return keyPath;
}

// ---------------------------------------------------------------------------
// Canonical composition state (lazily composed, bootstrap-owned).
// ---------------------------------------------------------------------------
let canonicalComposition = null;
let compositionPromise = null;

/**
 * Build the sealed composition.  `stateFile` is the durable ownerTrust
 * snapshot path (null => in-memory test mode).
 *
 * Durable mode wires, beside the snapshot:
 *   <dir>/vault/               — SecretVault file store (Owner key material)
 *   <dir>/vault-master.key     — 0600 AES-256-GCM master key
 *   <dir>/audit-ledger.jsonl   — canonical durable audit ledger
 *   <dir>/ownertrust-initialized.json — OT-002 initialization anchor
 *   <dir>/ownertrust-bootstrap.lock   — OT-003 ceremony reservation
 */
async function compose(stateFile, { forTest = false } = {}) {
    const clock = () => Date.now();
    const durable = stateFile !== null;
    const dir = durable ? path.dirname(stateFile) : null;

    // ---- Vault (OT-005): canonical when durable --------------------------
    let vault;
    if (durable) {
        const keyPath = provisionVaultMasterKey(path.join(dir, "vault-master.key"));
        const cipher = createProductionCipherAdapter({
            keyFile: keyPath,
            allowPlatformManagedKeyFile: process.platform === "win32" ? true : undefined
        });
        vault = createSecretVault({
            store: createFileSecretStore(path.join(dir, "vault"), { cipher }),
            cipher,
            now: clock
        });
    } else {
        // Memory + deterministic test adapter: NON-DURABLE test mode only.
        vault = createSecretVault({ now: clock });
    }

    // ---- Audit ledger + mandatory gate (OT-007 / TF-001) -----------------
    let ledger;
    let auditSink = null;
    if (durable) {
        auditSink = createFileAuditSink(path.join(dir, "audit-ledger.jsonl"));
        ledger = createAuditLedger({
            sink: auditSink,
            resume: auditSink.describeDurable(),   // TF-001: automatic continuation
            clock
        });
    } else {
        ledger = createAuditLedger({ clock });
    }
    const auditGate = createTrustAuditGate({ ledger });

    // ---- Registry ---------------------------------------------------------
    const store = durable ? createOwnerTrustStore(stateFile) : null;
    const registry = await createOwnerTrustRegistry({ store, clock, audit: auditGate.audit });
    await registry.restore();
    const proofVerifier = createProofVerifier({ registry, clock });

    // ---- First-Owner bootstrap (ceremony-bound, vault-backed) -------------
    const firstOwnerBootstrap = createFirstOwnerBootstrap({
        registry, proofVerifier, vault, clock, statePath: stateFile
    });

    // ---- Bindings / binders / linker --------------------------------------
    const principalBindings = createPrincipalBindings({ registry, proofVerifier });
    const channelBinders = createChannelBinders({ registry, proofVerifier });
    const continuityLinker = createContinuityLinker({ registry, principalBindings });

    // ---- Provenance issuers (mint capability NEVER escapes) ---------------
    const ingressIssuers = createCanonicalIngressIssuers();
    const ingress = Object.freeze({
        attachTelegramIngress: ({ service }) => attachTelegramIngress({ service, issuer: ingressIssuers.telegram }),
        attachWhatsappIngress: ({ service }) => attachWhatsappIngress({ service, issuer: ingressIssuers.whatsapp }),
        mintConsoleProvenance: ({ incarnation } = {}) => mintConsoleProvenance({ issuer: ingressIssuers.console, incarnation }),
        consoleProvenanceMiddleware: () => consoleProvenanceMiddleware({ issuer: ingressIssuers.console }),
        currentPeerProvenance
    });

    // TEST-ONLY provenance minting.  The canonical composition NEVER exposes
    // minting; tests need a way to emulate adapter-minted evidence, so the
    // test factory passes forTest and the result carries a clearly-labeled,
    // non-enumerable-freeze-compatible helper.  Production wiring uses
    // comp.ingress only.
    const testMint = forTest
        ? Object.freeze({
            console: (peerKey = "local") => ingressIssuers.console.mint({ peerKey }),
            telegram: (peerKey) => ingressIssuers.telegram.mint({ peerKey }),
            whatsapp: (peerKey) => ingressIssuers.whatsapp.mint({ peerKey })
        })
        : null;

    // The per-composition Owner/Admin auth verifier (bound to THIS
    // composition's registry/verifier, never the module-global singleton).
    const authVerifier = makeAuthVerifier(registry, proofVerifier);
    const ownerRatify = makeRatifyAsOwner(registry, proofVerifier);

    /**
     * VAULT-MODE SELF-PROOF (canonical HTTP surface only): the daemon proves
     * possession of the vault-sealed Owner root by signing a fresh challenge
     * INTERNALLY.  The private key never leaves the vault path; only a valid
     * one-use proof object is returned, consumable by this composition's own
     * verifier.  This is the HTTP analogue of the bootstrap ceremony's
     * internal signature — it exists ONLY where the caller is already
     * token-authenticated on the console surface.
     */
    async function selfSignOwnerProof({ purpose = "owner-proof" } = {}) {
        const owner = registry.getOwner();
        if (!owner || registry.getState() !== "ACTIVE" || !durable) {
            return null;
        }
        const credentialId = owner.credentials[0];
        const cred = registry.getCredential(credentialId);
        if (!cred || cred.vaultRef === null || cred.revokedAtMs !== null) {
            return null;
        }
        const resolved = vault.resolve(`secretref:v1:${cred.vaultRef}:system`);
        if (!resolved || resolved.ok === false || !resolved.value) {
            return null;
        }
        let privatePem = null;
        try {
            privatePem = resolved.value.reveal();
            const challenge = proofVerifier.issueChallenge({ purpose, credentialId });
            const payload = canonicalChallenge({
                purpose: challenge.purpose,
                credentialId: challenge.credentialId,
                nonce: challenge.nonce,
                context: challenge.context
            });
            const signature = crypto.sign(null, payload,
                crypto.createPrivateKey(privatePem)).toString("base64url");
            return Object.freeze({
                kind: purpose, credentialId, nonce: challenge.nonce, signature
            });
        } finally {
            if (typeof privatePem === "string") privatePem = null;
        }
    }

    return Object.freeze({
        registry, proofVerifier, firstOwnerBootstrap, authVerifier,
        ratifyAsOwner: ownerRatify, principalBindings, channelBinders,
        continuityLinker, store, vault, auditGate, ledger, ingress,
        auditSink, selfSignOwnerProof,
        testMint,
        /** Release the audit sink's single-writer lock (graceful shutdown). */
        close() {
            if (auditSink) auditSink.close();
        },
        durable
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
 * proof-of-possession.
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
    return compose(stateFile === null ? null : path.resolve(stateFile), { forTest: true });
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
