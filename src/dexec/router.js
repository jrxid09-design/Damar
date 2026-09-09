"use strict";

/**
 * WAVE 6 L3 — DistributedExecutionRouter + execution lifecycle store.
 *
 * Placement: AFTER the canonical Authority gate, BEFORE actuation dispatch.
 * The router NEVER grants authority — it selects a trusted node for an
 * already-authorized intent and mints a bound lease.
 *
 * Eligibility (hard constraints, in order):
 *   1. node registered + liveness not OFFLINE (unless local fallback allowed)
 *   2. trust scope (COMPUTE or TOOL_EXECUTION) authorized under CURRENT generation
 *   3. capability available on node (advertisement matches capabilityId+incarnation)
 * Hard constraints can NEVER be bypassed by score.
 *
 * Routing score (deterministic, only among ELIGIBLE nodes): resource headroom,
 * data locality, privacy fit, latency, reliability history. Privacy: input
 * carrying PRIVATE/SECRET_REFERENCE data only routes to nodes with matching
 * locality permission.
 *
 * UNKNOWN_EXECUTION_STATE: timeout-after-dispatch does NOT retry — it moves
 * the execution to UNKNOWN; verification/compensation decides (FAILOVER !=
 * ACTION REPLAY).
 */

const crypto = require("node:crypto");
const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const contracts = require("./contracts");
const { sha256Hex } = require("../mesh/canonical");

const PRIVACY_CLASSES = Object.freeze(["PUBLIC", "INTERNAL", "PRIVATE", "SECRET_REFERENCE"].reduce((m, c) => (m[c] = c, m), {}));

/** Node locality permission: which privacy classes may be routed to it. */
const DEFAULT_LOCALITY = Object.freeze({
    DESKTOP_PRIMARY: ["PUBLIC", "INTERNAL", "PRIVATE", "SECRET_REFERENCE"],
    DESKTOP_SECONDARY: ["PUBLIC", "INTERNAL", "PRIVATE", "SECRET_REFERENCE"],
    PORTABLE_CORE: ["PUBLIC", "INTERNAL", "PRIVATE"],
    EDGE_LOW_POWER: ["PUBLIC", "INTERNAL"],
    SERVER_PRIVATE: ["PUBLIC", "INTERNAL", "PRIVATE"],
    REMOTE_COMPUTE: ["PUBLIC", "INTERNAL"],
    TEMPORARY_NODE: ["PUBLIC"]
});

const DEFAULTS = Object.freeze({
    dispatchTimeoutMs: 15_000,
    maxConsumedNonces: 4096,
    maxExecutionsTracked: 1024
});

class DistributedExecutionRouter {
    constructor({ trust, registry, config = {}, nowMs = () => Date.now(), authorityDecisionDigest = null } = {}) {
        if (!trust) throw new TypeError("router requires trust plane");
        if (!registry) throw new TypeError("router requires node registry");
        this.trust = trust;
        this.registry = registry;
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        this.authorityDecisionDigest = authorityDecisionDigest; // injected trusted digest source
        /** nodeId -> { advertisement } */
        this._advertisements = new Map();
        /** executionId -> execution record */
        this._executions = new Map();
        /** consumed one-use nonces (bounded) */
        this._consumedNonces = new Set();
        /** nodeId -> reliability { success, failure } (bounded per node) */
        this._reliability = new Map();
    }

    /** Node capability advertisement — availability metadata ONLY. */
    advertise({ nodeId, capabilities, resources = {}, profile = "DESKTOP_PRIMARY" }) {
        const checked = ids.check.nodeId(nodeId);
        if (!Array.isArray(capabilities)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "capabilities must be an array");
        if (capabilities.length > 64) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "advertisement exceeds 64 capabilities");
        const clean = capabilities.map(c => {
            if (!c || typeof c !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "capability entry must be an object");
            return Object.freeze({
                capabilityId: String(c.capabilityId ?? "").slice(0, 256),
                incarnationId: c.incarnationId ? String(c.incarnationId).slice(0, 64) : null,
                toolId: String(c.toolId ?? "").slice(0, 256),
                health: c.health === "DEGRADED" ? "DEGRADED" : "HEALTHY",
                latencyScore: Number.isFinite(c.latencyScore) ? Math.max(0, Math.min(100, c.latencyScore)) : 50,
                privacy: PRIVACY_CLASSES[c.privacy] ? c.privacy : "INTERNAL"
            });
        });
        this._advertisements.set(checked, Object.freeze({ capabilities: Object.freeze(clean), resources, profile: String(profile).slice(0, 32) }));
        return this.advertisement(checked);
    }

    advertisement(nodeId) {
        const a = this._advertisements.get(ids.check.nodeId(nodeId));
        return a ? Object.freeze({ ...a, capabilities: Object.freeze([...a.capabilities]) }) : null;
    }

    reliability(nodeId) {
        return Object.freeze({ ...(this._reliability.get(ids.check.nodeId(nodeId)) ?? { success: 0, failure: 0 }) });
    }

    /**
     * Route an ALREADY-AUTHORIZED intent.
     * `authorizedIntent` = { actionIntentId, canonical, capabilityId, capabilityIncarnationId, toolId, input, privacyClass, localPreferred }
     * Returns { execution, targetNodeId, lease, request } or throws typed failure.
     */
    route(authorizedIntent, { authorityDecisionDigest = null, ttlMs = null } = {}) {
        if (!authorizedIntent || typeof authorizedIntent !== "object") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "authorizedIntent required");
        const { actionIntentId, canonical, capabilityId, capabilityIncarnationId, toolId, input = {}, privacyClass = "INTERNAL", localPreferred = false } = authorizedIntent;
        const digestSource = authorityDecisionDigest ?? this.authorityDecisionDigest;
        if (!digestSource) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "router requires an authority decision digest (lease references canonical authority)");
        const privacy = PRIVACY_CLASSES[privacyClass] ? privacyClass : "INTERNAL";
        // ---- hard eligibility ----
        const candidates = [];
        for (const [nodeId, adv] of this._advertisements) {
            // availability (this node advertises the capability+tool)
            const cap = adv.capabilities.find(c => c.capabilityId === String(capabilityId).slice(0, 256) && c.toolId === String(toolId).slice(0, 256));
            if (!cap || cap.health !== "HEALTHY") continue;
            // privacy locality
            const allowed = DEFAULT_LOCALITY[adv.profile] ?? DEFAULT_LOCALITY.TEMPORARY_NODE;
            if (!allowed.includes(privacy)) continue;
            // liveness: OFFLINE nodes excluded unless nothing else is eligible (handled below)
            const reg = this.registry.lookup(nodeId);
            if (!reg) continue;
            candidates.push({ nodeId, adv, cap, reg, offline: reg.liveness === "OFFLINE" });
        }
        if (candidates.length === 0) throw meshFailure(MESH_ERRORS.ROUTE_UNAVAILABLE, `no node advertises capability '${String(capabilityId).slice(0, 64)}' with privacy '${privacy}'`);
        // trust scope under CURRENT generation — the trust plane decides, not the score
        const eligible = [];
        for (const c of candidates) {
            if (c.offline && !localPreferred) continue;
            for (const scope of ["COMPUTE", "TOOL_EXECUTION"]) {
                try {
                    this.trust.authorize({ nodeId: c.nodeId, scope, trustGeneration: this.trust.snapshot(c.nodeId)?.trustGeneration });
                    eligible.push({ ...c, scope });
                    break;
                } catch { /* try next scope */ }
            }
        }
        if (eligible.length === 0) {
            // local fallback: if the local node itself advertises it, route locally
            throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "no eligible trusted node for execution");
        }
 // ---- deterministic score among eligible ----
 const scored = eligible.map(c => ({
 ...c,
 score: this._score(c, { privacy, localPreferred, preferredNodeId: authorizedIntent.preferredNodeId ?? null })
 })).sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
 const winner = scored[0];
 // ---- mint lease + execution record ----
 // Local execution: no remote lease exists — local actuation proceeds under
 // the SAME authority decision through the frozen actuation path.
 const isLocal = this._localNodeId && winner.nodeId === this._localNodeId;
 const lease = isLocal ? null : contracts.mintExecutionLease({
 actionIntentId,
 actionIntentCanonical: canonical,
 capabilityId, capabilityIncarnationId, toolId,
 targetNodeId: winner.nodeId,
 requestingNodeId: this._localNodeId,
 trustGeneration: this.trust.snapshot(winner.nodeId)?.trustGeneration,
 ttlMs,
 authorityDecisionDigest: digestSource,
 nowMs: this.nowMs()
 });
 const request = isLocal
 ? Object.freeze({ schemaVersion: 1, executionId: `dexec-${crypto.randomBytes(16).toString("hex")}`, lease: null, actionDigest: sha256Hex(canonical), inputDigest: sha256Hex(input ?? {}), input: input ?? {}, expectedCapability: capabilityId, toolIdentity: toolId, deadlineMs: this.nowMs() + this.config.dispatchTimeoutMs, verificationRequirements: Object.freeze({}), state: "DISPATCHED", localExecution: true })
 : contracts.buildExecutionRequest({ lease, input });
 const execution = {
 executionId: request.executionId,
 actionIntentId: String(actionIntentId).slice(0, 128),
 targetNodeId: winner.nodeId,
 lease,
 request,
 state: "LEASED",
 stateHistory: [{ state: "LEASED", atMs: this.nowMs(), details: isLocal ? "local execution (no remote lease)" : null }],
 privacy
 };
        if (this._executions.size >= this.config.maxExecutionsTracked) {
            const oldest = [...this._executions.entries()].sort((a, b) => a[1].stateHistory[0].atMs - b[1].stateHistory[0].atMs)[0];
            this._executions.delete(oldest[0]);
        }
        this._executions.set(request.executionId, execution);
        return Object.freeze({
            executionId: request.executionId,
            targetNodeId: winner.nodeId,
            score: winner.score,
            lease, request,
            transition: (to) => this.transition(request.executionId, to)
        });
    }

    bindLocalNodeId(nodeId) {
 this._localNodeId = ids.check.nodeId(nodeId);
 return this;
 }

 /** Mark dispatch/ack/execute/results. Legal transitions enforced. */
    transition(executionId, to, details = null) {
        const ex = this._executions.get(executionId);
        if (!ex) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown execution");
        if (!contracts.TRANSITIONS[ex.state]?.includes(to)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `illegal transition ${ex.state} -> ${String(to).slice(0, 24)}`);
        }
        ex.state = to;
        ex.stateHistory.push({ state: to, atMs: this.nowMs(), details: details ? String(details).slice(0, 200) : null });
        if (to === "SUCCEEDED") {
            const r = this._reliability.get(ex.targetNodeId) ?? { success: 0, failure: 0 };
            this._reliability.set(ex.targetNodeId, { success: r.success + 1, failure: r.failure });
        }
        if (to === "FAILED") {
            const r = this._reliability.get(ex.targetNodeId) ?? { success: 0, failure: 0 };
            this._reliability.set(ex.targetNodeId, { success: r.success, failure: r.failure + 1 });
        }
        return this.snapshot(executionId);
    }

    /**
     * Timeout after dispatch: the action MAY have executed on the remote node.
     * NEVER retried blindly — execution enters UNKNOWN; verification or
     * compensation must resolve it (FAILOVER != ACTION REPLAY).
     */
    markUnknown(executionId, { reason = "dispatch timeout — outcome uncertain" } = {}) {
        const ex = this._executions.get(executionId);
        if (!ex) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown execution");
        return this.transition(executionId, "UNKNOWN", reason);
    }

    snapshot(executionId) {
        const ex = this._executions.get(executionId);
        return ex ? Object.freeze({
            executionId: ex.executionId,
            actionIntentId: ex.actionIntentId,
            targetNodeId: ex.targetNodeId,
            state: ex.state,
            stateHistory: Object.freeze(ex.stateHistory.map(h => Object.freeze({ ...h }))),
            privacy: ex.privacy
        }) : null;
    }

 verifyRemoteResult(executionId, result) {
 const ex = this._executions.get(executionId);
 if (!ex) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown execution");
 const verified = contracts.verifyExecutionResult(ex.request, result, { nowMs: this.nowMs() });
 // flow through the legal transition path to the terminal verified/failed state
 if (ex.state !== "SUCCEEDED" && ex.state !== "FAILED") {
 this.transition(executionId, verified.state);
 }
 this.transition(executionId, verified.state === "SUCCEEDED" ? "VERIFIED" : "COMPENSATED");
 return verified;
 }

    size() { return this._executions.size; }

 _score(c, { privacy, localPreferred, preferredNodeId = null }) {
 // deterministic: headroom(0-40) + latency(0-25) + reliability(0-25) + locality bonus(10)
 const res = c.adv.resources ?? {};
 const headroom = Number.isFinite(res.headroomScore) ? Math.max(0, Math.min(40, res.headroomScore)) : 20;
 const latency = Math.max(0, Math.min(25, Math.round((100 - c.cap.latencyScore) / 4)));
 const rel = this._reliability.get(c.nodeId) ?? { success: 0, failure: 0 };
 const total = rel.success + rel.failure;
 const reliability = total === 0 ? 12 : Math.round(25 * (rel.success / total));
 const locality = localPreferred && c.offline === false ? 0 : 10;
 // privacy fit bonus: PRIVATE data prefers nodes with PRIVATE permission
 const privacyBonus = (privacy === "PRIVATE" || privacy === "SECRET_REFERENCE") && (DEFAULT_LOCALITY[c.adv.profile] ?? []).includes("SECRET_REFERENCE") ? 5 : 0;
 // placement preference is SCHEDULING HINT only — eligibility was already
 // enforced (trust/scope/availability/locality). HINT != AUTHORITY.
 const preference = preferredNodeId && c.nodeId === preferredNodeId ? 50 : 0;
 return headroom + latency + reliability + locality + privacyBonus + preference;
 }
}

module.exports = Object.freeze({ DistributedExecutionRouter, PRIVACY_CLASSES, DEFAULT_LOCALITY, DEFAULTS });
