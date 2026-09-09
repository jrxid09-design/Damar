"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");

// RA4-02: readiness lifecycle identity is an OPAQUE, exact-safe token
// (wrtep_<32 hex> from crypto.randomBytes), NOT a numeric counter.
// A numeric `readinessEpoch++` loses precision beyond Number.MAX_SAFE_INTEGER:
// at that boundary invalidation stopped changing the epoch identity, so a
// stale in-flight readiness canary could publish READY_WARM after
// invalidation. Exact string identity (`!==`) has no arithmetic semantics:
// EVERY invalidation mints a fresh token, so a stale readiness result can
// never establish READY_WARM, no matter how many invalidations occur.
// SECURITY LAW: READINESS TOKEN != AUTHORITY — the token is lifecycle
// identity only; only the CURRENT token is retained (no unbounded history).
function newReadinessToken() { return `wrtep_${crypto.randomBytes(16).toString("hex")}`; }

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
        this.readinessToken = newReadinessToken();
        this.readinessInfo = null;
    }

    async readiness() {
        if (this.state === "READY_WARM" && this.readinessInfo) return this.snapshot();
        // RA4-02 single-flight: concurrent callers sharing the CURRENT token
        // share one readiness operation/canary. An old-token promise is never
        // reused as valid readiness for a newer token — the token capture
        // below discards any result that was invalidated mid-flight.
        const promise = this.readinessPromise;
        if (promise && promise.token === this.readinessToken) return promise.promise;
        const capturedToken = this.readinessToken;
        const wrapped = (async () => {
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
                // RA4-02 SECURITY PROPERTY: a stale readiness result must
                // NEVER establish READY_WARM after invalidation. Exact
                // identity comparison — no arithmetic, no precision.
                if (capturedToken !== this.readinessToken) throw Object.assign(new Error("READINESS_INVALIDATED"), { failureClass: "LOCAL_RUNTIME_FAILURE" });
                this.state = "READY_WARM";
                this.lastError = null;
                this.recoveryAttempts = 0;
                this.readinessInfo = Object.freeze({
                    token: capturedToken,
                    epoch: capturedToken,
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
                // Only the CURRENT token may publish failure state for its own
                // epoch; a stale attempt leaves the newer lifecycle untouched.
                if (capturedToken === this.readinessToken) {
                    this.state = "FAILED";
                    this.lastError = String(error.message || error);
                    this.readinessInfo = null;
                }
            }
            return this.snapshot();
        })();
        wrapped.token = capturedToken;
        const entry = { token: capturedToken, promise: wrapped };
        this.readinessPromise = entry;
        try { return await wrapped; }
        finally { if (this.readinessPromise === entry) this.readinessPromise = null; }
    }

    snapshot() {
        return Object.freeze({ state: this.state, artifact: Boolean(this.artifactPath), lastError: this.lastError, recoveryAttempts: this.recoveryAttempts, profile: this.profile, readiness: this.readinessInfo });
    }

    describe() { return Object.freeze({ ...this.profile, readiness: this.state, readinessInfo: this.readinessInfo }); }

    invalidateReadiness(reason = "READINESS_INVALIDATED") {
        // RA4-02: every invalidation mints a FRESH opaque readiness token —
        // exact-safe identity that can never collide with a prior token.
        // Covers ALL invalidation sources (restart, profile/model change,
        // inference failure, shutdown, Recovery Capsule restart, explicit
        // calls): no path merely mutates state while retaining the old
        // token, so every prior in-flight readiness attempt becomes stale.
        this.readinessToken = newReadinessToken();
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
 // RA3-01 single-canary ownership: this method performs STRUCTURAL
 // recovery only (invalidate readiness -> provider restart -> request
 // readiness verification). The provider runs no cognitive inference;
 // readiness() below executes the ONE canonical cognitive canary of
 // the new recovery epoch (invariant: CANARY_COUNT <= 1 per epoch).
 if (this.recoveryPromise) return this.recoveryPromise;
        if (!this.recovery || typeof this.recovery.restart !== "function" || this.recoveryAttempts >= this.maxRecoveryAttempts || this.now() - this.lastRecoveryAt < this.recoveryCooldownMs) return false;
        this.recoveryPromise = (async () => {
            this.recoveryAttempts++;
            this.lastRecoveryAt = this.now();
            this.invalidateReadiness("RECOVERY_RESTART");
            this.state = "STARTING";
 try {
 await this.recovery.restart();
 // RA3-01: readiness() re-check is the ONE cognitive canary of this
 // new epoch (provider ran structural recovery only — no inference).
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
// RC-01: a warm inference failure must NOT bypass recovery. Canonical
// sequence per request: READY_WARM -> user inference -> failure ->
// invalidate readiness -> bounded Recovery Capsule (structural restart ->
// readiness re-check) -> retry the ORIGINAL user inference.
// RA3-01: each epoch (cold, post-recovery, post-profile-change) runs
// exactly ONE real cognitive canary — the readiness() re-check below;
// warm user requests run zero readiness canaries (CANARY_COUNT <= 1).
// Bounded: at most maxRecoveryAttempts recovery invocations and one
// retry per successful recovery per request — infer/fail/recover can
// never loop forever. The retry reuses the caller's continuation
// untouched: MODEL RECOVERY != ACTION REPLAY (completed/verified
// actions are never re-executed here; WisesRuntime runs no actions).
        const maxRetries = this.maxRecoveryAttempts;
        for (let attempt = 0; ; attempt++) {
            let result;
            try { result = await this._infer(messages, { entityId, role, entityProjection, continuation, maxTokens, temperature }); }
            catch (error) {
                this.invalidateReadiness("INFERENCE_FAILURE");
                if (attempt >= maxRetries || !(await this.recover())) {
                    throw Object.assign(new Error("LOCAL_RUNTIME_FAILURE"), { failureClass: "LOCAL_RUNTIME_FAILURE", cause: String(error.message || error) });
                }
                continue;
            }
            if (result === undefined || result === null || result === "") {
                this.invalidateReadiness("LOCAL_RUNTIME_EMPTY_RESPONSE");
                if (attempt >= maxRetries || !(await this.recover())) {
                    throw Object.assign(new Error("LOCAL_RUNTIME_EMPTY_RESPONSE"), { failureClass: "LOCAL_RUNTIME_FAILURE" });
                }
                continue;
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
}

module.exports = Object.freeze({ WisesRuntime });
