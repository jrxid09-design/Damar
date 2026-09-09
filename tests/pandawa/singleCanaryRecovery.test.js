"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WisesRuntime } = require("../../src/services/wisesRuntime");
const { createWisesRecoveryProvider } = require("../../src/runtime/recovery/wisesProvider");

/**
 * RA3-01 — ONE real cognitive canary per runtime/model/recovery epoch.
 * Invariant: CANARY_COUNT <= 1 per epoch. The Recovery Capsule provider
 * performs STRUCTURAL recovery only; WisesRuntime.readiness() owns the
 * single canonical cognitive canary.
 */

function runtime(infer, extra = {}) {
 return new WisesRuntime({
 profile: { runtimeId: "test-runtime", providerId: "local-test", modelId: "test-model", artifactPath: null },
 infer,
 ...extra
 });
}

test("RA3-01 provider contract: a cognitive canary at provider level is forbidden; structural check is allowed", () => {
 assert.throws(
 () => createWisesRecoveryProvider({ restart: async () => {}, canary: async () => "READY" }),
 /WISES_PROVIDER_CANARY_FORBIDDEN/,
 "the provider must not accept a cognitive inference canary"
 );
 const p = createWisesRecoveryProvider({ restart: async () => {}, structuralCheck: async () => { if (false) throw new Error("structural"); } });
 assert.equal(p.id, "wises-local");
});

test("RA3-01 A+B: cold start runs exactly one canary; warm user requests run zero", async () => {
 let canaries = 0, users = 0;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) { canaries++; return "READY"; }
 users++;
 return "ok";
 });

 // A. cold start
 await local.invoke({ entityId: "damar", messages: [] });
 assert.equal(canaries, 1, "cold epoch runs exactly one cognitive canary");
 assert.equal(local.snapshot().state, "READY_WARM");

 // B. three warm user requests
 canaries = 0;
 for (let i = 0; i < 3; i++) await local.invoke({ entityId: "damar", messages: [] });
 assert.equal(canaries, 0, "warm user requests run zero readiness canaries");
 assert.equal(users, 4, "cold user call + three warm user calls");
});

test("RA3-01 C: warm crash -> restart -> new epoch with exactly ONE canary -> retry succeeds", async () => {
 let canaries = 0, restarts = 0, users = 0;
 let warmed = false;
 let armed = true;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) { canaries++; return "READY"; }
 users++;
 if (!warmed) { warmed = true; return "warm-ok"; }
 if (armed) { armed = false; throw new Error("warm substrate crash"); }
 return "recovered-answer";
 }, {
 recovery: { restart: async () => { restarts++; } },
 maxRecoveryAttempts: 1,
 recoveryCooldownMs: 0
 });

 await local.invoke({ entityId: "damar", messages: [] }); // cold epoch: 1 canary
 const epochBefore = local.snapshot().readiness.epoch;
 canaries = 0;

 const result = await local.invoke({ entityId: "damar", messages: [{ role: "user", content: "q" }] });

 assert.equal(restarts, 1, "restart occurred");
 const snap = local.snapshot();
 assert.equal(snap.state, "READY_WARM");
 assert.notEqual(snap.readiness.epoch, epochBefore, "new opaque readiness token minted (RA4-02 exact identity)");
 assert.equal(canaries, 1, "recovery epoch ran exactly ONE cognitive canary (not two)");
 assert.equal(result.content, "recovered-answer");
 assert.equal(users, 3, "warm call + failed user call + one retry");
});

test("RA3-01 D: persistent failure -> bounded recovery, one canary per epoch, controlled degraded result", async () => {
 let canaries = 0, restarts = 0, users = 0;
 let warmed = false;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) { canaries++; return "READY"; } // restarts "succeed", inference does not
 users++;
 if (!warmed) { warmed = true; return "warm-ok"; }
 throw new Error("persistent inference failure");
 }, {
 recovery: { restart: async () => { restarts++; } },
 maxRecoveryAttempts: 2,
 recoveryCooldownMs: 0
 });

 await local.invoke({ entityId: "damar", messages: [] });
 const coldCanaries = canaries;
 canaries = 0;

 await assert.rejects(
 local.invoke({ entityId: "damar", messages: [{ role: "user", content: "q" }] }),
 error => {
 assert.equal(error.failureClass, "LOCAL_RUNTIME_FAILURE");
 assert.equal(error.message, "LOCAL_RUNTIME_FAILURE");
 return true;
 }
 );
 assert.equal(restarts, 2, "recovery attempts bounded by maxRecoveryAttempts");
 assert.ok(canaries <= restarts + 0, "no duplicate canary per epoch: canary count bounded by recovery attempt count");
 assert.equal(canaries, 2, "exactly one readiness canary per recovery epoch");
 assert.equal(local.snapshot().state, "FAILED");
 assert.ok(users >= 3);
 assert.ok(coldCanaries === 1);
});

test("RA3-01 E: concurrent post-restart requests share a single-flight readiness canary", async () => {
 let canaries = 0, restarts = 0;
 let warmed = false;
 let armed = true;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) { canaries++; await new Promise(r => setTimeout(r, 15)); return "READY"; }
 if (!warmed) { warmed = true; return "warm-ok"; }
 if (armed) { armed = false; throw new Error("crash to trigger recovery"); }
 return "post-recovery-answer";
 }, {
 recovery: { restart: async () => { restarts++; } },
 maxRecoveryAttempts: 1,
 recoveryCooldownMs: 0
 });

 await local.invoke({ entityId: "damar", messages: [] }); // warm
 canaries = 0;

 // One request triggers recovery; a second arrives while the recovery
 // epoch's readiness canary is still in flight.
 const first = local.invoke({ entityId: "damar", messages: [{ role: "user", content: "a" }] });
 await new Promise(r => setTimeout(r, 5)); // first is inside recovery/canary by now
 const second = local.invoke({ entityId: "damar", messages: [{ role: "user", content: "b" }] });
 const [r1, r2] = await Promise.all([first, second]);

 assert.equal(restarts, 1);
 assert.equal(canaries, 1, "concurrent post-restart requests share ONE single-flight canary");
 assert.equal(r1.content, "post-recovery-answer");
 assert.equal(r2.content, "post-recovery-answer");
});

test("RA3-01 F: profile/model change -> new epoch with exactly one canary", async () => {
 let canaries = 0;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) { canaries++; return "READY"; }
 return "ok";
 });

 await local.invoke({ entityId: "damar", messages: [] });
 assert.equal(canaries, 1);
 const epochBefore = local.snapshot().readiness.epoch;

 canaries = 0;
 local.setProfile({ modelId: "replacement-model" });
 await local.invoke({ entityId: "damar", messages: [] });

 const snap = local.snapshot();
 assert.equal(snap.readiness.modelId, "replacement-model");
 assert.notEqual(snap.readiness.epoch, epochBefore, "profile change minted a new opaque readiness token (RA4-02)");
 assert.equal(canaries, 1, "new epoch ran exactly ONE cognitive canary");
});
