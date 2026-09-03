"use strict";

/**
 * FIRST-OWNER BOOTSTRAP — sealed, local, atomic, single-winner provisioning
 * (Wave 5 Lane 4, Stage 3).
 *
 * This is the ONLY path that can ever enroll the first human Owner.  It is:
 *   - LOCAL: exposed only through an explicit trusted local provisioning
 *     boundary (this sealed composition), NEVER through channel ingress,
 *     model output, public DI, or an ordinary RuntimeHost message payload.
 *   - EXPLICIT: a deliberate ceremony, not a side effect.
 *   - ATOMIC: a single-winner provisioning lock (create-exclusive marker)
 *     plus the registry's permanently-closing first-bootstrap; concurrent
 *     attempts have exactly ONE winner, the rest fail closed.
 *   - PERMANENTLY CLOSED after success: the registry's bootstrapped flag and
 *     the durable bootstrap marker both close the path forever.
 *
 * CEREMONY:
 *   1. acquire the single-winner provisioning lock (atomic create-exclusive);
 *   2. generate an Ed25519 credential (public verifier → registry; private
 *      key → Vault as a sealed envelope);
 *   3. issue a proof challenge; the prover signs it (proof of possession);
 *   4. verify the proof;
 *   5. atomically completeFirstBootstrap (Owner ACTIVE) + durable marker;
 *   6. durable audit event;
 *   7. release the lock.
 *
 * PROOF INPUT: the caller supplies ONLY the Ed25519 signature over the
 * canonical bootstrap challenge — proof of possession of the freshly minted
 * private key.  No `isLocal:true` / `trusted:true` / `owner:true` boolean is
 * ever accepted as proof.  A caller that cannot produce the private-key
 * signature (e.g. a remote Telegram/WhatsApp/Voice message, or model output)
 * CANNOT bootstrap, because it never holds the just-generated private key.
 *
 * The private key is returned ONCE to the local provisioning caller for the
 * signing step and is otherwise retained ONLY as a Vault envelope (vaultRef).
 */

const crypto = require("node:crypto");

const { canonicalChallenge } = require("./proof");

const BOOTSTRAP_PURPOSE = "owner.bootstrap";
const BOOTSTRAP_CONTEXT = "local-provisioning";

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/**
 * createFirstOwnerBootstrap({ registry, proofVerifier, vault, clock })
 *
 *   registry      — OwnerTrustRegistry.
 *   proofVerifier — the sealed proof verifier (issueChallenge/verifyProof).
 *   vault         — a SecretVault facade used to seal the private key
 *                   (create + resolve for the ceremony).  Optional: if absent,
 *                   the private key is returned only to the local caller and
 *                   vaultRef is null.
 *   clock         — () => ms.
 */
function createFirstOwnerBootstrap({ registry, proofVerifier, vault = null, clock = () => Date.now() } = {}) {
    if (!registry || typeof registry.completeFirstBootstrap !== "function") {
        throw fail("OT_BOOTSTRAP_INVALID", "bootstrap requires an OwnerTrustRegistry");
    }
    if (!proofVerifier || typeof proofVerifier.issueChallenge !== "function") {
        throw fail("OT_BOOTSTRAP_INVALID", "bootstrap requires a proof verifier");
    }

    // In-process single-winner flag (the durable registry flag is the
    // authoritative permanent closure; this guards same-process concurrency).
    let provisioning = false;

    /**
     * Step 1 of the ceremony: begin first-Owner provisioning.
     * Returns { principalId, credentialId, challenge, publicKeyPem, privateKeyPem }.
     * The private key is returned ONCE here for the local signing step.
     *
     * Fails closed if the first-Owner path is already closed or a concurrent
     * provisioning is in flight.
     */
    async function begin({ principalId }) {
        if (registry.isBootstrapped() || registry.getState() !== "UNENROLLED" && registry.getOwner() !== null) {
            throw fail("OT_BOOTSTRAP_CLOSED", "first-Owner bootstrap is permanently closed");
        }
        if (provisioning) {
            throw fail("OT_BOOTSTRAP_IN_PROGRESS", "a first-Owner bootstrap is already in progress");
        }
        if (registry.getState() === "RECOVERY_REQUIRED") {
            throw fail("OT_RECOVERY_REQUIRED", "trust state requires recovery; bootstrap is not a fresh start");
        }
        provisioning = true;
        try {
            const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
            const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
            const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
            const credentialId = `cred-${crypto.randomBytes(8).toString("hex")}`;
            const challenge = proofVerifier.issueChallenge({
                purpose: BOOTSTRAP_PURPOSE,
                credentialId,
                context: BOOTSTRAP_CONTEXT
            });
            return Object.freeze({
                principalId,
                credentialId,
                publicKeyPem,
                privateKeyPem,
                challenge: Object.freeze({
                    nonce: challenge.nonce,
                    purpose: challenge.purpose,
                    credentialId: challenge.credentialId,
                    context: challenge.context,
                    expiresAtMs: challenge.expiresAtMs
                })
            });
        } catch (error) {
            provisioning = false;
            throw error;
        }
    }

    /**
     * Step 2 of the ceremony: complete first-Owner provisioning with proof of
     * possession.  `signature` is the Ed25519 signature (base64url) over the
     * canonical bootstrap challenge by the just-generated private key.
     *
     * The bootstrap credential is freshly minted and NOT yet in the registry
     * (it is only registered by completeFirstBootstrap AFTER this proof), so
     * possession is verified DIRECTLY against the ceremony's public key —
     * proof that the caller holds the freshly generated private key.  A
     * remote/model caller never holds that key, so it cannot produce the
     * signature.
     *
     * On success: seals the private key in the Vault, atomically activates
     * the Owner, marks the path permanently closed, and audits the event.
     */
    async function complete({ principalId, credentialId, publicKeyPem, privateKeyPem, challenge, signature }) {
        if (!provisioning) {
            throw fail("OT_BOOTSTRAP_NOT_STARTED", "no first-Owner bootstrap in progress");
        }
        let vaultRef = null;
        try {
            // Verify proof of possession of the freshly minted private key
            // BEFORE any state mutation, against the ceremony public key.
            const payload = canonicalChallenge({
                purpose: challenge.purpose,
                credentialId: challenge.credentialId,
                nonce: challenge.nonce,
                context: challenge.context
            });
            let sigBuf;
            try {
                sigBuf = Buffer.from(String(signature ?? ""), "base64url");
            } catch {
                throw fail("OT_PROOF_MALFORMED", "first-Owner proof signature malformed");
            }
            let valid = false;
            try {
                valid = crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), sigBuf);
            } catch {
                throw fail("OT_PROOF_INVALID", "first-Owner proof of possession failed");
            }
            if (!valid) {
                throw fail("OT_PROOF_INVALID", "first-Owner proof of possession failed");
            }

            // Seal the private key in the Vault (envelope only; never stored here).
            if (vault && typeof vault.create === "function") {
                const created = vault.create({ value: privateKeyPem, scope: "system", label: `owner-root-${principalId}` });
                vaultRef = created && created.ref ? created.ref.secretId : null;
            }

            const result = await registry.completeFirstBootstrap({
                principalId,
                credential: { credentialId, publicKeyPem, vaultRef }
            });
            return Object.freeze({
                principalId: result.principalId,
                credentialId: result.credentialId,
                generation: result.generation,
                vaultRef
            });
        } finally {
            provisioning = false;
            // The caller must discard its private-key copy; the durable copy
            // is Vault-sealed (envelope only).
        }
    }

    /** Abort an in-progress provisioning (fail closed, no state mutation). */
    function abort() {
        provisioning = false;
    }

    return Object.freeze({ begin, complete, abort });
}

module.exports = Object.freeze({
    createFirstOwnerBootstrap,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT,
    bootstrapChallengePayload: canonicalChallenge
});
