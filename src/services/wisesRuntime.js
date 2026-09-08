"use strict";

const fs = require("node:fs");

const DEFAULT_PROFILE = Object.freeze({ survivalRole: "system-local-survival", runtimeId: "unspecified-local-runtime", providerId: "local-runtime", modelId: "UNSPECIFIED_LOCAL_MODEL", modelDisplayName: "Unspecified local model", artifactPath: null, artifactDigest: null, runtimeVersion: null });
function profileValue(value, fallback, max = 512) { return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fallback; }

class WisesRuntime {
    constructor({ artifactPath = null, runtime = null, infer = null, recovery = null, profile = {}, maxRecoveryAttempts = 1, recoveryCooldownMs = 1000, now = () => Date.now() } = {}) { this.runtime = runtime; this.infer = infer; this.recovery = recovery; this.maxRecoveryAttempts = Math.max(0, Math.min(3, maxRecoveryAttempts | 0)); this.recoveryCooldownMs = Math.max(0, recoveryCooldownMs | 0); this.recoveryAttempts = 0; this.lastRecoveryAt = 0; this.now = now; this.profile = Object.freeze({ ...DEFAULT_PROFILE, ...profile, artifactPath: profile.artifactPath ?? artifactPath, survivalRole: profileValue(profile.survivalRole, DEFAULT_PROFILE.survivalRole), runtimeId: profileValue(profile.runtimeId, DEFAULT_PROFILE.runtimeId), providerId: profileValue(profile.providerId, DEFAULT_PROFILE.providerId), modelId: profileValue(profile.modelId, DEFAULT_PROFILE.modelId), modelDisplayName: profileValue(profile.modelDisplayName, profile.modelId || DEFAULT_PROFILE.modelDisplayName), artifactDigest: profile.artifactDigest ? profileValue(profile.artifactDigest, null, 128) : null, runtimeVersion: profile.runtimeVersion ? profileValue(profile.runtimeVersion, null, 128) : null }); this.artifactPath = this.profile.artifactPath; this.state = "FAILED"; this.lastError = "NOT_CONFIGURED"; }
    async readiness() {
        if (this.artifactPath && !fs.existsSync(this.artifactPath)) { this.state = "FAILED"; this.lastError = "ARTIFACT_MISSING"; return this.snapshot(); }
        if (typeof this.infer !== "function" && !this.runtime?.infer) { this.state = "FAILED"; this.lastError = "RUNTIME_UNAVAILABLE"; return this.snapshot(); }
        this.state = "LOADING";
        try { await (this.runtime?.canary ? this.runtime.canary() : this._infer("readiness")); this.state = "READY_WARM"; this.lastError = null; this.recoveryAttempts = 0; } catch (error) { this.state = "FAILED"; this.lastError = String(error.message || error); }
        return this.snapshot();
    }
    snapshot() { return Object.freeze({ state: this.state, artifact: Boolean(this.artifactPath), lastError: this.lastError, recoveryAttempts: this.recoveryAttempts, profile: this.profile }); }
    describe() { return Object.freeze({ ...this.profile, readiness: this.state }); }
    async recover() { if (!this.recovery || typeof this.recovery.restart !== "function" || this.recoveryAttempts >= this.maxRecoveryAttempts || this.now() - this.lastRecoveryAt < this.recoveryCooldownMs) return false; this.recoveryAttempts++; this.lastRecoveryAt = this.now(); this.state = "STARTING"; try { await this.recovery.restart(); const status = await this.readiness(); return String(status.state).startsWith("READY"); } catch (error) { this.state = "FAILED"; this.lastError = String(error.message || error); return false; } }
    async _infer(prompt, context) { return this.infer ? this.infer(prompt, context) : this.runtime.infer(prompt, context); }
    async invoke({ messages = [], entityId, role = null, entityProjection = null, continuation = null, maxTokens = null, temperature = null } = {}) { if (!this.state.startsWith("READY")) { await this.readiness(); if (!this.state.startsWith("READY")) await this.recover(); } if (!this.state.startsWith("READY")) throw Object.assign(new Error("LOCAL_RUNTIME_NOT_READY"), { failureClass: "LOCAL_RUNTIME_FAILURE" }); const result = await this._infer(messages, { entityId, role, entityProjection, continuation, maxTokens, temperature }); if (result === undefined || result === null || result === "") throw Object.assign(new Error("LOCAL_RUNTIME_EMPTY_RESPONSE"), { failureClass: "LOCAL_RUNTIME_FAILURE" }); return { content: result, provider: this.profile.providerId, model: this.profile.modelId, readiness: this.state, provenance: { entityId, local: true, survivalRole: this.profile.survivalRole, runtimeId: this.profile.runtimeId, runtimeVersion: this.profile.runtimeVersion, modelId: this.profile.modelId, modelDisplayName: this.profile.modelDisplayName, artifactPath: this.profile.artifactPath, artifactDigest: this.profile.artifactDigest, continuation: continuation ? { phase: continuation.phase ?? null, completedActionRefs: continuation.completedActionRefs ?? [] } : null } }; }
}

module.exports = Object.freeze({ WisesRuntime });
