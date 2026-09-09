"use strict";

/**
 * WAVE 6 L2 — distributed state store + conflict handling.
 *
 * A bounded per-node state plane. Holds only REPLICATABLE classes
 * (REPLICATED, EPHEMERAL). SECRET_BOUND / LOCAL_ONLY / AUDIT_IMMUTABLE /
 * OWNER_BOUND values never enter this store as replicatable payloads —
 * OWNER_BOUND state is tracked as REVISION METADATA ONLY (no payload
 * serialization to peers) and conflicts escalate to AUTHORITY_REVALIDATE.
 *
 * APPEND_ONLY families keep a bounded append log per key.
 */

const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const ids = require("../mesh/ids");
const { buildStateEnvelope, canLeaveNode, AUTHORITY_SENSITIVE, REPLICATABLE } = require("./stateEnvelope");
const { reconcile } = require("./reconcile");

const DEFAULTS = Object.freeze({
    maxKeys: 2048,
    maxRevisionsPerKey: 8,      // lineage depth retained
    maxAppendLogPerKey: 256,
    maxConflicts: 256,
    maxOutgoingBuffer: 512
});

class DistributedStateStore {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** stateKey -> { current: envelope, history: [envelope], appendLog: [envelope] } */
        this._keys = new Map();
        /** conflictId -> conflict record (bounded) */
        this._conflicts = new Map();
        /** outgoing replication buffer (bounded) */
        this._outgoing = [];
    }

    /** Local write: build envelope from a local payload and apply. */
    writeLocal({ stateType, stateKey, logicalOwner, sourceNodeId, replicationClass, mergePolicy, payload, causalParents = [], parentRevision = null, ttlMs = null }) {
        if (!canLeaveNode(replicationClass) && replicationClass !== "OWNER_BOUND") {
            // LOCAL_ONLY / SECRET_BOUND / AUDIT_IMMUTABLE never enter the state plane
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `class '${replicationClass}' is not a distributed state plane family`);
        }
        const env = buildStateEnvelope({
            stateType, stateKey, logicalOwner, sourceNodeId, replicationClass, mergePolicy,
            payload, causalParents, parentRevision, ttlMs, nowMs: this.nowMs()
        });
        return this.applyRemote(env);
    }

    /**
     * Apply an inbound (or locally built) envelope with reconciliation.
     * Returns { accepted, resolved, superseded, conflict, outgoing }.
     */
    applyRemote(envelope) {
        if (!envelope || typeof envelope !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "envelope required");
        if (envelope.expiryMs <= this.nowMs()) throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "state revision expired");
        const key = String(envelope.stateKey).slice(0, 256);
        let entry = this._keys.get(key);
        if (!entry) {
            if (this._keys.size >= this.config.maxKeys) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `state store at ${this.config.maxKeys} keys`);
            entry = { current: null, history: [], appendLog: [] };
            this._keys.set(key, entry);
        }
        if (!entry.current) {
            this._accept(key, envelope);
            return { accepted: true, resolved: envelope, superseded: null, conflict: null, outgoing: this._queueOutgoing(envelope) };
        }
        const current = entry.current;
        // identical revision: idempotent
        if (current.revisionId === envelope.revisionId) {
            return { accepted: false, resolved: current, superseded: null, conflict: null, duplicate: true, outgoing: [] };
        }
        const result = reconcile(current, envelope, {});
        if (result.resolved && result.resolved.revisionId !== current.revisionId) {
            this._accept(key, result.resolved, { keepSuperseded: current });
            return { accepted: true, resolved: result.resolved, superseded: current, conflict: result.conflict ?? null, relation: result.relation ?? null, outgoing: this._queueOutgoing(result.resolved) };
        }
 if (result.conflict) {
 this._recordConflict(result.conflict);
 // retain the un-accepted revision so an explicit authority/manual
 // resolution can still pick it as winner (bounded by conflict cap)
 const retained = { ...envelope, revisionSeq: 0 };
 if (result.conflict.leftRevision.revisionId === current.revisionId) {
 result.conflict = Object.freeze({ ...result.conflict, retainedLeft: current, retainedRight: Object.freeze(retained) });
 } else {
 result.conflict = Object.freeze({ ...result.conflict, retainedRight: Object.freeze(retained) });
 }
 this._conflicts.set(result.conflict.conflictId, result.conflict);
 // AUTHORITY_REVALIDATE blocking conflicts also reject the incoming payload
 if (result.conflict.resolutionStatus === "BLOCKING_UNRESOLVED") {
 return { accepted: false, resolved: current, superseded: null, conflict: result.conflict, outgoing: [] };
 }
 // MANUAL_CONFLICT (non-authority): incoming retained as pending conflict, current unchanged
 return { accepted: false, resolved: current, superseded: null, conflict: result.conflict, outgoing: [] };
 }
        // resolved === current (incoming is older/derivative)
        return { accepted: false, resolved: current, superseded: envelope, conflict: null, relation: result.relation ?? null, outgoing: [] };
    }

 /** Conflict resolution by explicit authority re-validation outcome. */
 resolveConflict(conflictId, { winnerRevisionId, evidence, resolverNodeId } = {}) {
 const conflict = this._conflicts.get(conflictId);
 if (!conflict) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown conflict");
 if (conflict.resolutionStatus === "RESOLVED") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "conflict already resolved");
 const entry = this._keys.get(conflict.stateKey);
 const winner = this._findRevision(conflict, winnerRevisionId, entry);
 if (!winner) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "winner revision not present");
 const resolvedConflict = Object.freeze({
 ...conflict,
 resolutionStatus: "RESOLVED",
 resolutionEvidence: Object.freeze({
 winnerRevisionId: String(winnerRevisionId).slice(0, 64),
 resolverNodeId: String(resolverNodeId ?? "unknown").slice(0, 128),
 evidence: String(evidence ?? "").slice(0, 300),
 resolvedAtMs: this.nowMs()
 })
 });
 this._conflicts.set(conflictId, resolvedConflict);
 if (entry.current.revisionId !== winnerRevisionId) {
 this._accept(conflict.stateKey, winner, { keepSuperseded: entry.current });
 }
 return resolvedConflict;
 }

 _findRevision(conflict, winnerRevisionId, entry) {
 if (entry) {
 if (entry.current.revisionId === winnerRevisionId) return entry.current;
 const h = entry.history.find(x => x.revisionId === winnerRevisionId);
 if (h) return h;
 }
 // retained sides of the conflict itself (un-accepted revisions)
 if (conflict.retainedLeft?.revisionId === winnerRevisionId) return conflict.retainedLeft;
 if (conflict.retainedRight?.revisionId === winnerRevisionId) return conflict.retainedRight;
 return null;
 }

    conflicts({ openOnly = true } = {}) {
        const all = [...this._conflicts.values()];
        return Object.freeze((openOnly ? all.filter(c => c.resolutionStatus !== "RESOLVED") : all).map(c => Object.freeze({ ...c })));
    }

    get(stateKey) {
        const entry = this._keys.get(String(stateKey).slice(0, 256));
        return entry?.current ? Object.freeze({ ...entry.current }) : null;
    }

    appendLog(stateKey) {
        const entry = this._keys.get(String(stateKey).slice(0, 256));
        return Object.freeze((entry?.appendLog ?? []).map(e => Object.freeze({ ...e })));
    }

    outgoingBuffer() {
        return Object.freeze([...this._outgoing]);
    }

    flushOutgoing() {
        const out = this._outgoing.splice(0, this._outgoing.length);
        return Object.freeze(out);
    }

    keys() { return Object.freeze([...this._keys.keys()].sort()); }
    size() { return this._keys.size; }

 _accept(key, envelope, { keepSuperseded = null } = {}) {
 const entry = this._keys.get(key);
 // envelope is frozen (immutable revision identity); stamping is done on a
 // detached copy so the canonical revision object is never mutated.
 const seq = (entry.current?.revisionSeq ?? 0) + 1;
 const stamped = Object.freeze({ ...envelope, revisionSeq: seq });
 if (envelope.mergePolicy === "APPEND_ONLY") {
 entry.appendLog.push(stamped);
 if (entry.appendLog.length > this.config.maxAppendLogPerKey) entry.appendLog.shift();
 entry.current = stamped;
 } else {
 if (keepSuperseded) {
 entry.history.unshift(keepSuperseded);
 if (entry.history.length > this.config.maxRevisionsPerKey) entry.history.pop();
 }
 entry.current = stamped;
 }
 }

    _recordConflict(conflict) {
        if (this._conflicts.size >= this.config.maxConflicts) {
            // drop oldest RESOLVED first, else oldest
            const resolved = [...this._conflicts.entries()].find(([, c]) => c.resolutionStatus === "RESOLVED");
            const dropKey = resolved ? resolved[0] : this._conflicts.keys().next().value;
            this._conflicts.delete(dropKey);
        }
        this._conflicts.set(conflict.conflictId, conflict);
    }

    _queueOutgoing(envelope) {
        // only replicatable classes leave the node
        if (!REPLICATABLE.has(envelope.replicationClass)) return [];
        if (this._outgoing.length >= this.config.maxOutgoingBuffer) this._outgoing.shift();
        this._outgoing.push(envelope);
        return [envelope];
    }
}

module.exports = Object.freeze({ DistributedStateStore, DEFAULTS });
