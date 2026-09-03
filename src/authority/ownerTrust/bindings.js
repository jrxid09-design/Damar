"use strict";

/**
 * PRINCIPAL BINDINGS — device membership + transport trust bindings
 * (Wave 5 Lane 4, Stages 6-7).
 *
 * DEVICE MEMBERSHIP (Stage 6):
 *   Reuses DeviceIdentityService and Pairing.  A TRUSTED/PAIRED device is
 *   NEVER automatically an Owner (DEVICE IDENTITY != AUTHORITY; PAIRING !=
 *   AUTHORITY).  For Owner-associated devices:
 *     - the Owner authenticates by proof (existing proof verifier);
 *     - the device was enrolled through the EXISTING pairing mechanics
 *       (beginPairing -> submitChallenge -> ownerConfirm), which minted the
 *       one-time binding credential whose digest the identity service stores;
 *     - this module records the durable principal ↔ device membership
 *       binding, generation-checked;
 *     - reconnect requires the persistent proof: the bindingSecret that
 *       matches the identity service's stored bindingDigest (openSession);
 *     - each device is separately revocable (binding revoke + identity
 *       revoke are distinct operations).
 *
 * TRANSPORT BINDINGS (Stage 7):
 *   A binding means: the canonical transport adapter verified peer P on
 *   transport T, and a valid Owner/Admin ceremony authenticated P as
 *   principal X.  Records: principal, transport, normalized peer, optional
 *   device, generation, verification method, lifecycle, proof reference.
 *   NEVER stores raw credentials/proofs.
 *
 *   CHANNEL ACCOUNT REASSIGNMENT: an old account binding never transfers
 *   trust automatically — rebinding the same peer to another principal is
 *   rejected while the old binding is active; a revoked binding still lets
 *   the transport work as a transport but principal authentication fails.
 *
 * TRANSPORT ID != DAMAR PRINCIPAL: the peer string is transport-owned
 * evidence (e.g. telegram:12345 / whatsapp:…@s.whatsapp.net), never a raw
 * caller-supplied ID as proof.  The binding CEREMONY requires an
 * authenticated Owner/Admin proof; the peer alone can never bind itself.
 */

const PEER_MAX = 128;
const TRANSPORTS = Object.freeze(["console", "telegram", "whatsapp"]);

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/** Normalize a transport peer into canonical `transport:peer` form. */
function normalizePeer({ transport, peer }) {
    if (!TRANSPORTS.includes(transport)) {
        throw fail("OT_TRANSPORT_INVALID", `transport must be one of ${TRANSPORTS.join("|")}`);
    }
    if (typeof peer !== "string" || peer.length === 0 || peer.length > PEER_MAX) {
        throw fail("OT_PEER_INVALID", "peer malformed");
    }
    if (!/^[\x21-\x7E]+$/.test(peer)) {
        throw fail("OT_PEER_INVALID", "peer contains forbidden characters");
    }
    return `${transport}:${peer}`;
}

/**
 * createPrincipalBindings({ registry, proofVerifier })
 *
 *   registry       — OwnerTrustRegistry (bindings storage).
 *   proofVerifier  — the sealed proof verifier.
 */
function createPrincipalBindings({ registry, proofVerifier }) {
    if (!registry || typeof registry.addBinding !== "function") {
        throw fail("OT_BINDINGS_INVALID", "bindings require an OwnerTrustRegistry");
    }
    if (!proofVerifier || typeof proofVerifier.verifyProof !== "function") {
        throw fail("OT_BINDINGS_INVALID", "bindings require a proof verifier");
    }

    /**
     * Verify an Owner/Admin proof and return the verified principalId.
     * Fails closed (throws) unless the proof is genuine, purpose-matched,
     * one-use, unexpired, and the principal is ACTIVE.
     */
    function requireAuthenticatedPrincipal({ proof, purpose }) {
        const verdict = proofVerifier.verifyProof({
            nonce: proof?.nonce,
            signature: proof?.signature,
            expectedPurpose: purpose
        });
        if (!verdict.ok) {
            throw fail(verdict.code ?? "OT_PROOF_INVALID", "binding ceremony requires authenticated proof");
        }
        if (registry.principalState(verdict.principalId) !== "ACTIVE") {
            throw fail("OT_PRINCIPAL_NOT_ACTIVE", "principal is not active");
        }
        return verdict.principalId;
    }

    /**
     * STAGE 6 — bind an Owner-associated device as principal membership.
     *
     * The device must ALREADY be paired through the EXISTING DeviceIdentity
     * pairing mechanics (ownerConfirm minted its bindingDigest); the caller
     * presents the bindingSecret from that ceremony as the device-side proof.
     * The Owner must authenticate by proof.  `identityService.assertBinding`
     * path: we verify the bindingSecret against the identity service (via
     * openSession on a probe session we immediately close) rather than
     * trusting a caller-asserted deviceId.
     *
     * Returns the frozen binding record.
     */
    async function bindOwnerDevice({ proof, deviceId, bindingSecret, identityService }) {
        const principalId = requireAuthenticatedPrincipal({ proof, purpose: "owner-proof" });
        if (typeof deviceId !== "string" || deviceId.length === 0) {
            throw fail("OT_DEVICE_INVALID", "deviceId required");
        }
        if (typeof bindingSecret !== "string" || bindingSecret.length === 0) {
            throw fail("OT_DEVICE_PROOF_REQUIRED", "device bindingSecret required (existing pairing credential)");
        }
        if (!identityService || typeof identityService.openSession !== "function") {
            throw fail("OT_IDENTITY_INVALID", "identityService required");
        }
        // Persistent device proof: the bindingSecret must match the digest
        // minted at ownerConfirm.  openSession throws PID_SESSION_FORGED on a
        // mismatch — that is the fail-closed device-proof check.
        const probe = identityService.openSession({ deviceId, bindingSecret });
        try {
            if (identityService.closeSession) identityService.closeSession(probe.sessionId);
        } catch { /* probe cleanup best-effort */ }

        return registry.addBinding({
            principalId,
            kind: "device",
            peer: `device:${deviceId}`,
            deviceId,
            method: "pairing-binding-secret",
            proofRef: null
        });
    }

    /**
     * Generation check: a binding is current when it was created no earlier
     * than the principal's OWN last security-relevant mutation (credential
     * rotation / revocation bumps the principal's record generation).
     * UNRELATED global mutations (e.g. binding another transport) must NOT
     * stale-out existing bindings.
     */
    function principalGenerationCurrent(binding) {
        const principal = registry.getPrincipal(binding.principalId);
        if (!principal) return false;
        return Number.isSafeInteger(principal.generation) &&
            binding.generation >= principal.generation;
    }

    /**
     * STAGE 6 — verify a device reconnect: binding active + generation
     * current + the persistent proof (bindingSecret) valid at the identity
     * service.  Returns { ok, principalId, deviceId, sessionId } or a
     * fail-closed { ok:false, code }.
     */
    async function verifyDeviceReconnect({ deviceId, bindingSecret, identityService }) {
        const binding = registry.findBinding({ kind: "device", peer: `device:${deviceId}` });
        if (!binding) {
            return Object.freeze({ ok: false, code: "OT_DEVICE_NOT_BOUND" });
        }
        if (binding.revokedAtMs !== null) {
            return Object.freeze({ ok: false, code: "OT_DEVICE_REVOKED" });
        }
        if (!principalGenerationCurrent(binding)) {
            return Object.freeze({ ok: false, code: "OT_GENERATION_STALE" });
        }
        if (registry.principalState(binding.principalId) !== "ACTIVE") {
            return Object.freeze({ ok: false, code: "OT_PRINCIPAL_NOT_ACTIVE" });
        }
        try {
            const session = identityService.openSession({ deviceId, bindingSecret });
            return Object.freeze({
                ok: true, principalId: binding.principalId, deviceId, sessionId: session.sessionId
            });
        } catch {
            return Object.freeze({ ok: false, code: "OT_DEVICE_PROOF_FAILED" });
        }
    }

    /**
     * STAGE 7 — bind a transport peer to a principal.  The ceremony requires
     * an ALREADY authenticated Owner/Admin proof; the peer is transport-owned
     * evidence recorded verbatim (never a raw ID treated as proof).
     * Conflicting active binding of the same peer to another principal is
     * rejected by the registry (no silent trust transfer).
     */
    async function bindTransportPeer({ proof, purpose, transport, peer, deviceId = null }) {
        const principalId = requireAuthenticatedPrincipal({ proof, purpose });
        const normalized = normalizePeer({ transport, peer });
        return registry.addBinding({
            principalId,
            kind: "transport",
            peer: normalized,
            deviceId: deviceId ?? null,
            method: `${transport}-ceremony:${purpose}`,
            proofRef: null
        });
    }

    /**
     * STAGE 7/8-10 — authenticate a transport peer.  The transport adapter
     * presents its OWN verified peer evidence; this looks up the active
     * binding and checks generation + principal state.  Returns
     * { ok, principalId } or { ok:false, code }.  A revoked binding still
     * leaves the transport working — it only stops principal authentication.
     */
    function authenticateTransportPeer({ transport, peer }) {
        let normalized;
        try {
            normalized = normalizePeer({ transport, peer });
        } catch (error) {
            return Object.freeze({ ok: false, code: error.code ?? "OT_PEER_INVALID" });
        }
        const binding = registry.findBinding({ kind: "transport", peer: normalized });
        if (!binding) {
            return Object.freeze({ ok: false, code: "OT_PEER_NOT_BOUND" });
        }
        if (binding.revokedAtMs !== null) {
            return Object.freeze({ ok: false, code: "OT_BINDING_REVOKED" });
        }
        if (!principalGenerationCurrent(binding)) {
            return Object.freeze({ ok: false, code: "OT_GENERATION_STALE" });
        }
        if (registry.principalState(binding.principalId) !== "ACTIVE") {
            return Object.freeze({ ok: false, code: "OT_PRINCIPAL_NOT_ACTIVE" });
        }
        return Object.freeze({ ok: true, principalId: binding.principalId, bindingId: binding.bindingId });
    }

    return Object.freeze({
        bindOwnerDevice,
        verifyDeviceReconnect,
        bindTransportPeer,
        authenticateTransportPeer,
        requireAuthenticatedPrincipal
    });
}

module.exports = Object.freeze({ createPrincipalBindings, normalizePeer, TRANSPORTS });
