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

/**
 * W6-R2-04 REPAIR: `createDistributedRecoveryCoordinator` is the ONLY
 * production construction path. It CLOSES OVER the canonical frozen
 * checkpoint verifier (dstate.checkpoint.verifyCheckpoint) — the verifier
 * is NOT an injectable parameter, so a caller can never substitute
 * `() => true`. There is no constructor export.
 */
function createDistributedRecoveryCoordinator({ trust, config = {}, nowMs = () => Date.now() } = {}) {
 if (!trust) throw new TypeError("coordinator requires trust plane");
 // canonical frozen checkpoint verifier — bound by closure, not injection
 const canonicalVerifier = (checkpoint, opts = {}) => require("../dstate/checkpoint").verifyCheckpoint(checkpoint, opts);
 return new DistributedRecoveryCoordinator({ trust, checkpointVerifier: canonicalVerifier, config, nowMs });
}

class DistributedRecoveryCoordinator {
 /**
 * W6-R2-04: construction is via createDistributedRecoveryCoordinator only
 * (the class is not exported). `checkpointVerifier` is closure-bound to the
 * canonical frozen verifier — no injectable callback exists.
 * Episodes bind: episodeId + generation + source + destination + checkpoint
 * digest; payloads carry a one-use recovery nonce.
 */
 constructor({ trust, checkpointVerifier, config = {}, nowMs = () => Date.now() } = {}) {
 if (!trust) throw new TypeError("coordinator requires trust plane");
 if (typeof checkpointVerifier !== "function") {
 // W6-05: FAIL CLOSED — no verifier, no recovery coordinator
 throw new TypeError("coordinator requires a canonical checkpointVerifier (W6-05: verification is mandatory, no default path)");
 }
 this.trust = trust;
 this.checkpointVerifier = checkpointVerifier;
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
            checkpointVerifier: this.checkpointVerifier,
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
 /**
 * W6-05: checkpoint payload sanitizer — rejects authority grants, raw
 * secrets, reusable leases, and completed-action-resurrected-as-pending
 * BEFORE any state transition.
 */
 _sanitizeCheckpointPayload(checkpoint) {
 const FORBIDDEN = new Set(["authoritygrant", "authority", "grants", "rawsecret", "secret", "secrets", "vaultvalue", "lease", "leases", "executionlease", "reusablelease"]);
 const pending = checkpoint.pendingCognitiveWork ?? [];
 const completed = new Set(checkpoint.verifiedCompletedActionRefs ?? []);
 for (const item of pending) {
 if (completed.has(item)) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `checkpoint resurrects completed action '${String(item).slice(0, 48)}' as pending (MODEL RECOVERY != ACTION REPLAY)`);
 }
 }
 const seen = new WeakSet();
 const walk = (node, path) => {
 if (node === null || typeof node !== "object") return;
 if (seen.has(node)) return;
 seen.add(node);
 for (const key of Object.keys(node)) {
 if (FORBIDDEN.has(String(key).toLowerCase())) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `checkpoint carries forbidden field '${key.slice(0, 32)}' at ${path} (authority/secret/lease payloads never transfer)`);
 }
 walk(node[key], `${path}.${key}`);
 }
 };
 walk(checkpoint, "$");
 }

 /**
 * W6-05: the recovery nonce is BOUND to the full episode context:
 * drec episode + recovery generation + source + destination + checkpoint
 * digest. A nonce for another episode/source/destination/payload fails.
 */
 recoveryNonceBindingFor(ep, checkpoint) {
 if (!checkpoint || typeof checkpoint.integrityDigest !== "string") {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "checkpoint integrityDigest required for nonce binding");
 }
 return sha256Hex({
 episodeId: ep.episodeId, generation: ep.generation,
 sourceNodeId: checkpoint.sourceNodeId,
 destinationNodeId: ep.selectedPeer,
 checkpointDigest: checkpoint.integrityDigest
 }).slice(0, 48);
 }

 transferCheckpoint(episodeId, { checkpoint, recoveryNonce } = {}) {
 const ep = this._require(episodeId);
 if (!ep.selectedPeer) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "peer not selected");
 // W6-05: the selected PEER must STILL hold RECOVERY_PEER under the CURRENT
 // generation at transfer time (peer may have died/been revoked mid-flight
 // — fail closed instead of transferring to an untrusted destination).
 this.trust.authorize({
 nodeId: ep.selectedPeer, scope: "RECOVERY_PEER",
 trustGeneration: this.trust.snapshot(ep.selectedPeer)?.trustGeneration
 });
 // W6-05: MANDATORY verification — no verifier means the coordinator could
 // not be constructed; double enforcement here (fail-closed on tamper,
 // stale generation, wrong source, authority/secret payloads).
 this._sanitizeCheckpointPayload(checkpoint);
 // trust gate: the FAILED source node must not be explicitly revoked —
 // a revoked node's state is poison; a merely failed node's last checkpoint
 // is the legitimate recovery payload.
 const srcSnap = this.trust.snapshot(checkpoint.sourceNodeId);
 if (srcSnap && (srcSnap.state === "REVOKED" || srcSnap.state === "QUARANTINED")) {
 throw meshFailure(MESH_ERRORS.NODE_REVOKED, "checkpoint source node is revoked/quarantined — state is poison");
 }
 // nonce binding: episode + generation + source + destination + digest
 const expectedNonce = this.recoveryNonceBindingFor(ep, checkpoint);
 if (String(recoveryNonce ?? "") !== expectedNonce) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "recovery nonce does not match episode+generation+source+destination+checkpointDigest binding");
 }
 if (this._consumedRecoveryNonces.has(expectedNonce)) throw meshFailure(MESH_ERRORS.MESH_REPLAY, "recovery payload replayed");
 if (typeof ep.checkpointVerifier !== "function") {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canonical checkpoint verifier unavailable — FAIL CLOSED");
 }
 ep.checkpointVerifier(checkpoint, { isNodeTrusted: (nodeId) => {
 try {
 const snap = this.trust.snapshot(nodeId);
 return Boolean(snap && snap.state !== "REVOKED" && snap.state !== "QUARANTINED");
 } catch { return false; }
 } });
 this._consumedRecoveryNonces.add(expectedNonce);
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

module.exports = Object.freeze({ createDistributedRecoveryCoordinator, EPISODE_STATES, EPISODE_TRANSITIONS, EPISODE_DEFAULTS });
