"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const aiRuntime = require("../../src/services/aiRuntimeService");
const recovery = require("../../src/runtime/recovery");
const { createTestVault } = require("../helpers/testVault");
const { ProviderFederation, EntityModelFederation } = require("../../src/services/modelFederation");
const { WisesRuntime } = require("../../src/services/wisesRuntime");

function federation({ adapter, infer, recoveryProvider = null, now = () => 0 } = {}) {
    const providers = new ProviderFederation({ vault: createTestVault(), now, cooldownMs: 1000, failureThreshold: 20 });
    providers.addProvider({ providerId: "remote", displayName: "Remote", baseUrl: "http://remote", keys: ["k"], adapter });
    const wises = new WisesRuntime({ profile: { providerId: "wises-d1", modelId: "Wises-D1", runtimeId: "wises-local", modelDisplayName: "Wises-D1" }, infer, recovery: recoveryProvider, maxRecoveryAttempts: 1, now });
    const f = new EntityModelFederation({ providers, wises });
    f.assign("pandawa:janaka", { primaryRoute: { providerId: "remote", modelId: "remote-model" } });
    return { providers, f, wises };
}

test("P9 repair: AIRuntimeService entity chat uses the canonical federation path", async () => {
    let remoteCalls = 0;
    const { f } = federation({ adapter: { async invoke(request) { remoteCalls++; return { content: "remote-ok", entityId: request.entityId }; } }, infer: async () => "local" });
    aiRuntime.configureModelFederation(f);
    try {
        const result = await aiRuntime.chat({ messages: [{ role: "user", content: "hello" }], entityId: "pandawa:janaka", entityProjection: { displayName: "Janaka", role: "engineering", contextRefs: ["ctx-1"] }, sessionId: "s-1" });
        assert.equal(result.content, "remote-ok");
        assert.equal(result.entityId, "pandawa:janaka");
        assert.equal(remoteCalls, 1);
    } finally { aiRuntime.clearModelFederation(); }
});

test("P9 repair: local takeover preserves identity and strips authority-shaped projection", async () => {
    let captured = null;
    const { f } = federation({ adapter: { async invoke() { const e = new Error("down"); e.status = 503; throw e; } }, infer: async (messages, context) => { captured = context; return "local-ok"; } });
    const result = await f.invoke("pandawa:janaka", { messages: [{ role: "user", content: "review" }], entityProjection: { displayName: "Janaka", role: "engineering", sessionId: "s-2", taskRef: "task-1", contextRefs: ["ctx"], skillRefs: ["skill"], authorityGrant: "must-not-cross" }, continuation: { completedActionRefs: ["exec-1"], verifiedActionRefs: ["exec-1"], pendingActionRefs: ["exec-1", "exec-2"], resultRefs: ["result-1"] } });
    assert.equal(result.entityId, "pandawa:janaka");
    assert.equal(result.actualRoute.providerId, "wises-d1");
    assert.equal(captured.entityId, "pandawa:janaka");
    assert.equal(captured.entityProjection.displayName, "Janaka");
    assert.equal(captured.entityProjection.authorityGrant, undefined);
    assert.deepEqual(captured.entityProjection.continuation.pendingActionRefs, ["exec-2"]);
});

test("P9 repair: credential traversal reaches K5 after invalid, rate-limited, timeout, invalid", async () => {
    const calls = [];
    const providers = new ProviderFederation({ vault: createTestVault(), now: () => 0, cooldownMs: 1000, failureThreshold: 20 });
    providers.addProvider({ providerId: "bulk", displayName: "Bulk", baseUrl: "http://bulk", keys: ["K1", "K2", "K3", "K4", "K5"], adapter: { async invoke({ credentialIndex }) { calls.push(credentialIndex); if (credentialIndex === 0 || credentialIndex === 3) { const e = new Error("invalid"); e.status = 401; throw e; } if (credentialIndex === 1) { const e = new Error("limited"); e.status = 429; throw e; } if (credentialIndex === 2) { const e = new Error("timeout"); e.failureClass = "CONNECT_TIMEOUT"; throw e; } return { content: "K5", credentialIndex }; } } });
    const result = await providers.invoke("bulk", { model: "m" });
    assert.equal(result.content, "K5");
    assert.deepEqual(calls, [0, 1, 2, 3, 4]);
});

test("P9 repair: local recovery hook is bounded and restores inference", async () => {
 let available = false;
 // RA3-01: structural recovery only — no provider-level cognitive canary;
 // WisesRuntime readiness runs the single canary of the recovery epoch.
 const provider = recovery.wisesProvider.createWisesRecoveryProvider({ maxAttempts: 1, restart: async () => { available = true; } });
 const runtime = new WisesRuntime({ infer: async (messages, context) => { if (!available) throw new Error("down"); return context?.readinessCanary ? "READY" : "recovered"; }, recovery: provider, maxRecoveryAttempts: 1 });
 const response = await runtime.invoke({ messages: [], entityId: "damar" });
 assert.equal(response.content, "recovered");
 assert.equal(runtime.snapshot().recoveryAttempts, 0);
 assert.equal(provider.snapshot().attempts, 1);
});

test("P9 repair: completed action remains completed in fallback continuation", async () => {
    let actionExecutions = 0;
    let localContext = null;
    const { f } = federation({ adapter: { async invoke() { actionExecutions++; const e = new Error("provider-after-action"); e.failureClass = "STREAM_FAILURE"; throw e; } }, infer: async (messages, context) => { localContext = context; return "continued-without-replay"; } });
    const result = await f.invoke("pandawa:janaka", { messages: [], continuation: { phase: "AFTER_VERIFICATION", completedActionRefs: ["exec-1"], verifiedActionRefs: ["exec-1"], pendingActionRefs: ["exec-1"] } });
    assert.equal(result.content, "continued-without-replay");
    assert.equal(actionExecutions, 1);
    assert.deepEqual(localContext.entityProjection.continuation.pendingActionRefs, []);
});


test("P9 provenance: llama.cpp profile reports actual runtime and model", async () => {
    const runtime = new WisesRuntime({ profile: { survivalRole: "system-local-survival", runtimeId: "node-llama-cpp", providerId: "local-llama-cpp", modelId: "Qwen2.5-7B-Instruct-Q4_K_M", modelDisplayName: "Qwen2.5-7B-Instruct-Q4_K_M", artifactDigest: "digest", runtimeVersion: "3.20.0" }, infer: async () => "local" });
    const result = await runtime.invoke({ entityId: "pandawa:janaka", messages: [] });
    assert.equal(result.provider, "local-llama-cpp");
    assert.equal(result.model, "Qwen2.5-7B-Instruct-Q4_K_M");
    assert.equal(result.provenance.runtimeId, "node-llama-cpp");
    assert.equal(result.provenance.survivalRole, "system-local-survival");
    assert.equal(result.provenance.entityId, "pandawa:janaka");
});

test("P9 provenance: explicit Wises profile remains available", async () => {
    const runtime = new WisesRuntime({ profile: { providerId: "wises-d1", modelId: "Wises-D1", runtimeId: "wises-local" }, infer: async () => "local" });
    const result = await runtime.invoke({ entityId: "damar", messages: [] });
    assert.equal(result.provider, "wises-d1");
    assert.equal(result.model, "Wises-D1");
});
