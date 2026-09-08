"use strict";

const fs = require("node:fs");

const DEFAULT_PROFILE = Object.freeze({
    survivalRole: "system-local-survival",
    runtimeId: "unspecified-local-runtime",
    providerId: "local-runtime",
    modelId: "UNSPECIFIED_LOCAL_MODEL",
    modelDisplayName: "Unspecified local model",
    artifactPath: null,
    artifactDigest: null,
    runtimeVersion: null
});

function profileValue(value, fallback, max = 512) {
    return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fallback;
}

function buildProfile(artifactPath, profile = {}) {
    return Object.freeze({
        ...DEFAULT_PROFILE,
        ...profile,
        artifactPath: profile.artifactPath ?? artifactPath,
        survivalRole: profileValue(profile.survivalRole, DEFAULT_PROFILE.survivalRole),
        runtimeId: profileValue(profile.runtimeId, DEFAULT_PROFILE.runtimeId),
        providerId: profileValue(profile.providerId, DEFAULT_PROFILE.providerId),
        modelId: profileValue(profile.modelId, DEFAULT_PROFILE.modelId),
        modelDisplayName: profileValue(profile.modelDisplayName, profile.modelId || DEFAULT_PROFILE.modelDisplayName),
        artifactDigest: profile.artifactDigest ? profileValue(profile.artifactDigest, null, 128) : null,
        runtimeVersion: profile.runtimeVersion ? profileValue(profile.runtimeVersion, null, 128) : null
    });
}

function sameProfile(a, b) {
    return a.runtimeId === b.runtimeId && a.runtimeVersion === b.runtimeVersion && a.providerId === b.providerId && a.modelId === b.modelId && a.artifactPath === b.artifactPath && a.artifactDigest === b.artifactDigest;
}

class WisesRuntime {
    constructor({ artifactPath = null, runtime = null, infer = null, recovery = null, profile = {}, maxRecoveryAttempts = 1, recoveryCooldownMs = 1000, now = () => Date.now() } = {}) {
        this.runtime = runtime;
        this.infer = infer;
        this.recovery = recovery;
        this.maxRecoveryAttempts = Math.max(0, Math.min(3, maxRecoveryAttempts | 0));
        this.recoveryCooldownMs = Math.max(0, recoveryCooldownMs | 0);
        this.recoveryAttempts = 0;
        this.lastRecoveryAt = 0;
        this.now = now;
        this.profile = buildProfile(artifactPath, profile);
        this.artifactPath = this.profile.artifactPath;
        this.state = "FAILED";
        this.lastError = "NOT_CONFIGURED";
        this.readinessPromise = null;
        this.recoveryPromise = null;
        this.readinessEpoch = 0;
        this.readinessGeneration = 0;
        this.readinessInfo = null;
    }

    async readiness() {
        if (this.state === "READY_WARM" && this.readinessInfo) return this.snapshot();
        if (this.readinessPromise) return this.readinessPromise;
        const epoch = this.readinessEpoch;
        const promise = (async () => {
            if (this.artifactPath && !fs.existsSync(this.artifactPath)) {
                this.state = "FAILED";
                this.lastError = "ARTIFACT_MISSING";
                return this.snapshot();
            }
            if (typeof this.infer !== "function" && !this.runtime?.infer && typeof this.runtime?.canary !== "function") {
                this.state = "FAILED";
                this.lastError = "RUNTIME_UNAVAILABLE";
                return this.snapshot();
            }
            this.state = "LOADING";
            try {
                if (this.runtime?.canary) await this.runtime.canary();
                else await this._infer([{ role: "user", content: "Reply only: READY" }], { readinessCanary: true, maxTokens: 8, temperature: 0 });
                if (epoch !== this.readinessEpoch) throw Object.assign(new Error("READINESS_INVALIDATED"), { failureClass: "LOCAL_RUNTIME_FAILURE" });
                this.state = "READY_WARM";
                this.lastError = null;
                this.recoveryAttempts = 0;
                this.readinessInfo = Object.freeze({
                    generation: ++this.readinessGeneration,
                    epoch,
                    canaryAtMs: this.now(),
                    canaryResult: "PASS",
                    runtimeId: this.profile.runtimeId,
                    runtimeVersion: this.profile.runtimeVersion,
                    providerId: this.profile.providerId,
                    modelId: this.profile.modelId,
                    artifactPath: this.profile.artifactPath,
                    artifactDigest: this.profile.artifactDigest
                });
            } catch (error) {
                this.state = "FAILED";
                this.lastError = String(error.message || error);
                this.readinessInfo = null;
            }
            return this.snapshot();
        })();
        this.readinessPromise = promise;
        try { return await promise; }
        finally { if (this.readinessPromise === promise) this.readinessPromise = null; }
    }

    snapshot() {
        return Object.freeze({ state: this.state, artifact: Boolean(this.artifactPath), lastError: this.lastError, recoveryAttempts: this.recoveryAttempts, profile: this.profile, readiness: this.readinessInfo });
    }

    describe() { return Object.freeze({ ...this.profile, readiness: this.state, readinessInfo: this.readinessInfo }); }

    invalidateReadiness(reason = "READINESS_INVALIDATED") {
        this.readinessEpoch++;
        this.readinessInfo = null;
        this.state = "FAILED";
        this.lastError = reason;
        return this.snapshot();
    }

    setProfile(profile = {}) {
        const next = buildProfile(this.artifactPath, profile);
        if (!sameProfile(this.profile, next)) {
            this.profile = next;
            this.artifactPath = next.artifactPath;
            this.invalidateReadiness("PROFILE_CHANGED");
        }
        return this.describe();
    }

    async recover() {
        if (this.recoveryPromise) return this.recoveryPromise;
        if (!this.recovery || typeof this.recovery.restart !== "function" || this.recoveryAttempts >= this.maxRecoveryAttempts || this.now() - this.lastRecoveryAt < this.recoveryCooldownMs) return false;
        this.recoveryPromise = (async () => {
            this.recoveryAttempts++;
            this.lastRecoveryAt = this.now();
            this.invalidateReadiness("RECOVERY_RESTART");
            this.state = "STARTING";
            try {
                await this.recovery.restart();
                const status = await this.readiness();
                return String(status.state).startsWith("READY");
            } catch (error) {
                this.state = "FAILED";
                this.lastError = String(error.message || error);
                return false;
            }
        })();
        try { return await this.recoveryPromise; }
        finally { this.recoveryPromise = null; }
    }

    async shutdown() {
        this.invalidateReadiness("SHUTDOWN");
        try { await this.runtime?.dispose?.(); } catch { /* shutdown remains best-effort */ }
    }

    async _infer(prompt, context) { return this.infer ? this.infer(prompt, context) : this.runtime.infer(prompt, context); }

    async invoke({ messages = [], entityId, role = null, entityProjection = null, continuation = null, maxTokens = null, temperature = null } = {}) {
        if (this.state !== "READY_WARM") {
            await this.readiness();
            if (this.state !== "READY_WARM") await this.recover();
        }
        if (this.state !== "READY_WARM") throw Object.assign(new Error("LOCAL_RUNTIME_NOT_READY"), { failureClass: "LOCAL_RUNTIME_FAILURE" });
        let result;
        try { result = await this._infer(messages, { entityId, role, entityProjection, continuation, maxTokens, temperature }); }
        catch (error) { this.invalidateReadiness("INFERENCE_FAILURE"); throw error; }
        if (result === undefined || result === null || result === "") {
            this.invalidateReadiness("LOCAL_RUNTIME_EMPTY_RESPONSE");
            throw Object.assign(new Error("LOCAL_RUNTIME_EMPTY_RESPONSE"), { failureClass: "LOCAL_RUNTIME_FAILURE" });
        }
        return {
            content: result,
            provider: this.profile.providerId,
            model: this.profile.modelId,
            readiness: this.state,
            provenance: {
                entityId,
                local: true,
                survivalRole: this.profile.survivalRole,
                runtimeId: this.profile.runtimeId,
                runtimeVersion: this.profile.runtimeVersion,
                modelId: this.profile.modelId,
                modelDisplayName: this.profile.modelDisplayName,
                artifactPath: this.profile.artifactPath,
                artifactDigest: this.profile.artifactDigest,
                readiness: this.readinessInfo,
                continuation: continuation ? { phase: continuation.phase ?? null, completedActionRefs: continuation.completedActionRefs ?? [] } : null
            }
        };
    }
}

module.exports = Object.freeze({ WisesRuntime });
