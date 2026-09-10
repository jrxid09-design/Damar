"use strict";

/**
 * WAVE 6 L3/R1 — DistributedExecutionRouter (REPAIRED: W6-02, W6-03).
 *
 * PLACEMENT: AFTER the canonical Authority gate, BEFORE actuation dispatch.
 *
 * W6-02 REPAIR: the router NO LONGER accepts a caller-supplied
 * `authorityDecisionDigest`. It REQUIRES an `authorityBridge` (narrow
 * adapter to the frozen canonical Authority owner) and calls
 * `bridge.authorize(...)` itself with the frozen ActionIntent. The lease's
 * authority digest is DERIVED from the branded canonical evaluation
 * snapshot. CALLER-PROVIDED DIGEST != AUTHORITY.
 *
 * W6-03 REPAIR: lease consumption is performed by a MANDATORY
 * LeaseConsumptionLedger owned by this router (verify+consume as ONE
 * operation before any EXECUTING transition). No optional caller ledger.
 *
 * Routing: eligibility-first (advertisement, privacy locality, liveness,
 * trust scope) — score can NEVER bypass trust/authority.
 */

const crypto = require("node:crypto");
const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const contracts = require("./contracts");
const { sha256Hex } = require("../mesh/canonical");
const { verifyAuthorityArtifact } = require("./authorityAdapter");
const { LeaseConsumptionLedger } = require("./leaseLedger");
const { getCanonicalAuthorityBridge } = require("./authoritySource");

const PRIVACY_CLASSES = Object.freeze(["PUBLIC", "INTERNAL", "PRIVATE", "SECRET_REFERENCE"].reduce((m, c) => (m[c] = c, m), {}));

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
    /**
     * W6-02 / R2-02 REPAIR: the router receives NO injectable authority
     * bridge/callback. Authority provenance is resolved through the
     * module-private canonical source (`authoritySource.js`), which is bound
     * exactly once to the canonical `AuthorityRegistry` instance (brand
     * verified via closure-private WeakSet in the frozen authority owner)
     * and performs LIVE evaluation via the frozen
     * `loadAndEvaluateAuthority` primitive at route time.
     *
     * CALLER-SUPPLIED BRIDGE != CANONICAL AUTHORITY.
     * DUCK TYPE != TRUST.
     */
    constructor({ trust, registry, config = {}, nowMs = () => Date.now() } = {}) {
        if (!trust) throw new TypeError("router requires trust plane");
        if (!registry) throw new TypeError("router requires node registry");
        this.trust = trust;
        this.registry = registry;
        // R2-02: the canonical authority bridge comes from the module-private
        // source (bound exactly once to the canonical registry). No parameter.
        this.authorityBridge = getCanonicalAuthorityBridge();
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        this._advertisements = new Map();
        this._executions = new Map();
        // W6-03: THE mandatory consumption owner (single instance per router)
        this.leaseLedger = new LeaseConsumptionLedger({ config: { maxEntries: this.config.maxConsumedNonces }, nowMs });
        this._reliability = new Map();
    }

    bindLocalNodeId(nodeId) {
        this._localNodeId = ids.check.nodeId(nodeId);
        return this;
    }

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
     * Route an intent through canonical authority provenance.
     *
     * @param {object} p
     * @param {object} p.intent FROZEN ActionIntent (from the canonical action
     *        owner's parseActionIntent) — the ONLY intent form accepted.
     * @param {object} p.evaluation BRANDED canonical Authority evaluation
     *        (from loadAndEvaluateAuthority). Caller-supplied digests are
     *        structurally impossible: the digest is derived from the branded
     *        snapshot by the authority adapter.
     */
 async route({ intent, toolId = null, privacyClass = "INTERNAL", localPreferred = false, preferredNodeId = null, ttlMs = null, subject = "damar" } = {}) {
 if (!intent || typeof intent !== "object" || !intent.intentId || !intent.capabilityId || !intent.operation) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "frozen ActionIntent required (parse via the canonical action owner)");
 }
 // R2-02: authority is resolved by the module-private canonical bridge via
 // LIVE evaluation against the bound canonical AuthorityRegistry store.
 // There is NO caller-supplied evaluation and NO caller-supplied digest.
 const capabilityId = intent.capabilityId;
 // toolId is RESOLVED by capability resolution (Capability Registry) and
 // passed in; it is BOUND into the authority artifact so a resolved tool
 // cannot be swapped after authorization.
 const tool = toolId ?? `tool.${capabilityId}`;
 const input = intent.arguments ?? {};
 const actionIntentCanonical = JSON.stringify({
 capabilityId: intent.capabilityId, operation: intent.operation,
 arguments: intent.arguments ?? {}, correlationId: intent.correlationId ?? "",
 createdAtMs: intent.createdAtMs ?? null
 });
 const privacy = PRIVACY_CLASSES[privacyClass] ? privacyClass : "INTERNAL";
 // ---- R2-02: canonical authority provenance FIRST (Authority -> Capability
 // -> Router). The bridge performs a LIVE evaluation against the canonical
 // store and mints the artifact from the BRANDED evaluation snapshot. ----
 const artifact = await this.authorityBridge.authorize({
 intent, capabilityId, toolId: tool, targetNodeId: this._localNodeId, ttlMs, subject
 });
 // ---- hard eligibility (never score-bypassable) ----
 const candidates = [];
 for (const [nodeId, adv] of this._advertisements) {
 const cap = adv.capabilities.find(c => c.capabilityId === String(capabilityId).slice(0, 256) && c.toolId === String(tool).slice(0, 256));
 if (!cap || cap.health !== "HEALTHY") continue;
 const allowed = DEFAULT_LOCALITY[adv.profile] ?? DEFAULT_LOCALITY.TEMPORARY_NODE;
 if (!allowed.includes(privacy)) continue;
 const reg = this.registry.lookup(nodeId);
 if (!reg) continue;
 candidates.push({ nodeId, adv, cap, reg, offline: reg.liveness === "OFFLINE" });
 }
 if (candidates.length === 0) throw meshFailure(MESH_ERRORS.ROUTE_UNAVAILABLE, `no node advertises capability '${String(capabilityId).slice(0, 64)}' with privacy '${privacy}'`);
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
 throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "no eligible trusted node for execution");
 }
 const scored = eligible.map(c => ({ ...c, score: this._score(c, { privacy, localPreferred, preferredNodeId }) }))
 .sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
 const winner = scored[0];
 // re-bind + re-verify the artifact to the WINNER node (defense in depth)
 const winnerArtifact = await this.authorityBridge.authorize({
 intent, capabilityId, toolId: tool, targetNodeId: winner.nodeId, ttlMs, subject
 });
 verifyAuthorityArtifact(winnerArtifact, { actionIntentCanonical, capabilityId, toolId: tool, targetNodeId: winner.nodeId, nowMs: this.nowMs() });

        const isLocal = this._localNodeId && winner.nodeId === this._localNodeId;
        const lease = isLocal ? null : contracts.mintExecutionLease({
            actionIntentId: intent.intentId,
            actionIntentCanonical,
            capabilityId, capabilityIncarnationId: winner.cap.incarnationId, toolId: tool,
            targetNodeId: winner.nodeId,
            requestingNodeId: this._localNodeId,
            trustGeneration: this.trust.snapshot(winner.nodeId)?.trustGeneration,
            ttlMs,
            authorityDecisionDigest: artifact.decisionDigest,
            authorityBinding: artifact.core,
            nowMs: this.nowMs()
        });
        const request = isLocal
            ? Object.freeze({ schemaVersion: 1, executionId: `dexec-${crypto.randomBytes(16).toString("hex")}`, lease: null, authorityArtifact: winnerArtifact, actionDigest: sha256Hex(actionIntentCanonical), inputDigest: sha256Hex(input ?? {}), input: input ?? {}, expectedCapability: capabilityId, toolIdentity: tool, deadlineMs: this.nowMs() + this.config.dispatchTimeoutMs, verificationRequirements: Object.freeze({}), state: "DISPATCHED", localExecution: true })
            : Object.freeze({ ...contracts.buildExecutionRequest({ lease, input }), authorityArtifact: winnerArtifact });
        const execution = {
            executionId: request.executionId,
            actionIntentId: intent.intentId,
            targetNodeId: winner.nodeId,
            lease, request, authorityArtifact: winnerArtifact,
            actionIntentCanonical,
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
            lease, request, authorityArtifact: winnerArtifact,
            transition: (to) => this.transition(request.executionId, to),
            /** W6-03: consume the lease on the target boundary (verify+consume atomic) */
            consumeOnTarget: ({ localNodeId, currentTrustGeneration }) => this.consumeLeaseOnTarget(request.executionId, { localNodeId, currentTrustGeneration })
        });
    }

    /**
     * W6-03: VERIFY + CONSUME as one atomic operation through the mandatory
     * consumption ledger. The transition to EXECUTING REQUIRES consumption.
     */
    consumeLeaseOnTarget(executionId, { localNodeId, currentTrustGeneration }) {
        const ex = this._executions.get(executionId);
        if (!ex) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown execution");
        if (!ex.lease) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "local execution consumes no remote lease");
        const consumed = this.leaseLedger.consume(ex.lease, {
            localNodeId, currentTrustGeneration,
            actionIntentCanonical: ex.actionIntentCanonical,
            capabilityId: ex.lease.capabilityId,
            toolId: ex.lease.toolId
        });
        return Object.freeze(consumed);
    }

    transition(executionId, to, details = null) {
        const ex = this._executions.get(executionId);
        if (!ex) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown execution");
        // W6-03: entering EXECUTING on a leased remote execution REQUIRES the
        // lease to have been consumed via the mandatory ledger first.
        if (to === "EXECUTING" && ex.lease) {
            const nonce = String(ex.lease.executionNonce ?? "");
            if (!this.leaseLedger.has(nonce)) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "lease not consumed — EXECUTING requires verify+consume through the mandatory consumption ledger (W6-03)");
            }
        }
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
        if (ex.state !== "SUCCEEDED" && ex.state !== "FAILED") {
            this.transition(executionId, verified.state);
        }
        this.transition(executionId, verified.state === "SUCCEEDED" ? "VERIFIED" : "COMPENSATED");
        return verified;
    }

    size() { return this._executions.size; }

    _score(c, { privacy, localPreferred, preferredNodeId = null }) {
        const res = c.adv.resources ?? {};
        const headroom = Number.isFinite(res.headroomScore) ? Math.max(0, Math.min(40, res.headroomScore)) : 20;
        const latency = Math.max(0, Math.min(25, Math.round((100 - c.cap.latencyScore) / 4)));
        const rel = this._reliability.get(c.nodeId) ?? { success: 0, failure: 0 };
        const total = rel.success + rel.failure;
        const reliability = total === 0 ? 12 : Math.round(25 * (rel.success / total));
        const locality = localPreferred && c.offline === false ? 0 : 10;
        const privacyBonus = (privacy === "PRIVATE" || privacy === "SECRET_REFERENCE") && (DEFAULT_LOCALITY[c.adv.profile] ?? []).includes("SECRET_REFERENCE") ? 5 : 0;
        const preference = preferredNodeId && c.nodeId === preferredNodeId ? 50 : 0;
        return headroom + latency + reliability + locality + privacyBonus + preference;
    }
}

module.exports = Object.freeze({ DistributedExecutionRouter, PRIVACY_CLASSES, DEFAULT_LOCALITY, DEFAULTS });
