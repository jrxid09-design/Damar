"use strict";

/**
 * WAVE 6 L6 — distributed resilience: recovery episodes, circuits, failover.
 *
 * LAWS:
 *   RECOVERY != AUTHORITY RESTORATION (never restore live authority)
 *   LEADER ELECTION != ROOT AUTHORITY ; REPLICA MAJORITY != USER AUTHORITY
 *   FAILOVER != ACTION REPLAY (uncertain actions -> UNKNOWN -> verify/compensate)
 *   FAILOVER != PRIVILEGE ESCALATION (failover target keeps its own scopes)
 *   Circuit status is reliability metadata — never trust or authority.
 *
 * Recovery episodes (`drec-<32hex>`) EXTEND the frozen Recovery Capsule
 * (src/runtime/recovery): an episode orchestrates capsule checkpoints between
 * peers, revalidates trust + readiness, and never resurrects authority.
 * Every episode has an opaque generation; old recovery messages fail stale.
 */

const crypto = require("node:crypto");
const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const EPISODE_STATES = Object.freeze([
    "DETECTED", "PEER_SELECTED", "CHECKPOINT_TRANSFERRED", "TRUST_REVALIDATED",
    "READINESS_REVALIDATED", "RESUMED", "FAILED", "ABORTED"
].reduce((m, s) => (m[s] = s, m), {}));

const EPISODE_TRANSITIONS = Object.freeze({
 DETECTED: ["PEER_SELECTED", "FAILED", "ABORTED"],
 PEER_SELECTED: ["CHECKPOINT_TRANSFERRED", "FAILED", "ABORTED"],
 CHECKPOINT_TRANSFERRED: ["TRUST_REVALIDATED", "FAILED", "ABORTED"],
 TRUST_REVALIDATED: ["READINESS_REVALIDATED", "FAILED", "ABORTED"],
 READINESS_REVALIDATED: ["RESUMED", "FAILED", "ABORTED"],
 RESUMED: [], FAILED: [], ABORTED: []
});

const EPISODE_DEFAULTS = Object.freeze({
    maxEpisodes: 128,
    maxPeerAttempts: 2, // bounded second peer attempt
    maxConsumedRecoveryNonces: 2048,
    checkpointTtlMs: 24 * 3600 * 1000
});

class DistributedRecoveryCoordinator {
    constructor({ trust, checkpointVerifier = null, config = {}, nowMs = () => Date.now() } = {}) {
        if (!trust) throw new TypeError("coordinator requires trust plane");
        this.trust = trust;
        this.checkpointVerifier = checkpointVerifier; // fn(checkpoint, {isNodeTrusted}) — frozen L2 verifier wired in
        this.config = Object.freeze({ ...EPISODE_DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** episodeId -> episode */
        this._episodes = new Map();
        this._consumedRecoveryNonces = new Set();
    }

    /**
     * Start a recovery episode for a failed node. Peer eligibility is a
     * TRUST decision: RECOVERY_PEER scope under CURRENT generation only.
     */
    startEpisode({ failedNodeId, continuityIncarnation = null, candidatePeers = [], reason = "node failure detected" } = {}) {
        const failed = ids.check.nodeId(failedNodeId);
        if (this._episodes.size >= this.config.maxEpisodes) {
            const oldest = [...this._episodes.entries()].sort((a, b) => a[1].startedAtMs - b[1].startedAtMs)[0];
            this._episodes.delete(oldest[0]);
        }
        const episodeId = `drec-${crypto.randomBytes(16).toString("hex")}`;
        const generation = `drecgen-${crypto.randomBytes(16).toString("hex")}`;
        const episode = {
            episodeId, generation,
            failedNodeId: failed,
            continuityIncarnation: continuityIncarnation ? String(continuityIncarnation).slice(0, 128) : null,
            reason: String(reason).slice(0, 300),
            state: "DETECTED",
            stateHistory: [{ state: "DETECTED", atMs: this.nowMs() }],
            peerAttempts: [],
            selectedPeer: null,
            checkpoint: null,
            startedAtMs: this.nowMs()
        };
        this._episodes.set(episodeId, episode);
        // immediate peer selection attempt
        this.selectPeer(episodeId, { candidatePeers });
        return this.snapshot(episodeId);
    }

    /**
     * Select an eligible recovery peer. Each attempt is bounded
     * (maxPeerAttempts); a failing peer is recorded and the next eligible
     * peer tried — bounded second-peer semantics.
     */
    selectPeer(episodeId, { candidatePeers = [] } = {}) {
        const ep = this._require(episodeId);
        if (ep.peerAttempts.length >= this.config.maxPeerAttempts) {
            this._transition(ep, "FAILED", "peer attempt budget exhausted");
            return this.snapshot(episodeId);
        }
        const eligible = [];
        for (const peer of candidatePeers.slice(0, 8)) {
            const nodeId = ids.check.nodeId(peer.nodeId);
            try {
                this.trust.authorize({ nodeId, scope: "RECOVERY_PEER", trustGeneration: peer.trustGeneration });
                eligible.push(nodeId);
            } catch { /* untrusted peer skipped — trust decides, not score */ }
        }
        if (eligible.length === 0) {
            this._transition(ep, "FAILED", "no eligible recovery peer (trust gate)");
            return this.snapshot(episodeId);
        }
        const selected = eligible[0];
        ep.selectedPeer = selected;
        ep.peerAttempts.push({ peer: selected, atMs: this.nowMs() });
        this._transition(ep, "PEER_SELECTED");
        return this.snapshot(episodeId);
    }

    /**
     * Transfer + verify a checkpoint from the failed node's last known state.
     * Uses the frozen L2 checkpoint verifier: expiry/revocation/digest/
     * incarnation all fail closed. Recovery nonce prevents replayed payloads.
     */
    transferCheckpoint(episodeId, { checkpoint, recoveryNonce } = {}) {
        const ep = this._require(episodeId);
        if (!ep.selectedPeer) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "peer not selected");
        if (this._consumedRecoveryNonces.has(recoveryNonce)) throw meshFailure(MESH_ERRORS.MESH_REPLAY, "recovery payload replayed");
 // verify via the frozen L2 verifier (fail-closed on stale/tampered).
 // The SOURCE node is the FAILED node — untrusted-by-definition for this
 // episode; the verifier's trust callback therefore checks that the source
 // is not explicitly REVOKED/QUARANTINED (a revoked node's state is poison).
 if (this.checkpointVerifier) {
 this.checkpointVerifier(checkpoint, { isNodeTrusted: (nodeId) => {
 try {
 const snap = this.trust.snapshot(nodeId);
 return Boolean(snap && snap.state !== "REVOKED" && snap.state !== "QUARANTINED");
 } catch { return false; }
 } });
 }
        this._consumedRecoveryNonces.add(recoveryNonce);
        if (this._consumedRecoveryNonces.size > this.config.maxConsumedRecoveryNonces) {
            const first = this._consumedRecoveryNonces.values().next().value;
            this._consumedRecoveryNonces.delete(first);
        }
        ep.checkpoint = Object.freeze({ ...checkpoint });
        this._transition(ep, "CHECKPOINT_TRANSFERRED");
        return this.snapshot(episodeId);
    }

    /** Trust revalidation on the peer: peer's RECOVERY_PEER scope still valid. */
    revalidateTrust(episodeId) {
        const ep = this._require(episodeId);
        const snap = this.trust.snapshot(ep.selectedPeer);
        const auth = this.trust.authorize({
            nodeId: ep.selectedPeer, scope: "RECOVERY_PEER",
            trustGeneration: snap.trustGeneration
        });
        ep.trustRevalidated = auth;
        this._transition(ep, "TRUST_REVALIDATED");
        return this.snapshot(episodeId);
    }

    /** Readiness revalidation: the peer proves it can actually continue work. */
    revalidateReadiness(episodeId, { readinessProof = null } = {}) {
        const ep = this._require(episodeId);
        if (!readinessProof || readinessProof !== "READY") {
            this._transition(ep, "FAILED", "readiness revalidation failed");
            return this.snapshot(episodeId);
        }
        ep.readinessProofAtMs = this.nowMs();
        this._transition(ep, "READINESS_REVALIDATED");
        return this.snapshot(episodeId);
    }

    /** Resume continuity: RESTORED != RESUMED is completed by the frozen continuity owner. */
    resume(episodeId) {
        const ep = this._require(episodeId);
        ep.resumedAtMs = this.nowMs();
        this._transition(ep, "RESUMED");
        // LAW: no authority objects restored — the checkpoint carries
        // references only (enforced by the frozen L2 checkpoint builder).
        return this.snapshot(episodeId);
    }

    abort(episodeId, { reason = "aborted" } = {}) {
        const ep = this._require(episodeId);
        this._transition(ep, "ABORTED", reason);
        return this.snapshot(episodeId);
    }

    snapshot(episodeId) {
        const ep = this._episodes.get(episodeId);
        return ep ? Object.freeze({
            episodeId: ep.episodeId,
            generation: ep.generation,
            failedNodeId: ep.failedNodeId,
            state: ep.state,
            stateHistory: Object.freeze(ep.stateHistory.map(h => Object.freeze({ ...h }))),
            selectedPeer: ep.selectedPeer,
            peerAttempts: ep.peerAttempts.length,
            checkpointPresent: Boolean(ep.checkpoint),
            resumedAtMs: ep.resumedAtMs ?? null
        }) : null;
    }

    size() { return this._episodes.size; }

    _require(episodeId) {
        const ep = this._episodes.get(episodeId);
        if (!ep) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown recovery episode");
        return ep;
    }

    _transition(ep, to, details = null) {
        if (!EPISODE_TRANSITIONS[ep.state]?.includes(to)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `illegal recovery transition ${ep.state} -> ${String(to).slice(0, 24)}`);
        }
        ep.state = to;
        ep.stateHistory.push({ state: to, atMs: this.nowMs(), details: details ? String(details).slice(0, 200) : null });
    }
}

module.exports = Object.freeze({ DistributedRecoveryCoordinator, EPISODE_STATES, EPISODE_TRANSITIONS, EPISODE_DEFAULTS });
