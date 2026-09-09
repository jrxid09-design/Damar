"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WisesRuntime } = require("../../src/services/wisesRuntime");

/**
 * RA4-02 — opaque readiness lifecycle token.
 *
 * SECURITY PROPERTY: a stale readiness result must NEVER establish
 * READY_WARM after invalidation, no matter how many invalidations occur.
 * Identity comparison is exact (string), never arithmetic.
 * READINESS TOKEN != AUTHORITY; only the current token is retained.
 */

function runtime(infer, extra = {}) {
 return new WisesRuntime({
 profile: { runtimeId: "test-runtime", providerId: "local-test", modelId: "test-model", artifactPath: null },
 infer,
 ...extra
 });
}

test("RA4-02: token is opaque, exact-safe, and NOT numeric", async () => {
 const local = runtime(async (messages, context) => context?.readinessCanary ? "READY" : "ok");
 await local.invoke({ entityId: "damar", messages: [] });
 const info = local.snapshot().readiness;
 assert.equal(typeof info.token, "string");
 assert.match(info.token, /^wrtep_[0-9a-f]{32}$/, "opaque 128-bit lifecycle token");
 assert.notEqual(info.token, String(Number.MAX_SAFE_INTEGER));
 assert.notEqual(info.token, String(Number.MAX_SAFE_INTEGER + 1));
 assert.equal(9007199254740993 !== info.token, true, "unsafe-precision number never equals the token");
 // No numeric dependency remains anywhere in the lifecycle identity.
 assert.equal("generation" in info, false);
});

test("RA4-02 adversarial: stale in-flight canary under token A cannot publish READY_WARM after invalidation to token B", async () => {
 const resolvers = [];
 let canaryStarted = 0;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) {
 canaryStarted++;
 await new Promise(resolve => { resolvers.push(resolve); }); // hang the canary until released
 return "READY";
 }
 return "ok";
 });

 // 1. Start readiness canary under token A (do NOT await completion).
 const inFlight = local.invoke({ entityId: "damar", messages: [] });
 await new Promise(r => setTimeout(r, 20)); // canary #1 is now hanging mid-flight
 assert.equal(local.snapshot().state, "LOADING");
 const tokenA = local.readinessToken;

 // 2. Invalidate BEFORE the canary resolves -> token B is minted.
 const snapAfterInval = local.invalidateReadiness("ADVERSARIAL_INVALIDATION");
 assert.equal(snapAfterInval.state, "FAILED");
 assert.notEqual(local.readinessToken, tokenA);

 // 4. Allow the old token-A canary to finish successfully.
 resolvers[0]();
 let inFlightError = null;
 try { await inFlight; } catch (e) { inFlightError = e; }

 // Required: the mid-flight request fails CONTROLLED (no stale success),
 // the old result is DISCARDED, and token A did NOT establish READY_WARM.
 assert.match(String(inFlightError?.message ?? ""), /LOCAL_RUNTIME_NOT_READY/, "in-flight request fails controlled, never stale-success");
 assert.equal(local.snapshot().state, "FAILED", "stale token-A canary must not publish READY_WARM");
 assert.equal(local.snapshot().readiness, null);

 // 5. Await readiness for token B: a NEW canonical canary establishes READY_WARM.
 const ready = local.invoke({ entityId: "damar", messages: [] });
 await new Promise(r => setTimeout(r, 20));
 assert.ok(canaryStarted >= 2, "token-B readiness ran its own new canary");
 resolvers[1](); // release the token-B canary
 await ready;
 assert.equal(local.snapshot().state, "READY_WARM");
 assert.match(local.snapshot().readiness.epoch, /^wrtep_[0-9a-f]{32}$/);
 assert.notEqual(local.snapshot().readiness.epoch, tokenA);
});

test("RA4-02: repeated invalidations all mint distinct tokens — no MAX_SAFE_INTEGER relevance", () => {
 const local = runtime(async (messages, context) => context?.readinessCanary ? "READY" : "ok");
 const seen = new Set();
 let previous = local.readinessToken;
 for (let i = 0; i < 10000; i++) {
 local.invalidateReadiness(`REPEATED_${i}`);
 const current = local.readinessToken;
 assert.notEqual(current, previous, `invalidation ${i} minted a fresh token`);
 assert.match(current, /^wrtep_[0-9a-f]{32}$/);
 assert.ok(!seen.has(current), "tokens never collide");
 seen.add(current);
 previous = current;
 }
 assert.equal(seen.size, 10000, "every invalidation produced a unique exact-safe identity");
 // Regression proof: numeric MAX_SAFE_INTEGER state is irrelevant — the
 // runtime carries no numeric epoch counter at all.
 assert.equal(local.readinessEpoch, undefined);
 assert.equal(local.readinessGeneration, undefined);
 assert.equal(String(Number.MAX_SAFE_INTEGER) === local.readinessToken, false);
});

test("RA4-02: every invalidation source mints a fresh token", async () => {
 const local = runtime(async (messages, context) => context?.readinessCanary ? "READY" : "ok");
 const t0 = local.readinessToken;

 // inference failure invalidation (via invoke on failed canary -> recover path not needed; direct failure)
 local.invalidateReadiness("INFERENCE_FAILURE");
 const t1 = local.readinessToken;
 assert.notEqual(t1, t0);

 // profile change invalidation
 local.setProfile({ modelId: "changed-model" });
 const t2 = local.readinessToken;
 assert.notEqual(t2, t1);

 // shutdown invalidation
 await local.shutdown();
 const t3 = local.readinessToken;
 assert.notEqual(t3, t2);

 // Recovery Capsule restart path goes through recover() -> invalidateReadiness
 const rec = runtime(async (messages, context) => context?.readinessCanary ? "READY" : "ok", {
 recovery: { restart: async () => {} }, maxRecoveryAttempts: 1, recoveryCooldownMs: 0
 });
 const r0 = rec.readinessToken;
 await rec.recover();
 const r1 = rec.readinessToken;
 assert.notEqual(r1, r0, "recovery restart minted a fresh token");
 // bounded memory: no token history retained anywhere
 const own = Object.keys(local).filter(k => /token|history|tokens/i.test(k));
 assert.deepEqual(own.sort(), ["readinessToken"], "only the CURRENT token is retained");
});

test("RA4-02: single-flight — concurrent callers under one token share ONE canary; post-invalidation callers get a new lifecycle", async () => {
 let canaries = 0;
 let release = null;
 const local = runtime(async (messages, context) => {
 if (context?.readinessCanary) {
 canaries++;
 await new Promise(r => { release = r; });
 return "READY";
 }
 return "ok";
 });

 // Same current token: 10 concurrent callers share one canary.
 const batch = Promise.all(Array.from({ length: 10 }, () => local.invoke({ entityId: "damar", messages: [] })));
 await new Promise(r => setTimeout(r, 20));
 release();
 await batch;
 assert.equal(canaries, 1, "single-flight preserved under one token");
 const tokenA = local.readinessToken;

 // After invalidation the old promise must NOT be reused: new lifecycle, new canary.
 canaries = 0;
 local.invalidateReadiness("NEW_LIFECYCLE");
 release = null;
 const batch2 = Promise.all(Array.from({ length: 10 }, () => local.invoke({ entityId: "damar", messages: [] })));
 await new Promise(r => setTimeout(r, 20));
 assert.notEqual(local.readinessToken, tokenA, "new token minted");
 release();
 await batch2;
 assert.equal(canaries, 1, "new token ran exactly ONE new canary");
 assert.match(local.snapshot().readiness.epoch, /^wrtep_[0-9a-f]{32}$/);
});
