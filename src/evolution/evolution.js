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
const { isCanonicalAuthorityRegistry } = require("../authority/registry");
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
 * W6-01 REPAIR — bounded canary deployment requiring CANONICAL RATIFICATION.
 *
 * `proposalStatus: "APPROVED"` caller strings are NOT authority. The canary
 * requires a ratification object produced by the frozen Evolution Authority
 * path (`AuthorityRegistry.ratify()` output: decision APPROVED + proposalId
 * + proposalDigest + proposalRevision + approvedAuthorityDigest binding)
 * AND the proposal object itself as stored by this pipeline.
 */
const EVOLUTION_BOUNDS = Object.freeze({
    maxActiveCanaries: 3,
    maxObservationsPerCanary: 100,
    maxObservationBytesPerCanary: 64 * 1024,
    maxObservationBytes: 8192,
    maxCanaryHistory: 32
});

class CanaryDeployment {
    constructor({
        proposalId, proposal, ratification, candidateArtifactDigest,
        scope = {}, ttlMs = null, nowMs = () => Date.now(), activeCanaryCount = 0,
        maxActiveCanaries = EVOLUTION_BOUNDS.maxActiveCanaries
    } = {}) {
        // W6-01: unknown proposal + "APPROVED" string -> reject
        if (!proposal || proposal.proposalId !== String(proposalId ?? "").slice(0, 128)) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, `canary references proposal '${String(proposalId ?? "(none)").slice(0, 64)}' which does not exist in the evolution pipeline (caller-asserted approval rejected)`);
        }
        if (!ratification || typeof ratification !== "object" || ratification.decision !== "APPROVED") {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "canary requires a canonical APPROVED ratification from the frozen Evolution Authority");
        }
        if (typeof ratification.ratificationId !== "string" || ratification.ratificationId.length === 0 || ratification.ratificationId.length > 120) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification malformed (not produced by the canonical Authority path)");
        }
        if (ratification.proposalId !== proposal.proposalId) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification belongs to a different proposal");
        }
        if (ratification.proposalDigest !== proposal.digest) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification proposalDigest does not match the current proposal revision (stale/tampered)");
        }
        if ((ratification.proposalRevision ?? 1) !== (proposal.revision ?? 1)) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification revision does not match the current proposal revision (stale)");
        }
        if (!ratification.approvedAuthority || typeof ratification.approvedAuthority !== "object") {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification carries no approvedAuthority (nothing was ratified)");
        }
        const recomputed = sha256Hex(ratification.approvedAuthority);
        if (ratification.approvedAuthorityDigest && ratification.approvedAuthorityDigest !== recomputed) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification approvedAuthority digest mismatch (tampered)");
        }
        const candidateDigest = String(candidateArtifactDigest ?? "").slice(0, 64);
        const ratifiedCandidate = ratification.approvedAuthority.candidateArtifactDigest
            ?? ratification.approvedAuthority.candidateDigest ?? null;
        if (!ratifiedCandidate || ratifiedCandidate !== candidateDigest) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification is bound to a different candidate artifact");
        }
        const expMs = ratification.expiryAt ? Date.parse(ratification.expiryAt) : null;
        if (ratification.expiryAt && (Number.isNaN(expMs) || expMs <= nowMs())) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "ratification expired");
        }
        // W6-06: active canary cap enforced by the caller's counter
        if (!Number.isInteger(activeCanaryCount) || activeCanaryCount < 0) {
            throw new TypeError("activeCanaryCount must be a non-negative integer");
        }
        if (activeCanaryCount >= maxActiveCanaries) {
            throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `active canary cap (${maxActiveCanaries}) reached`);
        }
        this.canaryId = `dcanary-${crypto.randomBytes(12).toString("hex")}`;
        this.proposalId = proposal.proposalId;
        this.proposalDigest = proposal.digest;
        this.ratificationId = ratification.ratificationId;
        this.candidateArtifactDigest = candidateDigest;
        this.scope = boundedMap(scope);
        this.state = "DEPLOYED";
        this.deployedAtMs = Math.floor(nowMs());
        this.expiresAtMs = this.deployedAtMs + (Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : EXPERIENCE_DEFAULTS.canaryTtlMs);
        this.observations = [];
        this._observedBytes = 0;
        this.nowMs = nowMs;
    }

 observe({ metric, value } = {}) {
 if (this.state !== "DEPLOYED") throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canary not DEPLOYED");
 if (this.observations.length >= EVOLUTION_BOUNDS.maxObservationsPerCanary) {
 throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `canary observation cap (${EVOLUTION_BOUNDS.maxObservationsPerCanary}) reached`);
 }
 // W6-06: byte bound is computed on the RAW input BEFORE truncation — a
 // huge payload can never sneak in via the bounded string coercion.
 const rawEntry = { atMs: this.nowMs(), metric: metric ?? "", value: value ?? "" };
 const rawBytes = Buffer.byteLength(JSON.stringify(rawEntry), "utf8");
 if (rawBytes > EVOLUTION_BOUNDS.maxObservationBytes) {
 throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `single observation exceeds byte bound (${rawBytes} > ${EVOLUTION_BOUNDS.maxObservationBytes})`);
 }
 const entry = { atMs: this.nowMs(), metric: String(metric).slice(0, 64), value: Number.isFinite(value) ? value : String(value).slice(0, 64) };
 const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
 this._observedBytes += bytes;
 if (this._observedBytes > EVOLUTION_BOUNDS.maxObservationBytesPerCanary) {
 throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "canary observation byte budget exhausted");
 }
 this.observations.push(entry);
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
        if (this.nowMs() > this.expiresAtMs) { this.state = "EXPIRED"; throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "canary TTL expired — promote rejected, roll back instead"); }
        this.state = "PROMOTED";
        return Object.freeze({ canaryId: this.canaryId, state: this.state });
    }
}

/**
 * EvolutionPipeline — the L7 orchestrator. Proposals are built by the FROZEN
 * authority model builder; approval happens ONLY via the existing registry.
 */
class EvolutionPipeline {
    constructor({ authorityModel, authorityRegistry = null, config = {}, nowMs = () => Date.now() } = {}) {
        if (!authorityModel || typeof authorityModel.buildEvolutionProposal !== "function") {
            throw new TypeError("EvolutionPipeline requires the frozen authority model (buildEvolutionProposal) — no parallel authority");
        }
        this.authorityModel = authorityModel;
        // W6-01: when the frozen AuthorityRegistry is bound, proposals are
        // created THROUGH it so canary ratification digests match exactly.
        this.authorityRegistry = authorityRegistry;
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
     * W6-01 REPAIR: proposals are created through the FROZEN AuthorityRegistry
     * (`proposeEvolution`) when a registry is bound — the pipeline stores the
     * SAME canonical object the registry ratified, so ratification digests
     * match exactly. Without a bound registry, the frozen builder is used
     * directly, and canaries still require registry ratification.
     */
 async createProposal({ proposalId, createdBy, evidence, kind = "routing_preference", problem, proposedChange, affectedSubsystems = [], rollbackPlan = "", testPlan = "", requestedAuthority = null } = {}) {
 if (this._proposals.size >= this.config.maxProposals) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "proposal table full");
 // poisoning guards: evidence must reference real experience signal windows
 if (!evidence || !Array.isArray(evidence.signalKeys) || evidence.signalKeys.length === 0) {
 throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "proposal requires evidence.signalKeys from real learning windows");
 }
 for (const k of evidence.signalKeys.slice(0, 8)) {
 const rec = this.experiences.recommendation(String(k).slice(0, 160));
 if (!rec) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `evidence references unknown signal window '${String(k).slice(0, 64)}' (poisoned or fabricated evidence)`);
 }
 let proposal;
 if (this.authorityRegistry && typeof this.authorityRegistry.proposeEvolution === "function") {
 proposal = await this.authorityRegistry.proposeEvolution({
 proposalId, createdBy, kind, problem, proposedChange,
 affectedSubsystems, rollbackPlan, testPlan,
 evidenceRefs: evidence.signalKeys.slice(0, 8),
 requestedAuthority
 }, createdBy ?? "evolution-pipeline");
 } else {
 proposal = this.authorityModel.buildEvolutionProposal({
 proposalId, createdBy, kind, problem, proposedChange,
 affectedSubsystems, rollbackPlan, testPlan,
 evidenceRefs: evidence.signalKeys.slice(0, 8)
 });
 }
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
     * W6-01 / R2-01 REPAIR: canary requires LIVE canonical approval.
     *
     * No caller-supplied ratification object is accepted — ALL visible
     * ratification fields/digests are reconstructable (R2-01: reconstruct
     * all visible fields -> reject). Approval is resolved from the bound
     * canonical Evolution Authority registry at USE TIME via
     * `getCurrentRatification(proposalId)`, which re-checks:
     *   proposal exists, digest+revision current, APPROVED decision,
     *   not expired, not superseded/consumed, bound to the requested
     *   candidate artifact digest.
     *
     * SERIALIZED SECURITY OBJECT != LIVE AUTHORITY; FIELD MATCH != PROVENANCE.
     */
    async startCanary({ proposalId, candidateArtifactDigest, scope = {}, ttlMs = null }) {
        const key = String(proposalId ?? "").slice(0, 128);
        const proposal = this._proposals.get(key);
        if (!proposal) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, `unknown proposal '${key.slice(0, 64)}' — caller-asserted approval rejected`);
        }
        if (!this.authorityRegistry || typeof this.authorityRegistry.getCurrentRatification !== "function") {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "no canonical Evolution Authority registry bound — canary approval cannot be resolved from canonical owner state");
        }
        if (!isCanonicalAuthorityRegistry(this.authorityRegistry)) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "bound authority registry is not the canonical owner (duck-typed/bridged object rejected)");
        }
        // LIVE canonical lookup — at use time, from owner state
        const currentRat = await this.authorityRegistry.getCurrentRatification(key);
        if (!currentRat) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, `no current APPROVED ratification for proposal '${key.slice(0, 64)}' in canonical owner state (stale/revoked/superseded/expired/never-ratified)`);
        }
        // candidate binding verified against the LIVE owner record
        const candidateDigest = String(candidateArtifactDigest ?? "").slice(0, 64);
        const ratifiedCandidate = currentRat.approvedAuthority?.candidateArtifactDigest
            ?? currentRat.approvedAuthority?.candidateDigest ?? null;
        if (!ratifiedCandidate || ratifiedCandidate !== candidateDigest) {
            throw meshFailure(MESH_ERRORS.EVOLUTION_NOT_APPROVED, "canonical ratification is bound to a different candidate artifact");
        }
        const canary = new CanaryDeployment({
            proposalId: key, proposal,
            ratification: currentRat, candidateArtifactDigest: candidateDigest,
            scope, ttlMs, nowMs: this.nowMs,
            activeCanaryCount: [...this._canaries.values()].filter(c => c.state === "DEPLOYED").length,
            maxActiveCanaries: EVOLUTION_BOUNDS.maxActiveCanaries
        });
        this._canaries.set(canary.canaryId, canary);
        if (this._canaries.size > EVOLUTION_BOUNDS.maxCanaryHistory) {
            // bounded history: reclaim oldest non-DEPLOYED first, else oldest
            let reclaim = [...this._canaries.entries()].find(([, c]) => c.state !== "DEPLOYED");
            if (!reclaim) reclaim = [...this._canaries.entries()].sort((a, b) => a[1].deployedAtMs - b[1].deployedAtMs)[0];
            this._canaries.delete(reclaim[0]);
        }
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
    EXPERIENCE_DEFAULTS, SHADOW_STATES, CANARY_STATES, EVOLUTION_BOUNDS
});
