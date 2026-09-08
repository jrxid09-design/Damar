"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WisesRuntime } = require("../../src/services/wisesRuntime");
const { EntityModelFederation, ProviderFederation } = require("../../src/services/modelFederation");
const { createTestVault } = require("../helpers/testVault");
const recovery = require("../../src/runtime/recovery");

/**
 * F-01 real-integration test: proves the Recovery Capsule provider is
 * INVOKED from the canonical production call path
 * (AIRuntimeService-shaped federation.invoke -> WisesRuntime.invoke)
 * when the local runtime fails — not merely that wisesProvider works
 * in isolation.
 */

test("F-01: canonical federation path invokes the Recovery Capsule provider on local runtime failure", async () => {
    const boundaryCalls = [];
    let substrateHealthy = false;
    let restarts = 0, canaries = 0, readinessChecks = 0;

    // Canonical bounded recovery provider (the real production component).
    const recoveryProvider = recovery.wisesProvider.createWisesRecoveryProvider({
        maxAttempts: 1,
        restart: async () => { restarts++; substrateHealthy = true; },   // in-place substrate restart
        canary: async () => { canaries++; if (!substrateHealthy) throw new Error("canary: substrate still down"); }
    });

    // Local survival runtime whose inference fails until recovery succeeds.
    const wises = new WisesRuntime({
        profile: { runtimeId: "node-llama-cpp", providerId: "local-llama-cpp", modelId: "test-local-model" },
        infer: async (messages, context) => {
            if (context?.readinessCanary) { readinessChecks++; if (!substrateHealthy) throw new Error("readiness: down"); return "READY"; }
            if (!substrateHealthy) throw new Error("inference: substrate crashed");
            return "RECOVERED_OK";
        },
        recovery: recoveryProvider,
        maxRecoveryAttempts: 1,
        recoveryCooldownMs: 0
    });

    // Canonical federation: remote route is unavailable -> survival boundary.
    const providers = new ProviderFederation({ vault: createTestVault(), cooldownMs: 1000, failureThreshold: 64 });
    providers.addProvider({
        providerId: "remote-down", displayName: "Remote Down", baseUrl: "http://remote-down/v1",
        keys: ["k"], privacyClass: "EXTERNAL_CLOUD",
        adapter: { async invoke() { const e = new Error("remote unavailable"); e.status = 503; throw e; } }
    });
    const federation = new EntityModelFederation({ providers, wises });
    federation.assign("damar", { primaryRoute: { providerId: "remote-down", modelId: "remote-model" } });

    // Production-shaped call: federation.invoke with a FAILED local runtime.
    const result = await federation.invoke("damar", { messages: [{ role: "user", content: "ping" }], entityId: "damar" });

    // Recovery Capsule provider was ACTUALLY invoked from the production path.
    assert.equal(restarts, 1, "restart must run exactly once (bounded)");
    assert.equal(canaries, 1, "canary must run exactly once");
    assert.ok(readinessChecks >= 2, "readiness re-check must run after restart");
    // Recovery succeeded -> inference resumed; not degraded.
    assert.equal(result.degraded, undefined);
    assert.equal(result.content, "RECOVERED_OK");
    assert.equal(result.entityId, "damar");
    assert.equal(result.actualRoute.providerId, "local-llama-cpp");
    assert.equal(result.provenance.runtimeId, "node-llama-cpp");
    boundaryCalls.push({ restarts, canaries, readinessChecks });
});

test("F-01: when recovery fails the canonical path returns controlled degraded state", async () => {
    let restarts = 0;
    const recoveryProvider = recovery.wisesProvider.createWisesRecoveryProvider({
        maxAttempts: 1,
        restart: async () => { restarts++; /* restart does not heal the substrate */ },
        canary: async () => { throw new Error("canary: substrate still down"); }
    });
    const wises = new WisesRuntime({
        profile: { runtimeId: "node-llama-cpp", providerId: "local-llama-cpp", modelId: "test-local-model" },
        infer: async () => { throw new Error("inference: substrate crashed"); },
        recovery: recoveryProvider,
        maxRecoveryAttempts: 1,
        recoveryCooldownMs: 0
    });
    const providers = new ProviderFederation({ vault: createTestVault(), cooldownMs: 1000, failureThreshold: 64 });
    providers.addProvider({
        providerId: "remote-down", displayName: "Remote Down", baseUrl: "http://remote-down/v1",
        keys: ["k"], privacyClass: "EXTERNAL_CLOUD",
        adapter: { async invoke() { const e = new Error("remote unavailable"); e.status = 503; throw e; } }
    });
    const federation = new EntityModelFederation({ providers, wises });
    federation.assign("damar", { primaryRoute: { providerId: "remote-down", modelId: "remote-model" } });

    const result = await federation.invoke("damar", { messages: [{ role: "user", content: "ping" }], entityId: "damar" });

    assert.equal(restarts, 1, "recovery attempt is bounded to maxAttempts");
    assert.equal(result.degraded, true, "controlled degraded state, not a fake success");
    assert.equal(result.entityId, "damar");
    assert.equal(result.failureClass, "LOCAL_RUNTIME_FAILURE");
    assert.equal(result.content, undefined, "no raw stack trace as user answer");
});

test("F-01: canonical AIRuntimeService wiring constructs WisesRuntime with a Recovery Capsule provider", () => {
    const aiRuntime = require("../../src/services/aiRuntimeService");
    const previous = aiRuntime.modelFederation;
    let constructed = null;
    try {
        // Exercise the canonical construction path directly.
        const federation = aiRuntime._configureCanonicalFederation({
            kind: "llamacpp", id: "llamacpp", label: "test", model: null
        });
        constructed = federation.wises;
        assert.ok(constructed.recovery, "canonical local runtime must carry a recovery provider");
        assert.equal(constructed.recovery.id, "wises-local");
        assert.ok(constructed.recovery.snapshot().maxAttempts >= 0 && constructed.recovery.snapshot().maxAttempts <= 3);
        assert.ok(constructed.maxRecoveryAttempts >= 0 && constructed.maxRecoveryAttempts <= 3);
        assert.ok(typeof constructed.recovery.restart === "function");
        // It is the canonical provider — no second recovery manager.
        assert.equal(constructed.recovery.snapshot().id, "wises-local");
    } finally {
        aiRuntime.modelFederation = previous;
        aiRuntime._configuredFederation = null;
    }
});
