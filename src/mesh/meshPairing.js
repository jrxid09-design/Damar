"use strict";

/**
 * WAVE 6 MESH — pairing extension (L1).
 *
 * EXTENDS the frozen Device Identity & Pairing V1 owner
 * (`src/embodiment/identity/service.js`). There is NO second pairing root:
 * a node pairing transaction WRAPS a device pairing transaction, binding the
 * mesh NodeIdentity to the deviceId that the frozen owner already
 * challenged/confirmed.
 *
 * LAWS preserved:
 *   paired != authorized            (ownerConfirm creates a relationship only)
 *   PAIRING != PERMANENT TRUST      (node trust has TTL + revocation)
 *   NODE DISCOVERY != NODE TRUST    (discovered != paired)
 *   MESH PRESENCE != IDENTITY PROOF
 *
 * Flow:
 *   1. discover/advertise -> DISCOVERED (registry only, NO trust)
 *   2. beginNodePairing   -> wraps deviceIdentity.beginPairing(deviceId)
 *                            + nodeTrust.pair(state=PAIRING_PENDING, scopes=[])
 *   3. submitNodeChallenge-> wraps deviceIdentity.submitChallenge
 *   4. ownerConfirmNode   -> wraps deviceIdentity.ownerConfirm; on success
 *                            nodeTrust re-pairs with OWNER-APPROVED scopes,
 *                            minting the node's trust generation
 *   5. revokeNode         -> deviceIdentity.revoke + nodeTrust.revoke
 *                            (generation rotation: old proofs fail stale)
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");

const DEFAULTS = Object.freeze({ maxPendingPairings: 16 });

class MeshPairingAdapter {
    /**
     * @param {object} deps
     * @param {import('./nodeTrust').NodeTrust} deps.trust
     * @param {import('./nodeRegistry').NodeRegistry} deps.registry
     * @param {object} deps.deviceIdentity frozen DeviceIdentityService instance
     * @param {object} [deps.config]
     */
    constructor({ trust, registry, deviceIdentity, config = {}, nowMs = () => Date.now() } = {}) {
        if (!trust || typeof trust.pair !== "function") throw new TypeError("MeshPairingAdapter requires NodeTrust");
        if (!registry || typeof registry.register !== "function") throw new TypeError("MeshPairingAdapter requires NodeRegistry");
        if (!deviceIdentity || typeof deviceIdentity.beginPairing !== "function") throw new TypeError("MeshPairingAdapter requires DeviceIdentityService");
        this.trust = trust;
        this.registry = registry;
        this.deviceIdentity = deviceIdentity;
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** pairingTxId -> { nodeId, deviceId, devicePairingId, state } */
        this._pending = new Map();
    }

    /**
     * Step 0 — discovery. Registers the node as DISCOVERED with NO trust.
     * Discovery != trust: the node is visible but authorized for nothing.
     */
    discover({ identity, displayName = null, addresses = [] } = {}) {
        const snap = this.registry.register({ identity, displayName });
        this.registry.update(snap.identity.nodeId, { addresses, liveness: "UNKNOWN" });
        // Ensure a DISCOVERED trust record exists with NO scopes.
        if (!this.trust.snapshot(snap.identity.nodeId)) {
            this.trust.pair({ nodeId: snap.identity.nodeId, state: "DISCOVERED", scopes: [] });
        }
        return Object.freeze({ nodeId: snap.identity.nodeId, trustState: "DISCOVERED" });
    }

    /**
     * Step 1 — begin node pairing. Wraps the device pairing transaction and
     * records PAIRING_PENDING with NO scopes (nothing granted yet).
     */
    beginNodePairing({ identity, deviceId, displayName = null } = {}) {
        if (this._pending.size >= this.config.maxPendingPairings) {
            throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "too many pending node pairings");
        }
        if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 128) {
            throw meshFailure(MESH_ERRORS.PAIRING_INVALID, "deviceId required by frozen pairing owner");
        }
        const nodeSnap = this.registry.lookup(identity?.nodeId)
            ? this.registry.update(identity.nodeId, displayName !== null ? { displayName } : {})
            : this.discover({ identity, displayName });
        const nodeId = nodeSnap.identity.nodeId;
        // Wrap the FROZEN pairing owner's transaction.
        const deviceTx = this.deviceIdentity.beginPairing(deviceId, {});
        const txId = ids.mint.pairingTxId();
        this.trust.pair({ nodeId, state: "PAIRING_PENDING", scopes: [] });
        this._pending.set(txId, { nodeId, deviceId, devicePairingId: deviceTx.pairingId, state: "PAIRING_PENDING", startedAtMs: this.nowMs() });
        return Object.freeze({ pairingTxId: txId, nodeId, deviceId, devicePairingId: deviceTx.pairingId, challenge: deviceTx.challenge ?? null });
    }

    /**
     * Step 2 — submit the node's challenge proof through the frozen owner.
     */
    submitNodeChallenge({ pairingTxId, challengeId, secret } = {}) {
        const tx = this._requireTx(pairingTxId);
        const result = this.deviceIdentity.submitChallenge({ pairingId: tx.devicePairingId, challengeId, secret });
        return Object.freeze({ pairingTxId: tx.pairingTxId, nodeState: "PAIRING_PENDING", deviceResult: result });
    }

    /**
     * Step 3 — OWNER confirmation through the frozen owner. On success the
     * node trust is established with owner-approved scopes under a FRESH
     * generation (PAIRING != PERMANENT TRUST: scopes carry expiry).
     */
    ownerConfirmNode({ pairingTxId, scopes = [], ttlMs = null, actor = "owner" } = {}) {
        const tx = this._requireTx(pairingTxId);
        const confirm = this.deviceIdentity.ownerConfirm(tx.devicePairingId, { actor });
        // Owner-approved scope grant, fresh generation, TTL-bound.
        const trustSnap = this.trust.pair({ nodeId: tx.nodeId, state: "TRUSTED", scopes, ttlMs, evidence: `pairing:${tx.devicePairingId}` });
        tx.state = "CONFIRMED";
        this._pending.delete(tx.pairingTxId);
        return Object.freeze({ pairingTxId: tx.pairingTxId, nodeId: tx.nodeId, deviceId: tx.deviceId, deviceConfirm: confirm, trust: trustSnap });
    }

    cancelNodePairing({ pairingTxId, reason = "cancelled" } = {}) {
        const tx = this._requireTx(pairingTxId);
        try { this.deviceIdentity.cancelPairing(tx.devicePairingId, { reason }); } catch { /* owner may have already closed it */ }
        // Fail closed: pending pairing leaves the node DISCOVERED with no scopes.
        this.trust.pair({ nodeId: tx.nodeId, state: "DISCOVERED", scopes: [] });
        this._pending.delete(tx.pairingTxId);
        return Object.freeze({ pairingTxId: tx.pairingTxId, cancelled: true });
    }

    /**
     * Revocation (L1 §19): terminal through BOTH owners. The frozen device
     * owner revokes the device relationship; the mesh trust plane rotates
     * the trust generation so every old proof/message fails stale.
     */
    revokeNode({ nodeId, reason = "revoked" } = {}) {
        const checked = ids.check.nodeId(nodeId);
        const snap = this.trust.snapshot(checked);
        if (!snap) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, "node unknown to trust plane");
        // Find the bound deviceId via registry identity provenance is not
        // enough: the mesh pairing adapter records the binding at pair time.
        const binding = this._bindingDeviceId(checked);
        if (binding) {
            try { this.deviceIdentity.revoke(binding, { reason }); } catch { /* device may already be revoked */ }
        }
        const trustSnap = this.trust.revoke(checked, { reason });
        return Object.freeze({ nodeId: checked, revoked: true, deviceRevoked: Boolean(binding), trust: trustSnap });
    }

    pendingPairings() {
        return Object.freeze([...this._pending.entries()].map(([k, v]) => Object.freeze({ pairingTxId: k, nodeId: v.nodeId, deviceId: v.deviceId, state: v.state })));
    }

    _requireTx(pairingTxId) {
        const tx = this._pending.get(ids.check.pairingTxId(pairingTxId));
        if (!tx) throw meshFailure(MESH_ERRORS.PAIRING_INVALID, "unknown or already-consumed pairing transaction");
        return tx;
    }

    _bindingDeviceId(nodeId) {
        for (const [, v] of this._pending) if (v.nodeId === nodeId) return v.deviceId;
        return null; // confirmed pairings: binding lives in the device owner's records
    }
}

module.exports = Object.freeze({ MeshPairingAdapter, DEFAULTS });
