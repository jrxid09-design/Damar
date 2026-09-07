"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vaultMod = require("../../src/runtime/vault");
const { createTestVault } = require("../helpers/testVault");
const { ProviderFederation, EntityModelFederation, parseKeys, classifyFailure } = require("../../src/services/modelFederation");
const { WisesRuntime } = require("../../src/services/wisesRuntime");
const { createFaultAdapter } = require("../../src/services/providerFaultHarness");

test("P7: bulk keys are normalized and only Vault references leave the pool", () => {
    const vault = createTestVault(); const providers = new ProviderFederation({ vault });
    assert.deepEqual(parseKeys(" a\n b, a; c "), ["a", "b", "c"]);
    const profile = providers.addProvider({ providerId: "alpha", displayName: "Alpha", baseUrl: "http://local", keys: "key-a,key-b", adapter: createFaultAdapter() });
    assert.equal(profile.credentialCount, 2);
    assert.equal(JSON.stringify(profile).includes("key-a"), false);
    assert.equal(JSON.stringify(profile).includes("key-b"), false);
    assert.equal(profile.credentialFingerprints[0].fingerprint, "[vault-ref]");
});

test("P7: model discovery is provider-scoped and manual fallback is explicit", async () => {
    const providers = new ProviderFederation({ vault: createTestVault() });
    providers.addProvider({ providerId: "alpha", displayName: "Alpha", baseUrl: "http://local", keys: ["key"], adapter: createFaultAdapter() });
    const models = await providers.scanModels("alpha");
    assert.equal(models[0].id, "fault-model");
    assert.equal(providers.describeProvider("alpha").discoveredModels[0].context, null);
});

test("P7: typed failures drive bounded health/circuit state", async () => {
    const providers = new ProviderFederation({ vault: createTestVault(), failureThreshold: 2, cooldownMs: 1000 });
    providers.addProvider({ providerId: "bad", displayName: "Bad", baseUrl: "http://bad", keys: ["key"], adapter: createFaultAdapter("503") });
    await assert.rejects(() => providers.invoke("bad", { model: "x" }));
    await assert.rejects(() => providers.invoke("bad", { model: "x" }));
    assert.equal(providers.describeProvider("bad").healthState, "CIRCUIT_OPEN");
    assert.equal(classifyFailure({ status: 429 }), "RATE_LIMIT");
});

test("P8: assignments and overrides preserve entity identity", () => {
    const providers = new ProviderFederation({ vault: createTestVault() });
    const wises = new WisesRuntime({ infer: async () => "local" });
    const federation = new EntityModelFederation({ providers, wises });
    federation.assign("pandawa:janaka", { primaryRoute: { providerId: "alpha", modelId: "code" }, configuredFallbacks: [{ providerId: "beta", modelId: "backup" }] });
    assert.equal(federation.resolve("Arjuna").modelId, "code");
    assert.equal(federation.resolve("pandawa:janaka", { sessionOverride: { providerId: "alpha", modelId: "review" } }).modelId, "review");
    assert.equal(federation.describe("janaka").entityId, "pandawa:janaka");
    assert.equal(federation.describe("janaka").systemFallback, "wises-d1");
});

test("P9: configured route failure falls back to the same entity through Wises", async () => {
    const providers = new ProviderFederation({ vault: createTestVault() });
    providers.addProvider({ providerId: "bad", displayName: "Bad", baseUrl: "http://bad", keys: ["key"], adapter: createFaultAdapter("500") });
    const wises = new WisesRuntime({ infer: async (messages, context) => `${context?.entityId ?? "canary"}:local` });
    const federation = new EntityModelFederation({ providers, wises });
    federation.assign("pandawa:janaka", { primaryRoute: { providerId: "bad", modelId: "x" } });
    const response = await federation.invoke("pandawa:janaka", { messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.entityId, "pandawa:janaka");
    assert.equal(response.actualRoute.providerId, "wises-d1");
    assert.equal(response.fallback, true);
});

test("P9: missing real Wises runtime is honestly not ready", async () => {
    const runtime = new WisesRuntime();
    const status = await runtime.readiness();
    assert.equal(status.state, "FAILED");
    assert.equal(status.lastError, "RUNTIME_UNAVAILABLE");
    assert.throws(() => vaultMod.refs.coerceSecretRef({ value: "secret" }));
});

test('P9: unavailable Wises returns controlled degraded state', async () => {
    const providers = new ProviderFederation({ vault: createTestVault() });
    providers.addProvider({ providerId: 'bad', displayName: 'Bad', baseUrl: 'http://bad', keys: ['key'], adapter: createFaultAdapter('503') });
    const federation = new EntityModelFederation({ providers, wises: new WisesRuntime() });
    federation.assign('damar', { primaryRoute: { providerId: 'bad', modelId: 'x' } });
    const result = await federation.invoke('damar', { messages: [] });
    assert.equal(result.degraded, true);
    assert.equal(result.entityId, 'damar');
});