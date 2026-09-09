"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WisesRuntime } = require("../../src/services/wisesRuntime");
const { EntityModelFederation, ProviderFederation } = require("../../src/services/modelFederation");
const { createTestVault } = require("../helpers/testVault");

/**
 * RC-01 — warm local inference failure must enter the canonical bounded
 * Recovery Capsule within the SAME request, then retry the original user
 * inference under bounded policy. MODEL RECOVERY != ACTION REPLAY.
 */

function runtime(infer, extra = {}) {
    return new WisesRuntime({
        profile: { runtimeId: "test-runtime", providerId: "local-test", modelId: "test-model", artifactPath: null },
        infer,
        ...extra
    });
}

test("RC-01 A: warm inference fails once -> recovery restart + canary -> retried inference succeeds", async () => {
    let restarts = 0, canaries = 0, userInferences = 0;
    let warmed = false;
    let warmFailureArmed = false;
    let substrateDown = false;
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) { canaries++; if (substrateDown) throw new Error("canary: down"); return "READY"; }
        if (!warmed) { warmed = true; userInferences++; return "warm-ok"; }
        userInferences++;
        if (warmFailureArmed) { warmFailureArmed = false; substrateDown = true; throw new Error("inference: warm substrate crashed"); }
        if (substrateDown) throw new Error("inference: still down");
        return "recovered-answer";
    }, {
        recovery: { restart: async () => { restarts++; substrateDown = false; } },
        maxRecoveryAttempts: 1,
        recoveryCooldownMs: 0
    });

    // Warm up: canary passes, runtime READY_WARM.
    await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "warm" }] });
    assert.equal(local.snapshot().state, "READY_WARM");
    assert.equal(restarts, 0);

    // User inference begins while warm, then the substrate fails.
    warmFailureArmed = true;
    const result = await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "user question" }], continuation: { phase: "EXECUTE", completedActionRefs: ["act_1"] } });

    // Same-request bounded recovery happened and the user got a real result.
    assert.equal(restarts, 1, "recovery must be invoked exactly once");
    assert.equal(canaries, 2, "restart must be followed by a fresh readiness canary");
    assert.equal(userInferences, 3, "one warm call + failed user call + one retry");
    assert.equal(result.content, "recovered-answer");
    assert.equal(result.readiness, "READY_WARM");
    assert.equal(result.provenance.continuation.phase, "EXECUTE", "retry reuses the canonical continuation state");
    assert.deepEqual(result.provenance.continuation.completedActionRefs, ["act_1"]);
});

test("RC-01 B: warm inference fails and recovery fails -> controlled degraded result, no fake content", async () => {
    let restarts = 0;
    let warmed = false;
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) return "READY";
        if (!warmed) { warmed = true; return "warm-ok"; }
        throw new Error("inference: warm substrate crashed");
    }, {
        recovery: { restart: async () => { restarts++; } },
        maxRecoveryAttempts: 1,
        recoveryCooldownMs: 0
    });

    await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "warm" }] });
    assert.equal(local.snapshot().state, "READY_WARM");

    // WisesRuntime itself throws a CONTROLLED error (classified, no raw stack).
    await assert.rejects(
        local.invoke({ entityId: "damar", messages: [{ role: "user", content: "q" }] }),
        error => {
            assert.equal(error.failureClass, "LOCAL_RUNTIME_FAILURE");
            assert.equal(error.message, "LOCAL_RUNTIME_FAILURE");
            assert.doesNotMatch(error.message, /stack|at /i);
            return true;
        }
    );
    assert.equal(restarts, 1, "recovery was attempted exactly once before failing");

    // Through the canonical federation the caller gets a degraded envelope.
    const providers = new ProviderFederation({ vault: createTestVault(), cooldownMs: 1000, failureThreshold: 64 });
    providers.addProvider({
        providerId: "remote-down", displayName: "Remote Down", baseUrl: "http://remote-down/v1",
        keys: ["k"], privacyClass: "EXTERNAL_CLOUD",
        adapter: { async invoke() { const e = new Error("remote unavailable"); e.status = 503; throw e; } }
    });
    const federation = new EntityModelFederation({ providers, wises: local });
    federation.assign("damar", { primaryRoute: { providerId: "remote-down", modelId: "remote-model" } });
    const result = await federation.invoke("damar", { messages: [{ role: "user", content: "ping" }], entityId: "damar" });
    assert.equal(result.degraded, true);
    assert.equal(result.failureClass, "LOCAL_RUNTIME_FAILURE");
    assert.equal(result.content, undefined, "no stack trace and no fabricated content");
    assert.equal(result.entityId, "damar");
});

test("RC-01 C: inference keeps failing after successful restarts -> bounded attempts, no infinite loop", async () => {
    let local = null;
    let restarts = 0, userInferences = 0;
    let warmed = false;
    local = runtime(async (messages, context) => {
        if (context?.readinessCanary) return "READY"; // restart + canary always "succeed"
        if (!warmed) { warmed = true; return "warm-ok"; }
        userInferences++;
        throw new Error("inference: persistent substrate failure");
    }, {
        recovery: { restart: async () => { restarts++; } },
        maxRecoveryAttempts: 2,
        recoveryCooldownMs: 0
    });

    await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "warm" }] });
    assert.equal(local.snapshot().state, "READY_WARM");

    await assert.rejects(
        local.invoke({ entityId: "damar", messages: [{ role: "user", content: "q" }] }),
        /LOCAL_RUNTIME_FAILURE/
    );
    assert.equal(restarts, 2, "recovery attempts are bounded by maxRecoveryAttempts");
    assert.equal(userInferences, 3, "initial user attempt + one retry per successful recovery");
    assert.equal(local.snapshot().state, "FAILED");
});

test("RC-01 D: verified action completed before the crash stays completed — no replay on recovery retry", async () => {
    let restarts = 0;
    let actionExecutions = 0, actionReplays = 0;
    let warmed = false;
    let warmFailureArmed = false;
    let seenContinuations = [];
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) return "READY";
        if (!warmed) { warmed = true; return "warm-ok"; }
        seenContinuations.push(context?.continuation ?? null);
        if (warmFailureArmed) { warmFailureArmed = false; throw new Error("inference: crashed after verified action"); }
        return "answer-after-recovery";
    }, {
        recovery: { restart: async () => { restarts++; } },
        maxRecoveryAttempts: 1,
        recoveryCooldownMs: 0
    });

    await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "warm" }] });
    assert.equal(local.snapshot().state, "READY_WARM");

    // One verified action completed BEFORE the warm crash. A recovering
    // model call must see it as already-completed context — the runtime
    // never re-executes actions (execution lives in Actuation, not here).
    warmFailureArmed = true;
    const continuation = { phase: "EXECUTE", completedActionRefs: ["act_verified_1"], verifiedActionRefs: ["act_verified_1"] };
    const result = await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "continue work" }], continuation });

    assert.equal(result.content, "answer-after-recovery");
    assert.equal(restarts, 1);
    assert.equal(seenContinuations.length, 2, "failed attempt + one retry");
    for (const seen of seenContinuations) {
        assert.equal(seen, continuation, "both attempts use the SAME canonical continuation object");
        assert.deepEqual(seen.completedActionRefs, ["act_verified_1"]);
    }
    assert.equal(actionExecutions, 0, "WisesRuntime never executes actions");
    assert.equal(actionReplays, 0, "WisesRuntime never replays actions");
    assert.equal(result.provenance.continuation.completedActionRefs.length, 1, "completed action stays completed");
});

test("RC-01: cold path with no recovery provider is unchanged (LOCAL_RUNTIME_NOT_READY)", async () => {
    const local = runtime(async (messages, context) => {
        if (context?.readinessCanary) throw new Error("canary down");
        return "never";
    });
    await assert.rejects(local.invoke({ entityId: "damar", messages: [] }), /LOCAL_RUNTIME_NOT_READY/);
    assert.equal(local.snapshot().state, "FAILED");
});
