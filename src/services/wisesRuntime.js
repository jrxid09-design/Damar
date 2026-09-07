"use strict";

const fs = require("node:fs");

class WisesRuntime {
    constructor({ artifactPath = null, runtime = null, infer = null, now = () => Date.now() } = {}) { this.artifactPath = artifactPath; this.runtime = runtime; this.infer = infer; this.now = now; this.state = "FAILED"; this.lastError = "NOT_CONFIGURED"; }
    async readiness() {
        if (this.artifactPath && !fs.existsSync(this.artifactPath)) { this.state = "FAILED"; this.lastError = "ARTIFACT_MISSING"; return this.snapshot(); }
        if (typeof this.infer !== "function" && !this.runtime?.infer) { this.state = "FAILED"; this.lastError = "RUNTIME_UNAVAILABLE"; return this.snapshot(); }
        this.state = "LOADING";
        try { await (this.runtime?.canary ? this.runtime.canary() : this._infer("readiness")); this.state = "READY_WARM"; this.lastError = null; } catch (error) { this.state = "FAILED"; this.lastError = String(error.message || error); }
        return this.snapshot();
    }
    snapshot() { return Object.freeze({ state: this.state, artifact: Boolean(this.artifactPath), lastError: this.lastError }); }
    async _infer(prompt, context) { return this.infer ? this.infer(prompt, context) : this.runtime.infer(prompt, context); }
    async invoke({ messages = [], entityId, role = null } = {}) { if (!this.state.startsWith("READY")) await this.readiness(); if (!this.state.startsWith("READY")) throw Object.assign(new Error("WISES_NOT_READY"), { failureClass: "LOCAL_RUNTIME_FAILURE" }); const result = await this._infer(messages, { entityId, role }); if (result === undefined || result === null || result === "") throw Object.assign(new Error("WISES_EMPTY_RESPONSE"), { failureClass: "LOCAL_RUNTIME_FAILURE" }); return { content: result, provider: "wises-d1", model: "Wises-D1", readiness: this.state, provenance: { entityId, local: true } }; }
}

module.exports = Object.freeze({ WisesRuntime });
