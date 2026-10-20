"use strict";

/**
 * CANONICAL BOUNDED CLI SESSION (T2) — proof-of-possession + bounded session
 * issuance.
 *
 * This module is NOT a new authority.  It composes the EXISTING canonical
 * contracts and mints nothing that the Authority Gate would accept on its
 * own:
 *
 *   registry       — OwnerTrustRegistry: canonical Owner/principal truth,
 *                    credentials, global trust generation, durable state.
 *   proofVerifier  — the sealed Ed25519 proof verifier: one-time, expiring,
 *                    purpose- and context-bound challenges.
 *   identityService— the Device Identity aggregate: canonical device records
 *                    and the pairing-minted binding credential (device
 *                    proof-of-possession via openSession).
 *
 * TRUST TRANSITION (the only one implemented here):
 *
 *   UNVERIFIED
 *     -> CANONICAL DEVICE PAIRING        (identity service; bindingDigest)
 *     -> OWNER-VERIFIED PROOF            (proofVerifier + ACTIVE Owner match)
 *     -> BOUNDED SESSION                 (expiry + surface scope + generation)
 *     -> EXPIRED / REVOKED               (time, explicit revoke, generation
 *                                         bump, credential/principal revoke)
 *
 * LAWS:
 *   - Device pairing ALONE asserts nothing about ownership: a valid device
 *     proof without a verified Owner proof is refused (OT_PROOF_*).
 *   - A proof that only controls a caller-supplied reference grants nothing:
 *     the proof's nonce/signature must verify against the canonical registry
 *     credential, AND its principal must be the ACTIVE Owner.
 *   - The challenge is bound to the canonical device AND the intended CLI
 *     surface; a challenge minted for one (device, surface) pair cannot be
 *     redeemed for another (OT_PROOF_CONTEXT_MISMATCH).
 *   - Sessions are BOUNDED: expiry, surface scope, and the registry trust
 *     generation captured at issuance.  Any security-relevant registry
 *     mutation (credential rotation/revocation, binding revoke, admin change)
 *     bumps the generation and instantly stales every outstanding session
 *     (OT_GENERATION_STALE) — durable revocation, no stale-authority
 *     resurrection.
 *   - Sessions are NOT durable: restart discards them and their brand, so a
 *     restored process cannot resurrect trust automatically.  Revocation
 *     intent that must survive restart lives in the canonical registry
 *     (credential/principal/binding revocation) AND in canonical Device
 *     Identity state, not here.
 *   - A session is NOT a substitute for live device trust.  Issuance AND
 *     every verification re-read the COMMITTED canonical Device Identity
 *     state through the composition-injected `readCanonicalDevice` reader:
 *     the device must still exist, still be PAIRED, and still carry the
 *     SAME bindingDigest captured at issuance.  A canonical device
 *     revocation therefore stops sessions issued BEFORE the revocation,
 *     including revocations committed by another process.  The reader is
 *     never cached; missing, malformed, or unreadable canonical state fails
 *     closed (OT_IDENTITY_UNAVAILABLE / OT_DEVICE_UNKNOWN).
 *   - `verifySession` is ASYNC because of that live read.  It returns a
 *     Promise; a Promise is never an `ok` verdict, callers must await it.
 *   - This session is NOT an Authority grant.  Every consequential execution
 *     still passes the Manager/Authority Gate and a capability's own
 *     authority evaluation; `verifySession` only tells the caller whether the
 *     proof-of-possession binding is still live and which surface it is
 *     scoped to.
 */

const crypto = require("node:crypto");

const CLAIM_PURPOSE = "cli-session";
const DEFAULT_TTL_MS = 300_000;
const MAX_SESSIONS = 512;
const MAX_TOKEN = 120;
const SURFACE_PATTERN = /^cli:[A-Za-z0-9._-]{1,80}$/;
const BINDING_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function sha256Hex(value) {
    return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

function deny(code) {
    return Object.freeze({ ok: false, code });
}

/** Stable, injective context string binding a proof to one device+surface. */
function surfaceContext({ deviceId, surfaceId }) {
    return `cli-session|surface=${surfaceId}|device=${deviceId}`;
}

function requireTokens({ deviceId, surfaceId }) {
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_TOKEN) {
        throw fail("OT_DEVICE_INVALID", "deviceId required and bounded");
    }
    if (typeof surfaceId !== "string" || !SURFACE_PATTERN.test(surfaceId)) {
        throw fail("OT_SURFACE_INVALID", "surfaceId must be a bounded cli:<name> identifier");
    }
}

/**
 * createCliSessionAuthority({
 *   registry, proofVerifier, readCanonicalDevice, clock, ttlMs
 * })
 *
 * `readCanonicalDevice` is a COMPOSITION-TIME dependency, not caller input:
 * an async (deviceId) => { deviceId, pairingState, bindingDigest } | null
 * that MUST read committed canonical Device Identity state on every call.
 * When it is absent, session issuance and verification fail closed: a
 * session can never be granted or renewed on device identity this authority
 * cannot authoritatively re-check.
 */
function createCliSessionAuthority({
    registry, proofVerifier, readCanonicalDevice = null,
    clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS
} = {}) {
    if (!registry || typeof registry.getOwner !== "function" || typeof registry.getGeneration !== "function") {
        throw fail("OT_SESSION_INVALID", "CLI session authority requires an OwnerTrustRegistry");
    }
    if (!proofVerifier || typeof proofVerifier.issueChallenge !== "function" || typeof proofVerifier.verifyProof !== "function") {
        throw fail("OT_SESSION_INVALID", "CLI session authority requires the sealed proof verifier");
    }
    if (readCanonicalDevice !== null && typeof readCanonicalDevice !== "function") {
        throw fail("OT_IDENTITY_INVALID", "readCanonicalDevice must be an async function or null (fail closed)");
    }
    if (typeof clock !== "function") {
        throw fail("OT_CLOCK_INVALID", "clock must be a function");
    }
    const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;

    // Closure-private session brand: the ONLY writer is the mint path below,
    // the ONLY reader is verifySession.  Nothing is exported, nothing is
    // serialized — a restart yields an empty brand (fail closed).
    const sessionBrand = new WeakSet();
    const sessions = new Map();          // sessionId -> frozen session
    const revokedSessions = new Set();   // explicit revocations (this process)
    const revokedDevices = new Set();

    /**
     * Authoritative live device read for ONE decision.  No cache: a
     * revocation committed after the previous decision is visible here.
     * Every failure path denies; there is no "unknown means trust".
     */
    async function canonicalDevice(deviceId) {
        if (typeof readCanonicalDevice !== "function") {
            return Object.freeze({ ok: false, code: "OT_IDENTITY_UNAVAILABLE" });
        }
        let view;
        try {
            view = await readCanonicalDevice(deviceId);
        } catch {
            return Object.freeze({ ok: false, code: "OT_IDENTITY_UNAVAILABLE" });
        }
        if (view === null || view === undefined) {
            return Object.freeze({ ok: false, code: "OT_DEVICE_UNKNOWN" });
        }
        if (typeof view !== "object" || view.deviceId !== deviceId ||
            typeof view.pairingState !== "string") {
            return Object.freeze({ ok: false, code: "OT_IDENTITY_INVALID" });
        }
        if (view.pairingState === "REVOKED") {
            return Object.freeze({ ok: false, code: "OT_DEVICE_REVOKED" });
        }
        if (view.pairingState !== "PAIRED") {
            return Object.freeze({ ok: false, code: "OT_DEVICE_NOT_PAIRED" });
        }
        if (typeof view.bindingDigest !== "string" || !BINDING_DIGEST_PATTERN.test(view.bindingDigest)) {
            return Object.freeze({ ok: false, code: "OT_IDENTITY_INVALID" });
        }
        return Object.freeze({ ok: true, view });
    }

    function bindingMatches(presentedSecret, canonicalDigest) {
        const presented = Buffer.from(sha256Hex(presentedSecret), "hex");
        const canonical = Buffer.from(canonicalDigest, "hex");
        return presented.length === canonical.length && crypto.timingSafeEqual(presented, canonical);
    }

    function activeOwnerCredential() {
        const owner = registry.getOwner();
        if (!owner || registry.getState() !== "ACTIVE" || registry.principalState(owner.principalId) !== "ACTIVE") {
            throw fail("OT_OWNER_UNAVAILABLE", "no ACTIVE Owner; CLI trust promotion fails closed");
        }
        const credential = registry.getCredential(owner.credentials[0]);
        if (!credential || credential.revokedAtMs !== null) {
            throw fail("OT_CREDENTIAL_REVOKED", "Owner credential is revoked or missing");
        }
        return { owner, credential };
    }

    function sweep(now) {
        for (const [id, rec] of sessions) {
            if (now >= rec.expiresAtMs) sessions.delete(id);
        }
    }

    /**
     * Issue the ONE-TIME challenge, scoped to the canonical device and the
     * intended CLI surface.  Issuing a challenge grants nothing: it is a
     * nonce that only a proof of possession can complete.
     */
    function beginChallenge({ deviceId, surfaceId } = {}) {
        requireTokens({ deviceId, surfaceId });
        const { credential } = activeOwnerCredential();
        const challenge = proofVerifier.issueChallenge({
            purpose: CLAIM_PURPOSE,
            credentialId: credential.credentialId,
            context: surfaceContext({ deviceId, surfaceId })
        });
        return Object.freeze({ ...challenge, deviceId, surfaceId });
    }

    /**
     * Complete the ceremony: canonical Owner proof + device
     * proof-of-possession => one bounded session, or a fail-closed denial.
     */
    async function issueSession({ proof, deviceId, surfaceId, bindingSecret, identityService } = {}) {
        requireTokens({ deviceId, surfaceId });

        if (!proof || typeof proof !== "object") return deny("OT_PROOF_REQUIRED");
        if (!identityService || typeof identityService.openSession !== "function") return deny("OT_IDENTITY_INVALID");
        if (typeof bindingSecret !== "string" || bindingSecret.length === 0) return deny("OT_DEVICE_PROOF_REQUIRED");

        // 1) Owner proof-of-possession: one-use, unexpired, purpose-matched,
        //    bound to THIS device and THIS surface.  A replayed, expired,
        //    wrong-purpose, wrong-device or wrong-surface presentation fails
        //    closed here and mints nothing.
        const verdict = proofVerifier.verifyProof({
            nonce: proof.nonce,
            signature: proof.signature,
            expectedPurpose: CLAIM_PURPOSE,
            expectedContext: surfaceContext({ deviceId, surfaceId })
        });
        if (!verdict.ok) return deny(verdict.code ?? "OT_PROOF_INVALID");

        // 2) EXPLICIT owner authority requirement: a verified non-Owner
        //    (admin) principal does not satisfy CLI trust promotion.
        const owner = registry.getOwner();
        if (!owner || owner.principalId !== verdict.principalId) return deny("OT_NOT_OWNER");
        if (registry.getState() !== "ACTIVE" || registry.principalState(verdict.principalId) !== "ACTIVE") {
            return deny("OT_PRINCIPAL_NOT_ACTIVE");
        }

        // 3) LIVE canonical device trust: the COMMITTED Device Identity
        //    snapshot — never a caller-supplied status or a stale in-memory
        //    aggregate — must still say PAIRED and still carry the digest of
        //    the presented binding secret.  A revocation committed by any
        //    process is observed here before anything is minted.
        const device = await canonicalDevice(deviceId);
        if (!device.ok) return deny(device.code);
        if (!bindingMatches(bindingSecret, device.view.bindingDigest)) return deny("OT_DEVICE_PROOF_FAILED");

        // 4) Device proof-of-possession against the canonical identity
        //    records: openSession verifies bindingSecret against the digest
        //    minted at ownerConfirm and throws PID_SESSION_FORGED otherwise.
        let probe;
        try {
            probe = identityService.openSession({ deviceId, bindingSecret });
        } catch {
            return deny("OT_DEVICE_PROOF_FAILED");
        }
        try { if (probe && identityService.closeSession) identityService.closeSession(probe.sessionId); }
        catch { /* probe cleanup best-effort; the probe is never used as a session */ }

        // 5) Mint the bounded session.
        const now = clock();
        sweep(now);
        if (sessions.size >= MAX_SESSIONS) return deny("OT_SESSION_BOUND_EXCEEDED");
        const session = Object.freeze({
            sessionId: `clisess-${crypto.randomBytes(12).toString("hex")}`,
            principalId: owner.principalId,
            deviceId,
            surfaceId,
            scope: Object.freeze([`cli:${surfaceId.slice(4)}`]),
            credentialId: verdict.credentialId,
            issuedAtMs: now,
            expiresAtMs: now + ttl,
            generation: registry.getGeneration(),
            ownerGeneration: owner.generation,
            bindingDigest: device.view.bindingDigest,
            revision: 1
        });
        sessionBrand.add(session);
        sessions.set(session.sessionId, session);
        return Object.freeze({ ok: true, session });
    }

    /**
     * Revalidate before a sensitive action.  Brand-first; every canonical
     * precondition is re-checked at CALL time, not cached at issuance.
     *
     * ASYNC: the final precondition is a fresh canonical device read, so the
     * caller MUST await the verdict.  A device revoked (committed) after
     * issuance — by this process or another — is refused here.
     */
    async function verifySession(session, { deviceId = null, surfaceId = null } = {}) {
        if (session === null || typeof session !== "object") return deny("OT_SESSION_FORGED");
        if (!sessionBrand.has(session)) return deny("OT_SESSION_FORGED");
        const rec = sessions.get(session.sessionId);
        if (!rec || rec !== session) return deny("OT_SESSION_UNKNOWN");
        const now = clock();
        if (now >= rec.expiresAtMs) {
            sessions.delete(rec.sessionId);
            return deny("OT_SESSION_EXPIRED");
        }
        if (revokedSessions.has(rec.sessionId)) return deny("OT_SESSION_REVOKED");
        if (revokedDevices.has(rec.deviceId)) return deny("OT_DEVICE_REVOKED");
        if (deviceId !== null && rec.deviceId !== deviceId) return deny("OT_SESSION_DEVICE_MISMATCH");
        if (surfaceId !== null && rec.surfaceId !== surfaceId) return deny("OT_SESSION_SURFACE_MISMATCH");

        // Canonical revalidation: generation fence, principal state,
        // credential revocation, Owner identity.
        if (registry.getGeneration() !== rec.generation) return deny("OT_GENERATION_STALE");
        const owner = registry.getOwner();
        if (!owner || owner.principalId !== rec.principalId || owner.generation !== rec.ownerGeneration) {
            return deny("OT_GENERATION_STALE");
        }
        if (registry.getState() !== "ACTIVE" || registry.principalState(rec.principalId) !== "ACTIVE") {
            return deny("OT_PRINCIPAL_NOT_ACTIVE");
        }
        const credential = registry.getCredential(rec.credentialId);
        if (!credential || credential.revokedAtMs !== null) return deny("OT_CREDENTIAL_REVOKED");

        // LIVE device trust, read from committed canonical state on every
        // verification.  This is what makes a canonical revocation effective
        // against sessions issued BEFORE it, with no cache to mask it.
        const device = await canonicalDevice(rec.deviceId);
        if (!device.ok) return deny(device.code);
        if (device.view.bindingDigest !== rec.bindingDigest) return deny("OT_DEVICE_BINDING_CHANGED");

        return Object.freeze({
            ok: true,
            principalId: rec.principalId,
            deviceId: rec.deviceId,
            surfaceId: rec.surfaceId,
            scope: rec.scope,
            sessionId: rec.sessionId,
            expiresAtMs: rec.expiresAtMs
        });
    }

    function revokeSession(sessionId) {
        if (typeof sessionId !== "string" || sessionId.length === 0) return false;
        if (!sessions.has(sessionId)) return false;
        // Keep the record until its natural expiry so a revoked session
        // reports REVOKED (not UNKNOWN) — an explicit revocation must never
        // look like an unrecognised id.
        revokedSessions.add(sessionId);
        return true;
    }

    function revokeDevice(deviceId) {
        if (typeof deviceId !== "string" || deviceId.length === 0) return false;
        revokedDevices.add(deviceId);
        return true;
    }

    return Object.freeze({ beginChallenge, issueSession, verifySession, revokeSession, revokeDevice });
}

module.exports = Object.freeze({ createCliSessionAuthority, CLAIM_PURPOSE, surfaceContext });
