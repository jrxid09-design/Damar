"use strict";

/**
 * FIRST-OWNER BOOTSTRAP — durable, atomic, cross-process single-winner,
 * ceremony-bound provisioning (Wave 5 Lane 4 REPAIR: OT-002/003/004/005).
 *
 * This is the ONLY path that can ever enroll the first human Owner.  It is:
 *   - DURABLE: a durable exclusive RESERVATION (create-exclusive lock file,
 *     OS-level O_CREAT|O_EXCL — atomic on POSIX and Windows) guarantees that
 *     of two simultaneous processes exactly ONE may provision; the loser
 *     fails deterministically.  No in-process boolean can be confused for
 *     cross-process ownership.
 *   - ANCHORED: on successful enrollment an independent durable
 *     INITIALIZATION ANCHOR is written.  Loss/corruption of the primary
 *     snapshot afterwards yields RECOVERY_REQUIRED — never a fresh install
 *     (OT-002).
 *   - CEREMONY-BOUND (OT-004): begin() creates PRIVATE ceremony state owned
 *     by this boundary: ceremonyId, principalId, credentialId, public
 *     verifier, challenge, purpose, issued/expires, reservation identity and
 *     generation expectation.  complete() accepts ONLY the ceremonyId (vault
 *     mode) or ceremonyId + signature (external mode).  EVERY
 *     security-relevant field used to create the Owner comes from the
 *     private begin-state; caller substitution of principal/credential/key/
 *     challenge/purpose/reservation is structurally impossible.  Ceremony
 *     state is one-use, expiring, non-replayable.
 *   - VAULT-BACKED (OT-005): in the canonical "damar-vault" mode Damar
 *     mints the Ed25519 root key internally, signs its own challenge
 *     internally, and seals the private key into the Vault at completion.
 *     The private key NEVER enters the registry, the audit ledger, ordinary
 *     results, logs, or the bootstrap return value.  The registry stores a
 *     public verifier descriptor + Vault reference only.  The explicit
 *     "external" mode supports platform-managed keys: Damar NEVER possesses
 *     the private key; the external holder signs the challenge (real proof
 *     of possession) and no Vault ref is fabricated.
 *   - PERMANENTLY CLOSED after success (registry flag + anchor + closure of
 *     the reservation path).
 *
 * CRASH BEHAVIOR: a crash between begin() and complete() leaves the
 * reservation lock on disk; bootstrap attempts fail with OT_RESERVATION_HELD
 * until the lease expires, after which a NEW ceremony may reclaim it via an
 * ownership-validated replace (never a live steal, never age-only deletion).
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const { canonicalChallenge } = require("./proof");
const anchor = require("./initAnchor");
const reservation = require("./reservation");

const BOOTSTRAP_PURPOSE = "owner.bootstrap";
const BOOTSTRAP_CONTEXT = "local-provisioning";
const CEREMONY_TTL_MS = 120_000;
const PROVISIONING_MODES = Object.freeze(["damar-vault", "external"]);

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/**
 * createFirstOwnerBootstrap({ registry, proofVerifier, vault, clock,
 *                             statePath, leaseMs })
 *
 *   registry       — OwnerTrustRegistry.
 *   proofVerifier  — sealed proof verifier (issues the ceremony challenge).
 *   vault          — SecretVault facade (REQUIRED for "damar-vault" mode;
 *                    ignored for "external" mode).
 *   clock          — () => ms.
 *   statePath      — durable snapshot path.  null (memory) disables the
 *                    durable reservation + anchor: that mode is a NON-DURABLE
 *                    test/isolated mode and is documented as such.
 *   leaseMs        — reservation lease (default from reservation module).
 */
function createFirstOwnerBootstrap({
    registry, proofVerifier, vault = null, clock = () => Date.now(),
    statePath = null, leaseMs = reservation.DEFAULT_LEASE_MS
} = {}) {
    if (!registry || typeof registry.completeFirstBootstrap !== "function") {
        throw fail("OT_BOOTSTRAP_INVALID", "bootstrap requires an OwnerTrustRegistry");
    }
    if (!proofVerifier || typeof proofVerifier.issueChallenge !== "function") {
        throw fail("OT_BOOTSTRAP_INVALID", "bootstrap requires a proof verifier");
    }

    // PRIVATE ceremony state — owned lexically by this boundary.  Never
    // returned to any caller.  Keyed by the opaque ceremonyId.
    let ceremony = null;

    function sweepCeremony(now) {
        if (ceremony && (ceremony.used || now >= ceremony.expiresAtMs)) {
            if (ceremony.used && ceremony.reservationIdentity) {
                reservation.releaseReservation({
                    snapshotPath: statePath, ceremonyId: ceremony.reservationIdentity
                });
            }
            ceremony = null;
        }
    }

    function assertNeverInitialized() {
        if (registry.isBootstrapped() || registry.getOwner() !== null) {
            throw fail("OT_BOOTSTRAP_CLOSED", "first-Owner bootstrap is permanently closed");
        }
        if (registry.getState() === "RECOVERY_REQUIRED") {
            throw fail("OT_RECOVERY_REQUIRED", "trust state requires recovery; bootstrap is not a fresh start");
        }
        if (statePath !== null) {
            const snapshotExists = fs.existsSync(statePath);
            // snapshotOk=false unless the registry is genuinely usable AND
            // (if a snapshot file exists) it was restored from it.
            const snapshotOk = registry.getState() === "ACTIVE" || !snapshotExists;
            const domain = anchor.resolveDomainState({ snapshotPath: statePath, snapshotOk, snapshotExists });
            if (domain.state === "RECOVERY_REQUIRED") {
                throw fail("OT_RECOVERY_REQUIRED",
                    "initialization anchor present but primary state unusable; recovery required");
            }
        }
    }

    /**
     * Begin the ceremony.  Acquires the durable cross-process reservation
     * FIRST, then mints all ceremony material PRIVATELY.
     *
     * mode "damar-vault" (default): Damar mints the root keypair internally,
     *   signs the challenge internally, and seals the key in the Vault at
     *   completion.  Caller receives ceremonyId + challenge ONLY.
     * mode "external": the caller supplies publicKeyPem of a key Damar will
     *   NEVER possess; complete() requires the external signature.
     *
     * Public result: { ceremonyId, challenge, expiresAtMs, mode }.
     */
    async function begin({ principalId, mode = "damar-vault", publicKeyPem = null } = {}) {
        sweepCeremony(clock());
        if (ceremony) {
            throw fail("OT_BOOTSTRAP_IN_PROGRESS", "a first-Owner bootstrap ceremony is already in progress");
        }
        // Closure/recovery is checked BEFORE material requirements: a closed
        // path must report OT_BOOTSTRAP_CLOSED regardless of mode or vault.
        assertNeverInitialized();
        if (typeof mode !== "string" || !PROVISIONING_MODES.includes(mode)) {
            throw fail("OT_CEREMONY_INVALID", "provisioning mode must be damar-vault|external");
        }
        if (mode === "damar-vault" && (!vault || typeof vault.create !== "function")) {
            throw fail("OT_VAULT_REQUIRED", "damar-vault provisioning requires the Secret Vault");
        }
        if (mode === "external" && (typeof publicKeyPem !== "string" || publicKeyPem.length === 0)) {
            throw fail("OT_CREDENTIAL_INVALID", "external provisioning requires the platform public key");
        }

        // Durable cross-process reservation FIRST (OT-003).  Losers fail
        // deterministically here — before any key material exists.
        let reservationIdentity = null;
        if (statePath !== null) {
            const res = reservation.acquireReservation({ snapshotPath: statePath, leaseMs, now: clock });
            reservationIdentity = res.ceremonyId;
        }

        try {
            const now = clock();
            let privateKeyPem = null;
            let credentialPublicKeyPem = publicKeyPem;
            if (mode === "damar-vault") {
                const pair = crypto.generateKeyPairSync("ed25519");
                credentialPublicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
                privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
            }
            const credentialId = `cred-${crypto.randomBytes(8).toString("hex")}`;
            const challenge = proofVerifier.issueChallenge({
                purpose: BOOTSTRAP_PURPOSE,
                credentialId,
                context: BOOTSTRAP_CONTEXT
            });
            // Vault mode: Damar proves possession of its OWN freshly minted
            // key, internally.  The signature never leaves this boundary.
            let internalSignature = null;
            if (mode === "damar-vault") {
                const payload = canonicalChallenge({
                    purpose: challenge.purpose,
                    credentialId: challenge.credentialId,
                    nonce: challenge.nonce,
                    context: challenge.context
                });
                internalSignature = crypto.sign(null, payload,
                    crypto.createPrivateKey(privateKeyPem)).toString("base64url");
            }
            ceremony = {
                ceremonyId: `cer-${crypto.randomBytes(12).toString("hex")}`,
                mode,
                principalId,                    // from the begin() argument ONLY
                credentialId,
                publicKeyPem: credentialPublicKeyPem,
                privateKeyPem,                  // vault mode only; sealed+zeroed at complete
                challenge: Object.freeze({
                    nonce: challenge.nonce,
                    purpose: challenge.purpose,
                    credentialId: challenge.credentialId,
                    context: challenge.context,
                    expiresAtMs: challenge.expiresAtMs
                }),
                internalSignature,
                issuedAtMs: now,
                expiresAtMs: Math.floor(now) + CEREMONY_TTL_MS,
                used: false,
                reservationIdentity,
                generationExpectation: registry.getGeneration()
            };
            return Object.freeze({
                ceremonyId: ceremony.ceremonyId,
                mode,
                challenge: ceremony.challenge,
                expiresAtMs: ceremony.expiresAtMs
            });
        } catch (error) {
            if (reservationIdentity !== null) {
                try {
                    reservation.releaseReservation({ snapshotPath: statePath, ceremonyId: reservationIdentity });
                } catch { /* best effort */ }
            }
            throw error;
        }
    }

    /**
     * Complete the ceremony.  Caller submits ONLY { ceremonyId } (vault mode)
     * or { ceremonyId, signature } (external mode).  Every security-relevant
     * field is taken from the PRIVATE ceremony state; exact linkage is
     * verified before any mutation.  One-use; expiring; non-replayable.
     *
     * Commit order (durable): verify reservation ownership → verify
     * never-initialized → verify generation expectation → verify possession →
     * registry commit (snapshot persist) → write initialization anchor →
     * release reservation.  A failure after the registry commit surfaces
     * explicitly (OT_ANCHOR_WRITE_FAILED); on restart that state resolves to
     * RECOVERY_REQUIRED — never a fresh install.
     */
    async function complete({ ceremonyId, signature = null } = {}) {
        const now = clock();
        sweepCeremony(now);
        if (!ceremony || ceremony.used) {
            throw fail("OT_CEREMONY_UNKNOWN", "no usable first-Owner bootstrap ceremony");
        }
        if (typeof ceremonyId !== "string" || ceremonyId !== ceremony.ceremonyId) {
            throw fail("OT_CEREMONY_UNKNOWN", "ceremony linkage mismatch");
        }
        if (now >= ceremony.expiresAtMs) {
            ceremony = null;
            throw fail("OT_CEREMONY_EXPIRED", "bootstrap ceremony expired");
        }
        if (ceremony.mode === "external") {
            if (typeof signature !== "string" || signature.length === 0) {
                throw fail("OT_PROOF_REQUIRED", "external provisioning requires the challenge signature");
            }
        } else if (signature !== null) {
            // Vault mode: no caller signature is accepted at all.
            throw fail("OT_PROOF_UNEXPECTED", "vault-mode completion takes no caller signature");
        }

        // Reservation ownership (durable mode) — the commit must still own it.
        if (statePath !== null && ceremony.reservationIdentity !== null) {
            reservation.verifyOwnership({
                snapshotPath: statePath, ceremonyId: ceremony.reservationIdentity, now: () => now
            });
        }
        // Domain must STILL be never-initialized (no concurrent owner, no
        // racing anchor).
        assertNeverInitialized();
        // No concurrent trust mutation during the ceremony.
        if (registry.getGeneration() !== ceremony.generationExpectation) {
            throw fail("OT_CEREMONY_RACED", "trust state changed during the bootstrap ceremony");
        }

        // Possession verification against the PRIVATE ceremony key material.
        const payload = canonicalChallenge({
            purpose: ceremony.challenge.purpose,
            credentialId: ceremony.challenge.credentialId,
            nonce: ceremony.challenge.nonce,
            context: ceremony.challenge.context
        });
        const signatureB64 = ceremony.mode === "external" ? signature : ceremony.internalSignature;
        let sigBuf;
        try {
            sigBuf = Buffer.from(String(signatureB64 ?? ""), "base64url");
        } catch {
            throw fail("OT_PROOF_MALFORMED", "first-Owner proof signature malformed");
        }
        let valid = false;
        try {
            valid = crypto.verify(null, payload, crypto.createPublicKey(ceremony.publicKeyPem), sigBuf);
        } catch {
            throw fail("OT_PROOF_INVALID", "first-Owner proof of possession failed");
        }
        if (!valid) {
            throw fail("OT_PROOF_INVALID", "first-Owner proof of possession failed");
        }

        // Vault sealing (vault mode): the private key is sealed and NEVER
        // returned; only the reference reaches the registry descriptor.
        let vaultSecretId = null;
        if (ceremony.mode === "damar-vault") {
            const created = vault.create({
                value: ceremony.privateKeyPem,
                scope: "system",
                label: `owner-root-${ceremony.principalId}`
            });
            vaultSecretId = created && created.ref ? String(created.ref.secretId) : null;
            if (typeof vaultSecretId !== "string" || vaultSecretId.length === 0) {
                throw fail("OT_VAULT_SEAL_FAILED", "vault did not return a usable secret reference");
            }
        }

        try {
            const result = await registry.completeFirstBootstrap({
                principalId: ceremony.principalId,
                credential: {
                    credentialId: ceremony.credentialId,
                    publicKeyPem: ceremony.publicKeyPem,
                    vaultRef: vaultSecretId,
                    source: ceremony.mode
                }
            });
            ceremony.used = true;
            const completedMode = ceremony.mode;
            // Independent durable anchor — after the Owner commit.  Partial
            // failure here is surfaced, never swallowed.
            if (statePath !== null) {
                try {
                    anchor.writeAnchor(statePath, {
                        principalId: ceremony.principalId, now
                    });
                } catch (error) {
                    if (error && error.code === "OT_ANCHOR_EXISTS") {
                        throw fail("OT_CEREMONY_RACED", "initialization anchor already exists");
                    }
                    throw fail("OT_ANCHOR_WRITE_FAILED",
                        `owner committed but initialization anchor failed: ${error.message}`);
                }
                reservation.releaseReservation({
                    snapshotPath: statePath, ceremonyId: ceremony.reservationIdentity
                });
            }
            // Zero the private-key copy held by the ceremony, then drop it.
            if (ceremony.privateKeyPem !== null) {
                try { ceremony.privateKeyPem = null; } catch { /* frozen-safe */ }
            }
            ceremony = null;
            return Object.freeze({
                principalId: result.principalId,
                credentialId: result.credentialId,
                generation: result.generation,
                mode: completedMode,
                vaultRef: vaultSecretId
            });
        } finally {
            if (ceremony && ceremony.used) {
                if (statePath !== null && ceremony.reservationIdentity !== null) {
                    try {
                        reservation.releaseReservation({
                            snapshotPath: statePath, ceremonyId: ceremony.reservationIdentity
                        });
                    } catch { /* best effort */ }
                }
                ceremony = null;
            }
        }
    }

    /** Abort an in-progress ceremony: drop state, release reservation. */
    function abort({ ceremonyId } = {}) {
        if (!ceremony || (ceremonyId !== undefined && ceremonyId !== ceremony.ceremonyId)) {
            return false;
        }
        if (statePath !== null && ceremony.reservationIdentity !== null) {
            reservation.releaseReservation({
                snapshotPath: statePath, ceremonyId: ceremony.reservationIdentity
            });
        }
        ceremony = null;
        return true;
    }

    return Object.freeze({ begin, complete, abort });
}

module.exports = Object.freeze({
    createFirstOwnerBootstrap,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT,
    CEREMONY_TTL_MS,
    PROVISIONING_MODES,
    bootstrapChallengePayload: canonicalChallenge
});
