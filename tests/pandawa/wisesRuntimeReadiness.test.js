"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WisesRuntime } = require("../../src/services/wisesRuntime");

function runtime(infer, extra = {}) {
    return new WisesRuntime({
        profile: { runtimeId: "test-runtime", providerId: "local-test", modelId: "test-model", artifactPath: null },
        infer,
        ...extra
    });
}

test("readiness canary is one-shot and user requests do not re-run it", async () => {
    let canaries = 0;
    let users = 0;
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) {
            canaries++;
            assert.deepEqual(messages, [{ role: "user", content: "Reply only: READY" }]);
            assert.equal(context.maxTokens, 8);
            return "READY";
        }
        users++;
        return "ok";
    });

    for (let i = 0; i < 6; i++) await local.invoke({ entityId: "damar", messages: [] });

 assert.equal(canaries, 1);
 assert.equal(users, 6);
 assert.equal(local.snapshot().state, "READY_WARM");
 // RA4-02: readiness lifecycle identity is an opaque exact-safe token.
 assert.match(local.snapshot().readiness.epoch, /^wrtep_[0-9a-f]{32}$/);
 assert.equal(local.snapshot().readiness.token, local.snapshot().readiness.epoch);
 assert.equal(typeof local.snapshot().readiness.generation, "undefined", "numeric generation counter removed");
});

test("readiness is single-flight for concurrent first requests", async () => {
    let canaries = 0;
    let users = 0;
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) {
            canaries++;
            await new Promise(resolve => setTimeout(resolve, 10));
            return "READY";
        }
        users++;
        return "ok";
    });

    await Promise.all(Array.from({ length: 10 }, () => local.invoke({ entityId: "damar", messages: [] })));
    assert.equal(canaries, 1);
    assert.equal(users, 10);
});

test("invalidation and profile changes require a new canary", async () => {
    let canaries = 0;
    const local = runtime(async (messages, context) => context?.readinessCanary ? (++canaries, "READY") : "ok");

    await local.invoke({ entityId: "damar", messages: [] });
    local.invalidateReadiness("RUNTIME_RESTART");
    assert.equal(local.snapshot().state, "FAILED");
    await local.invoke({ entityId: "damar", messages: [] });
    assert.equal(canaries, 2);

    local.setProfile({ modelId: "replacement-model" });
    assert.equal(local.snapshot().state, "FAILED");
    await local.invoke({ entityId: "damar", messages: [] });
    assert.equal(canaries, 3);
    assert.equal(local.snapshot().readiness.modelId, "replacement-model");
});

test("failed canary never reports READY_WARM", async () => {
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) throw new Error("canary-down");
        return "should-not-run";
    });

    await assert.rejects(local.invoke({ entityId: "damar", messages: [] }), /LOCAL_RUNTIME_NOT_READY/);
    assert.equal(local.snapshot().state, "FAILED");
    assert.equal(local.snapshot().readiness, null);
});

test("recovery invalidates readiness and runs exactly one new canary", async () => {
    let canaries = 0;
    let available = true;
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) {
            canaries++;
            if (!available) throw new Error("down");
            return "READY";
        }
        return "ok";
    }, {
        recovery: { restart: async () => { available = true; } },
        maxRecoveryAttempts: 1
    });

    await local.invoke({ entityId: "damar", messages: [] });
    available = false;
    local.invalidateReadiness("RUNTIME_FAILURE");
    available = true;
    assert.equal(await local.recover(), true);
    assert.equal(canaries, 2);
    assert.equal(local.snapshot().state, "READY_WARM");
});
