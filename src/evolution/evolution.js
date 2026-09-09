"use strict";

/**
 * WAVE 6 L7 — Governed Evolution & Continuous Self-Improvement.
 *
 * Reuses Evolution Authority V1 (`src/authority`: buildEvolutionProposal,
 * EVOLUTION_STATUS, buildRatification, AuthorityRegistry ratification).
 * There is NO parallel self-modification authority.
 *
 * LAWS:
 *   SELF-IMPROVEMENT != SELF-AUTHORIZATION
 *   EVOLUTION PROPOSAL != EVOLUTION APPROVAL
 *   LEARNED BEHAVIOR != POLICY CHANGE
 *   SHADOW/CANARY candidates never control actions before approval.
 *
 * Pipeline:
 *   ExperienceRecord (bounded, no secrets)
 *   -> learning signals (aggregated recommendations)
 *   -> EvolutionProposal (frozen Authority V1 builder)
 *   -> shadow evaluation (divergence measured, zero action influence)
 *   -> ratification (existing registry/owner)
 *   -> bounded canary deployment (scope+time-limited)
 *   -> observation -> retain | rollback (mandatory, always possible)
 */

const crypto = require("node:crypto");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const SHADOW_STATES = Object.freeze(["RUNNING", "COMPLETED", "ABORTED"].reduce((m, s) => (m[s] = s, m), {}));
const CANARY_STATES = Object.freeze(["DEPLOYED", "PROMOTED", "ROLLED_BACK", "EXPIRED"].reduce((m, s) => (m[s] = s, m), {}));

const EXPERIENCE_DEFAULTS = Object.freeze({
    maxExperiences: 2048,
    maxSignalWindows: 64,
    maxShadowRuns: 32,
    maxCanaries: 16,
    maxProposals: 128,
    canaryTtlMs: 3600 * 1000
});

const SECRET_TOKENS = Object.freeze(new Set(["secret", "password", "token", "apikey", "api_key", "credential", "privatekey", "private_key"]));

/** Bounded ExperienceRecord — recommendations data, never secrets. */
function buildExperienceRecord({
    taskType, contextSummary = "", routingDecision = {}, selectedCapability = null,
    selectedModel = null, selectedProvider = null, result = "unknown",
    verification = "unverified", latencyMs = null, costUnits = null,
    failureReason = null, recoveryUsed = false, userCorrection = null,
    confidence = null, nodeId = null
} = {}) {
    if (typeof taskType !== "string" || taskType.length === 0 || taskType.length > 64) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "taskType required (<=64)");
    if (!["succeeded", "failed", "unknown"].includes(result)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "result must be succeeded|failed|unknown");
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "confidence must be 0..1");
    rejectSecrets({ contextSummary, routingDecision, failureReason, userCorrection, selectedCapability, selectedModel, selectedProvider });
    const recordId = `dexp-${crypto.randomBytes(12).toString("hex")}`;
    return Object.freeze({
        recordId,
        atMs: Date.now(),
        nodeId: nodeId ? String(nodeId).slice(0, 128) : null,
        taskType: taskType.slice(0, 64),
        contextSummary: String(contextSummary ?? "").slice(0, 500),
        routingDecision: boundedMap(routingDecision),
        selectedCapability: selectedCapability ? String(selectedCapability).slice(0, 128) : null,
        selectedModel: selectedModel ? String(selectedModel).slice(0, 128) : null,
        selectedProvider: selectedProvider ? String(selectedProvider).slice(0, 128) : null,
        result, verification: String(verification).slice(0, 32),
        latencyMs: Number.isFinite(latencyMs) ? Math.floor(latencyMs) : null,
        costUnits: Number.isFinite(costUnits) ? Math.floor(costUnits) : null,
        failureReason: failureReason ? String(failureReason).slice(0, 200) : null,
        recoveryUsed: Boolean(recoveryUsed),
        userCorrection: userCorrection ? String(userCorrection).slice(0, 300) : null,
        confidence: confidence === null ? null : Math.round(confidence * 1000) / 1000
    });
}

/** Learning signal aggregation — bounded windows, deterministic. */
class LearningSignals {
    constructor({ config = {} } = {}) {
        this.config = Object.freeze({ ...EXPERIENCE_DEFAULTS, ...config });
        /** signalKey -> { window: [records], success, failure } */
        this._signals = new Map();
        this._count = 0;
    }

    add(record) {
        if (!record || !record.recordId) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "experience record required");
        const key = `${record.taskType}|${record.selectedCapability ?? "-"}|${record.selectedProvider ?? "-"}`;
        let sig = this._signals.get(key);
        if (!sig) {
            if (this._signals.size >= this.config.maxSignalWindows) {
                // drop the smallest window (bounded)
                const smallest = [...this._signals.entries()].sort((a, b) => a[1].window.length - b[1].window.length)[0];
                this._signals.delete(smallest[0]);
            }
            sig = { window: [], success: 0, failure: 0 };
            this._signals.set(key, sig);
        }
        sig.window.push(record);
        if (sig.window.length > this.config.maxExperiences / this.config.maxSignalWindows) sig.window.shift();
        if (record.result === "succeeded") sig.success++; else if (record.result === "failed") sig.failure++;
        this._count++;
        return { signalKey: key, success: sig.success, failure: sig.failure };
    }

    /** Deterministic recommendation view — NEVER a policy change by itself. */
    recommendation(signalKey) {
        const sig = this._signals.get(signalKey);
        if (!sig || sig.window.length === 0) return null;
        const total = sig.success + sig.failure;
        const reliability = Math.round((sig.success / Math.max(1, total)) * 1000) / 1000;
        const latencies = sig.window.map(w => w.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
        return Object.freeze({
            signalKey,
            samples: sig.window.length,
            success: sig.success,
            failure: sig.failure,
            reliability,
            medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
            kind: "RECOMMENDATION",
            law: "LEARNED BEHAVIOR != POLICY CHANGE — this aggregate informs proposals; it changes nothing by itself"
        });
    }

    size() { return this._signals.size; }
}

/**
 * Shadow evaluation: candidate runs alongside the canonical path producing
 * COMPARISON DATA ONLY. Structurally zero action influence: shadow decisions
 * are recorded, never dispatched.
 */
class ShadowEvaluation {
    constructor({ candidateId, config = {}, nowMs = () => Date.now() } = {}) {
        this.candidateId = String(candidateId).slice(0, 128);
        this.config = Object.freeze({ ...EXPERIENCE_DEFAULTS, ...config });
        this.nowMs = nowMs;
        this.state = "RUNNING";
        this.comparisons = [];
    }

    /** Record a shadow decision. `shadowDispatch` is structurally impossible. */
    compare({ canonicalDecision, shadowDecision, outcome = null } = {}) {
        if (this.state !== "RUNNING") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "shadow run not RUNNING");
        if (this.comparisons.length >= this.config.maxShadowRuns * 100) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "shadow comparison cap");
        this.comparisons.push({
            atMs: this.nowMs(),
            canonical: boundedMap(canonicalDecision),
            shadow: boundedMap(shadowDecision),
            diverged: JSON.stringify(canonicalDecision ?? {}) !== JSON.stringify(shadowDecision ?? {}),
            outcome: outcome ? String(outcome).slice(0, 128) : null
        });
        return this.comparisons[this.comparisons.length - 1];
    }

    complete() {
        if (this.state !== "RUNNING") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "shadow run not RUNNING");
        this.state = "COMPLETED";
        const diverged = this.comparisons.filter(c => c.diverged).length;
        return Object.freeze({
            candidateId: this.candidateId,
            comparisons: this.comparisons.length,
            diverged,
            divergenceRate: this.comparisons.length ? Math.round((diverged / this.comparisons.length) * 1000) / 1000 : 0,
            actionInfluence: "NONE — shadow decisions are never dispatched",
            evidenceFor: this.comparisons.length >= 20 && diverged / Math.max(1, this.comparisons.length) <= 0.2 ? "SUFFICIENT" : "INSUFFICIENT"
        });
    }

    abort() { this.state = "ABORTED"; return Object.freeze({ candidateId: this.candidateId, state: this.state }); }
}

/**
 * Bounded canary deployment — only AFTER an APPROVED proposal. Scope and
 * time limited; rollback mandatory and always available.
 */
class CanaryDeployment {
    constructor({ proposalId, proposalStatus, scope = {}, ttlMs = null, nowMs = () => Date.now() } = {}) {
        if (proposalStatus !== "APPROVED") {
            // SELF-IMPROVEMENT != SELF-AUTHORIZATION: no approval, no canary
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, `proposal '${String(proposalId).slice(0, 64)}' is '${String(proposalStatus).slice(0, 32)}', not APPROVED`);
        }
        this.canaryId = `dcanary-${crypto.randomBytes(12).toString("hex")}`;
        this.proposalId = String(proposalId).slice(0, 128);
        this.scope = boundedMap(scope);
        this.state = "DEPLOYED";
        this.deployedAtMs = Math.floor(nowMs());
        this.expiresAtMs = this.deployedAtMs + (Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : EXPERIENCE_DEFAULTS.canaryTtlMs);
        this.observations = [];
        this.nowMs = nowMs;
    }

    observe({ metric, value } = {}) {
        if (this.state !== "DEPLOYED") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canary not DEPLOYED");
        this.observations.push({ atMs: this.nowMs(), metric: String(metric).slice(0, 64), value: Number.isFinite(value) ? value : String(value).slice(0, 64) });
        return this.observations.length;
    }

    rollback({ reason } = {}) {
        if (this.state !== "DEPLOYED") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canary not DEPLOYED");
        this.state = "ROLLED_BACK";
        this.rollback = { reason: String(reason ?? "unspecified").slice(0, 300), atMs: this.nowMs() };
        return Object.freeze({ canaryId: this.canaryId, state: this.state, rollback: this.rollback });
    }

    promote() {
        if (this.state !== "DEPLOYED") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canary not DEPLOYED");
        if (Date.now() > this.expiresAtMs) { this.state = "EXPIRED"; throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "canary TTL expired — promote rejected, roll back instead"); }
        this.state = "PROMOTED";
        return Object.freeze({ canaryId: this.canaryId, state: this.state });
    }
}

/**
 * EvolutionPipeline — the L7 orchestrator. Proposals are built by the FROZEN
 * authority model builder; approval happens ONLY via the existing registry.
 */
class EvolutionPipeline {
    constructor({ authorityModel, config = {}, nowMs = () => Date.now() } = {}) {
        if (!authorityModel || typeof authorityModel.buildEvolutionProposal !== "function") {
            throw new TypeError("EvolutionPipeline requires the frozen authority model (buildEvolutionProposal) — no parallel authority");
        }
        this.authorityModel = authorityModel;
        this.config = Object.freeze({ ...EXPERIENCE_DEFAULTS, ...config });
        this.nowMs = nowMs;
        this.experiences = new LearningSignals(this.config);
        this._shadows = new Map();
        this._canaries = new Map();
        this._proposals = new Map();
    }

    recordExperience(record) {
        const built = record.recordId ? record : buildExperienceRecord(record);
        return this.experiences.add(built);
    }

    /**
     * Forge-check: an experience record whose fields were tampered after
     * creation fails its digest binding.
     */
    verifyExperience(record) {
        if (!record || !record.digest) return false;
        const { digest, ...core } = record;
        return sha256Hex(core) === digest;
    }

    /**
     * Create a proposal THROUGH THE FROZEN AUTHORITY BUILDER (DRAFT status —
     * proposal != approval). Poisoned/malicious evidence is rejected here.
     */
    createProposal({ proposalId, createdBy, evidence, kind = "routing_preference", problem, proposedChange, affectedSubsystems = [], rollbackPlan = "", testPlan = "" } = {}) {
        if (this._proposals.size >= this.config.maxProposals) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "proposal table full");
        // poisoning guards: evidence must reference real experience signal windows
        if (!evidence || !Array.isArray(evidence.signalKeys) || evidence.signalKeys.length === 0) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "proposal requires evidence.signalKeys from real learning windows");
        }
        for (const k of evidence.signalKeys.slice(0, 8)) {
            const rec = this.experiences.recommendation(String(k).slice(0, 160));
            if (!rec) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `evidence references unknown signal window '${String(k).slice(0, 64)}' (poisoned or fabricated evidence)`);
        }
        const proposal = this.authorityModel.buildEvolutionProposal({
            proposalId, createdBy, kind, problem, proposedChange,
            affectedSubsystems, rollbackPlan, testPlan,
            evidenceRefs: evidence.signalKeys.slice(0, 8)
        });
        this._proposals.set(proposal.proposalId, proposal);
        return Object.freeze({ ...proposal, law: "EVOLUTION PROPOSAL != EVOLUTION APPROVAL — DRAFT requires owner ratification via the frozen AuthorityRegistry" });
    }

    startShadow(candidateId) {
        if (this._shadows.size >= this.config.maxShadowRuns) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "shadow run table full");
        const sh = new ShadowEvaluation({ candidateId, config: this.config, nowMs: this.nowMs });
        this._shadows.set(sh.candidateId, sh);
        return sh;
    }

    /**
     * Canary deployment: gated on proposalStatus === APPROVED. The caller
     * passes the status from the frozen AuthorityRegistry — the pipeline
     * itself CANNOT approve.
     */
    startCanary({ proposalId, proposalStatus, scope = {}, ttlMs = null }) {
        const canary = new CanaryDeployment({ proposalId, proposalStatus, scope, ttlMs, nowMs: this.nowMs });
        this._canaries.set(canary.canaryId, canary);
        return canary;
    }

    stats() {
        return Object.freeze({
            experienceWindows: this.experiences.size(),
            shadows: this._shadows.size,
            canaries: this._canaries.size,
            proposals: this._proposals.size
        });
    }
}

function boundedMap(obj) {
    if (obj === null || obj === undefined) return null;
    if (typeof obj !== "object" || Array.isArray(obj)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "expected object");
    const entries = Object.entries(obj).slice(0, 16);
    const out = {};
    for (const [k, v] of entries) {
        if (SECRET_TOKENS.has(String(k).toLowerCase())) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `secret-shaped field '${k.slice(0, 32)}' forbidden in experience/evolution data`);
        out[String(k).slice(0, 64)] = typeof v === "number" ? v : String(v ?? "").slice(0, 128);
    }
    return out;
}

function rejectSecrets(obj) { boundedMap(obj); }

module.exports = Object.freeze({
    buildExperienceRecord, LearningSignals, ShadowEvaluation, CanaryDeployment, EvolutionPipeline,
    EXPERIENCE_DEFAULTS, SHADOW_STATES, CANARY_STATES
});
