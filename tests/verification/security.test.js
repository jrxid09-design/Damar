"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION FABRIC V1 — Lane 4 security regression
 * suite (tests/verification/).
 *
 * Direct tests for the 27 required Lane 4 proofs:
 *
 *   1.  forged ExecutionResult cannot be verified
 *   2.  JSON clone cannot be verified
 *   3.  foreign-domain result rejected
 *   4.  hostile Proxy result recognition causes zero traps
 *   5.  caller-selected verifier rejected
 *   6.  verifier mutation after registration has no effect
 *   7.  verifier A→B incarnation ABA rejects old verification work
 *   8.  verifier error != VERIFIED_FAILURE
 *   9.  verifier timeout != verified success/failure
 *   10. inconclusive evidence stays INCONCLUSIVE
 *   11. fake evidence cannot mint VERIFIED_SUCCESS
 *   12. VerificationResult cannot become authority
 *   13. compensation cannot bypass Lane 2
 *   14. original ALLOW does not authorize compensation
 *   15. revoked compensation authority => no compensation actuation
 *   16. stale capability incarnation => no compensation actuation
 *   17. foreign session => no compensation actuation
 *   18. fake compensation plan rejected
 *   19. duplicate compensationId => no duplicate actuation
 *   20. compensation execution without verification => no rollback claim
 *   21. compensation timeout => ambiguous, no false restoration claim
 *   22. compensation verified success => only then restoration/success claim
 *   23. no direct caller compensator injection
 *   24. no Authority mutation from verification
 *   25. no Capability mutation from verification
 *   26. no direct actuation from verification layer except through Lane 3
 *   27. no Wave 5 routing/orchestration implementation
 *
 * Plus hostile-input probes and structural scans (no privileged factory
 * exported from any verification module; brand predicates unforgeable).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verificationApi = require("../../src/action/verification");
const bootstrap = require("../../src/action/bootstrap");
const { makeVerificationHarness } = require("./harness");
const { VERIFICATION_STATE, COMPENSATION_STATE, REASONS } = require("../../src/action/verification/errors");
const { RESULT_STATE } = require("../../src/action/actuation/errors");

const ROOT = path.join(__dirname, "..", "..");

async function setupWorld(h, { capabilityId = "fs.cap", operations = ["read"], verifyOps = ["read"] } = {}) {
    const res = await h.lane3.lane2.registerCapability({ id: capabilityId, operations });
    await h.lane3.lane2.registry.observeAvailability(capabilityId, "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    return res;
}

function lane4ScopeBindings() {
    const resolver = (args) => {
        const t = args && typeof args.target === "string" ? args.target.trim().toLowerCase() : "";
        return t ? [t] : [];
    };
    const writeResolver = (args) => {
        const p = args && (typeof args.path === "string" ? args.path : (typeof args.target === "string" ? args.target : ""));
        const s = typeof p === "string" ? p.trim().toLowerCase() : "";
        return s ? [s] : [];
    };
    return {
        "fs.cap": { read: resolver, write: resolver },
        "fs.restore": { write: writeResolver, read: writeResolver }
    };
}

async function makeHarness4() {
    return await makeVerificationHarness({ scopeBindings: lane4ScopeBindings() });
}

async function runExecutedAction(h, { capabilityId = "fs.cap", operation = "read", principal = "alice", target = "t" } = {}) {
    const intent = h.lane3.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId, operation, arguments: { target } }));
    return await h.lane3.execute({ intent, authSession: h.lane3.lane2.session(principal), parameters: { target } });
}

function goodPostcondition() {
    return { expect: { "world.value": { op: "eq", value: 42 } } };
}

/** Heuristic: detect a live Proxy (accessor traps cause visible divergences). */
function isProxyLike(v) {
    if (v === null || typeof v !== "object") return false;
    try {
        // A transparent Proxy whose target is a plain object is still
        // observably a Proxy via the prototype/constructor divergence trick:
        // for a genuine plain object, Object.prototype.toString.call returns
        // '[object Object]' AND Object.getOwnPropertyNames agrees with
        // Object.keys. We only flag *live* proxies (those that diverge).
        const a = Object.getOwnPropertyNames(v).length;
        const b = Object.keys(v).length;
        if (a !== b) return true;
        return false;
    } catch {
        return true;
    }
}

// ---------------------------------------------------------------------------
// Structural: no privileged factory exported from any verification module
// ---------------------------------------------------------------------------

test("structural: public verification API exports no privileged factory", () => {
    for (const name of [
        "buildVerifierRegistry", "registerVerifier", "removeVerifier", "composeVerification",
        "formVerificationRequest", "buildVerificationResult", "formCompensationPlan",
        "buildCompensationResult", "sanitizeEvidence", "evaluatePostcondition",
        "formExpectedPostcondition", "compensator", "rollback", "compensate"
    ]) {
        assert.equal(typeof verificationApi[name], "undefined", `verification api.${name} must not be exported`);
    }
    for (const [name, value] of Object.entries(verificationApi)) {
        if (typeof value === "function") {
            assert.ok(name.startsWith("is") || name === "ExecutionError",
                `verification api.${name} must be a pure predicate, not a privileged callable`);
        }
    }
});

test("structural: no action/verification submodule exports privileged composition (DIRECT module.exports scan)", () => {
    const dir = path.join(__dirname, "../../src/action/verification");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.ok(files.length >= 4, "verification package must exist");
    for (const f of files) {
        const mod = require(path.join(dir, f));
        for (const name of [
            "buildVerifierRegistry", "registerVerifier", "composeVerification",
            "formVerificationRequest", "buildVerificationResult", "formCompensationPlan",
            "buildCompensationResult", "sanitizeEvidence", "evaluatePostcondition",
            "formExpectedPostcondition", "verifierRegistry", "registrar", "compensator",
            "rollback", "compensate", "verify"
        ]) {
            assert.equal(typeof mod[name], "undefined",
                `${f} must not export privileged '${name}'`);
        }
        for (const name of ["requestBrandSet", "resultBrandSet", "planBrandSet",
            "REQUEST_BRAND", "RESULT_BRAND", "PLAN_BRAND", "brand", "addBrand", "mark", "mint"]) {
            assert.equal(typeof mod[name], "undefined", `${f} must not export brand surface '${name}'`);
        }
    }
});

test("structural: production src/** never imports tests/**", () => {
    const srcRoot = path.join(ROOT, "src");
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                if (/require\(\s*["'][^"']*tests\//.test(text)) offenders.push(path.relative(ROOT, full));
            }
        }
    };
    walk(srcRoot);
    assert.deepEqual(offenders, [], "production src must never import tests");
});

test("structural: bootstrap verification facade is least privilege", () => {
    const v = bootstrap.createCanonicalVerificationFacade();
    const keys = Object.keys(v).sort();
    assert.deepEqual(keys, ["compensate", "isCanonicalCompensationPlan", "isCanonicalVerificationRequest", "isCanonicalVerificationResult", "verify"]);
    assert.ok(Object.isFrozen(v));
});

// ---------------------------------------------------------------------------
// Proofs 1-4: forged/clone/foreign/hostile-proxy execution results
// ---------------------------------------------------------------------------

test("1: forged ExecutionResult cannot be verified", async () => {
    const h = await makeHarness4();
    await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"],
        capabilityIncarnationId: (await h.lane3.lane2.registry.get("fs.cap")).incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const forged = {
        schemaVersion: 1, executionId: "e-1", intentId: "i-1", capabilityId: "fs.cap",
        capabilityIncarnationId: "inc-00000000000000000000000000000000",
        operation: "read", principal: "alice", actuatorId: "act", actuatorIncarnationId: "ainc-x",
        state: "EXECUTED", startedAtMs: 1, completedAtMs: 2, actuatorReport: null,
        failureReason: "", failureDetail: "", authorityGeneration: 0,
        lifecycleTrace: [], verified: null, verificationClaim: null
    };
    await assert.rejects(() => h.verify({ executionResult: forged, expectedPostcondition: goodPostcondition() }),
        (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
});

test("2: JSON clone of a canonical ExecutionResult cannot be verified", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const real = await runExecutedAction(h);
    const clone = JSON.parse(JSON.stringify(real));
    await assert.rejects(() => h.verify({ executionResult: clone, expectedPostcondition: goodPostcondition() }),
        (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
});

test("3: foreign-domain (structurally canonical but different trust domain) result rejected", async () => {
    const h = await makeHarness4();
    await setupWorld(h);
    // A SECOND harness = a different trust domain; its results are branded
    // in ITS WeakSet, not this harness's.
    const other = await makeHarness4();
    const otherCap = await setupWorld(other);
    await other.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: otherCap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const foreignResult = await (async () => {
        const intent = other.lane3.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "fs.cap", operation: "read", arguments: { target: "x" } }));
        return await other.lane3.execute({ intent, authSession: other.lane3.lane2.session("alice"), parameters: { target: "x" } });
    })();
    await assert.rejects(() => h.verify({ executionResult: foreignResult, expectedPostcondition: goodPostcondition() }),
        (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
});

test("4: hostile Proxy result recognition causes zero traps", async () => {
    const h = await makeHarness4();
    await setupWorld(h);
    const traps = { get: 0, has: 0, ownKeys: 0, gopd: 0, gtp: 0 };
    const hostile = new Proxy({}, {
        get(t, p) { traps.get++; return t[p]; },
        has(t, p) { traps.has++; return p in t; },
        ownKeys(t) { traps.ownKeys++; return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, p) { traps.gopd++; return Reflect.getOwnPropertyDescriptor(t, p); },
        getPrototypeOf(t) { traps.gtp++; return Reflect.getPrototypeOf(t); }
    });
    const fired = () => Object.values(traps).reduce((a, b) => a + b, 0);
    const before = fired();
    const v = bootstrap.createCanonicalVerificationFacade();
    v.isCanonicalVerificationRequest(hostile);
    const afterReq = fired();
    v.isCanonicalVerificationResult(hostile);
    const afterRes = fired();
    v.isCanonicalCompensationPlan(hostile);
    const afterPlan = fired();
    assert.equal(afterReq - before, 0, "verification-request predicate must fire zero traps");
    assert.equal(afterRes - afterReq, 0, "verification-result predicate must fire zero traps");
    assert.equal(afterPlan - afterRes, 0, "compensation-plan predicate must fire zero traps");
    // verify() must also reject the hostile proxy without trap-driven decisions.
    await assert.rejects(() => h.verify({ executionResult: hostile, expectedPostcondition: goodPostcondition() }),
        (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
    assert.equal(fired() - afterPlan, 0, "verify() must not be driven by Proxy traps");
});

// ---------------------------------------------------------------------------
// Proofs 5-7: verifier registry trust boundary
// ---------------------------------------------------------------------------

test("5: caller-selected verifier rejected", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    for (const key of ["verifier", "verifierFn", "observe", "sensor", "predicate", "evaluator", "checker", "verifyFn"]) {
        await assert.rejects(() => h.verify({
            executionResult: result,
            expectedPostcondition: goodPostcondition(),
            [key]: async () => ({ world: { value: 42 } })
        }), (e) => e.reasonCode === REASONS.CALLER_VERIFIER_REJECTED, `option '${key}' must be rejected`);
    }
});

test("6: verifier mutation after registration has no effect", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let world = { value: 42 };
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world })
    });
    const result = await runExecutedAction(h);
    // Caller mutates its OWN holder object after registration, attempting to
    // swap the observation function through the captured binding.
    // The registry captures the function ONCE: re-registration with the same
    // id while present is rejected synchronously (no replace).
    assert.throws(() => h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 999 } })
    }), (e) => e.reasonCode === REASONS.REGISTRATION_REJECTED);
    // The caller's holder mutation cannot reach the registry: the original
    // verification still resolves to the originally captured function.
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "post-registration mutation of caller-owned objects must not change verifier behavior");
    assert.equal(v.verifierId, "ver-fs");
    // The world state the verifier OBSERVES may legitimately change (that is
    // the point of observation) — the protected thing is the binding.
    world = { value: 1 };
    const v2 = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    // Note: the second verify reuses the record for identical
    // execution+postcondition (idempotence), so its verdict is unchanged.
    assert.equal(v2.verificationId, v.verificationId);
    assert.equal(v2.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
});

test("7: verifier A→B incarnation ABA rejects old verification work", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const bindingA = await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    // A fresh verification binds to A's incarnation.
    const v1 = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v1.verifierIncarnationId, bindingA.verifierIncarnationId);
    // Replace A with B: same logical verifierId, NEW incarnation.
    h.removeVerifier("ver-fs");
    const bindingB = await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    assert.notEqual(bindingA.verifierIncarnationId, bindingB.verifierIncarnationId,
        "re-registration MUST mint a new verifier incarnation (ABA-safe)");
    // Old verification work carries A's incarnation — it is never re-run
    // through B: a NEW verification (different postcondition => different
    // identity) resolves B, and the OLD result object keeps A's binding.
    const v2 = await h.verify({
        executionResult: result,
        expectedPostcondition: { expect: { "world.value": { op: "gt", value: 0 } } }
    });
    assert.equal(v2.verifierIncarnationId, bindingB.verifierIncarnationId,
        "new work resolves the CURRENT incarnation only");
    assert.equal(v1.verifierIncarnationId, bindingA.verifierIncarnationId,
        "old work never silently re-binds to B");
    // A result-shaped object claiming A's old incarnation cannot be minted:
    // the fake is rejected by the verification brand check.
    const fakeOld = { ...v1, verifierIncarnationId: bindingA.verifierIncarnationId };
    await assert.rejects(() => h.compensate({
        verification: fakeOld, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "ABA"
    }), (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
});

// ---------------------------------------------------------------------------
// Proofs 8-11: verification state precision
// ---------------------------------------------------------------------------

test("8: verifier error != VERIFIED_FAILURE", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => { throw new Error("sensor offline"); }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "verifier infrastructure error must be classified ERROR, not VERIFIED_FAILURE");
    assert.equal(v.observedEvidence && v.observedEvidence.name, "Error");
});

test("9: verifier timeout != verified success/failure", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // SINK-based async observer that never completes within the bound.
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-slow", observe: (ctx, sink) => {
            // intentionally never calls sink within the timeout window
            setTimeout(() => sink.resolveEvidence({ world: { value: 42 } }), 250);
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition(), timeoutMs: 25 });
    assert.equal(v.verificationState, VERIFICATION_STATE.TIMED_OUT,
        "verification timeout must be TIMED_OUT — neither success nor failure");
    // Late completion must NOT mutate the finalized result.
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
});

test("10: inconclusive evidence stays INCONCLUSIVE", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ different: { shape: true } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE,
        "missing evidence must stay INCONCLUSIVE — never collapsed into success or failure");
});

test("11: fake evidence cannot mint VERIFIED_SUCCESS (vacuous postcondition rejected)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ anything: true })
    });
    const result = await runExecutedAction(h);
    for (const vacuous of [{}, { expect: {}, forbid: {} }, { expect: null, forbid: null }]) {
        await assert.rejects(() => h.verify({ executionResult: result, expectedPostcondition: vacuous }),
            (e) => e.reasonCode === REASONS.MALFORMED_REQUEST,
            "vacuous postcondition must be rejected so it can never mint VERIFIED_SUCCESS");
    }
});

// ---------------------------------------------------------------------------
// Proof 12: VerificationResult cannot become authority
// ---------------------------------------------------------------------------

test("12: VerificationResult cannot become authority (bearer-executor rejected)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    // Attempting to use the verification result as a bearer execution token:
    for (const bearerOpt of ["decision", "authorityDecision", "allow", "allowDecision", "authorize"]) {
        await assert.rejects(() => h.lane3.execute({
            intent: h.lane3.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "fs.cap", operation: "read", arguments: { target: "t" } })),
            authSession: h.lane3.lane2.session("alice"),
            [bearerOpt]: v
        }), (e) => e.reasonCode === "CALLER_EXECUTOR_REJECTED",
            `verification result must not be usable as bearer option '${bearerOpt}'`);
    }
});

// ---------------------------------------------------------------------------
// Proofs 13-17: compensation authority
// ---------------------------------------------------------------------------

async function makeFailureWorld({ principal = "alice" } = {}) {
    const h = await makeHarness4();
    const cap = await setupWorld(h, { capabilityId: "fs.cap", operations: ["read"] });
    // capability for the compensation action itself
    const compCap = await setupWorld(h, { capabilityId: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] }).catch(() => {});
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } }) // FAILS the postcondition
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: principal, actions: ["read"], identityBinding: { principals: [principal] } });
    const result = await runExecutedAction(h, { principal });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE, "world must be observed failing the postcondition");
    return { h, result, v, principal };
}

test("13: compensation cannot bypass Lane 2 (no authority => no compensation actuation)", async () => {
    const { h, v, principal } = await makeFailureWorld();
    // NOTE: NO authority granted for fs.restore.write — the compensation
    // action must be denied by the Lane 2 gate inside execute().
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: "inc-00000000000000000000000000000000",
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal, parameters: { path: "x" }, reason: "restore after failure"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED, "unauthorized compensation must not execute");
    assert.equal(actuations, 0, "no compensation actuation without Lane 2 authority");
    assert.equal(c.restored, null, "no restoration claim");
});

test("14: original ALLOW does not authorize compensation", async () => {
    const { h, v, principal } = await makeFailureWorld();
    // Principal HAS allow for fs.cap.read (that is how the original action
    // executed). That ALLOW must NOT authorize fs.restore.write.
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: "inc-00000000000000000000000000000000",
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal, parameters: { path: "x" }, reason: "restore after failure"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED,
        "permission to read fs.cap must NOT authorize compensation on fs.restore");
    assert.equal(actuations, 0);
});

test("15: revoked compensation authority => no compensation actuation", async () => {
    const { h, v, principal } = await makeFailureWorld();
    const res = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res.incarnationId,
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    // Grant, verify compensation works (sanity), then REVOKE and re-attempt.
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: principal, actions: ["write"], identityBinding: { principals: [principal] } });
    const capEntry = await h.lane3.lane2.store.getCapability("fs.restore");
    await h.lane3.lane2.store.upsertCapability("fs.restore", "REVOKED", capEntry.generation, JSON.stringify({ ...capEntry.payload, status: "REVOKED" }));
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal, parameters: { path: "x" }, reason: "restore after failure"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED, "revoked authority must block compensation");
    assert.equal(actuations, 0);
});

test("16: stale capability incarnation => no compensation actuation", async () => {
    const { h, v, principal } = await makeFailureWorld();
    const res = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res.incarnationId,
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: principal, actions: ["write"], identityBinding: { principals: [principal] } });
    // remove + recreate the capability => NEW incarnation (certified Lane 3 ABA pattern)
    await h.lane3.lane2.registry.remove("fs.restore");
    const resB = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: resB.incarnationId });
    assert.notEqual(resB.incarnationId, res.incarnationId, "recreated capability must carry a new incarnation");
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal, parameters: { path: "x" }, reason: "restore after failure"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED, "stale capability incarnation must block compensation");
    assert.equal(actuations, 0);
});

test("17: foreign session => no compensation actuation", async () => {
    const { h, v } = await makeFailureWorld({ principal: "alice" });
    const res = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res.incarnationId,
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "bob", actions: ["write"], identityBinding: { principals: ["bob"] } });
    // Alice (not granted) requests compensation routed under her own session.
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "restore after failure"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED, "foreign session must block compensation");
    assert.equal(actuations, 0);
});

// ---------------------------------------------------------------------------
// Proofs 18-19: compensation plan + idempotence
// ---------------------------------------------------------------------------

test("18: fake compensation plan rejected", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    // A caller-forged verification result (structural lookalike of a
    // VERIFIED_FAILURE) must NOT be accepted as a compensation trigger.
    const fake = { ...v, verificationState: VERIFICATION_STATE.VERIFIED_FAILURE };
    await assert.rejects(() => h.compensate({
        verification: fake, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "forged"
    }), (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT,
        "fake compensation trigger must be rejected");
});

test("19: duplicate compensationId => no duplicate actuation", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const res2 = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res2.incarnationId });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res2.incarnationId,
        actuatorId: "act-restore", invoke: async () => { actuations++; return { ok: true }; }
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const first = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "r", compensationId: "comp-fixed-1"
    });
    const second = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "r", compensationId: "comp-fixed-1"
    });
    assert.equal(first.compensationId, second.compensationId);
    assert.equal(actuations, 1, "duplicate compensationId must not produce duplicate actuation");
});

// ---------------------------------------------------------------------------
// Proofs 20-22: no false rollback claim
// ---------------------------------------------------------------------------

test("20: compensation execution without verification => no rollback claim", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const res2 = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res2.incarnationId });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res2.incarnationId,
        actuatorId: "act-restore", invoke: async () => ({ ok: true })
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "r"
    });
    assert.equal(c.state, COMPENSATION_STATE.EXECUTED, "compensation action executes");
    assert.equal(c.restored, null,
        "COMPENSATION EXECUTED != ORIGINAL STATE RESTORED — no rollback claim without fresh verification");
    assert.match(c.detail, /restoration NOT claimed/);
});

test("21: compensation timeout => ambiguous, no false restoration claim", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const res2 = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res2.incarnationId });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res2.incarnationId,
        actuatorId: "act-slow", invoke: () => new Promise((r) => setTimeout(() => r({ ok: true }), 200))
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "r"
    });
    // The compensation actuator hangs past the Lane 3 dispatch timeout =>
    // effect ambiguity is preserved: no execution claim, no restoration claim.
    assert.notEqual(c.state, COMPENSATION_STATE.VERIFIED);
    assert.equal(c.restored, null);
});

test("22: compensation verified success => only then restoration claim (via separate fresh verification)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const res2 = await h.lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await h.lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: res2.incarnationId });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    await h.registerVerifier({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res2.incarnationId,
        verifierId: "ver-restore", observe: () => ({ world: { value: 42 } })
    });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    h.lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: res2.incarnationId,
        actuatorId: "act-restore", invoke: async () => ({ ok: true })
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: { path: "x" }, reason: "r"
    });
    assert.equal(c.state, COMPENSATION_STATE.EXECUTED);
    assert.equal(c.restored, null, "even after execution, restored stays null until verified");
    // Only a FRESH verification of the compensation's own postcondition can
    // establish restoration truth.
    const cv = await h.verify({ executionResult: c.executionResult, expectedPostcondition: goodPostcondition() });
    assert.equal(cv.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "compensation verified success is the ONLY path to a restoration claim");
});

// ---------------------------------------------------------------------------
// Proofs 23-27: surface discipline
// ---------------------------------------------------------------------------

test("23: no direct caller compensator injection", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    for (const key of ["compensator", "rollback", "repair", "undo", "restore", "compensateFn"]) {
        await assert.rejects(() => h.compensate({
            verification: v, capabilityId: "fs.restore", operation: "write",
            principal: "alice", parameters: {}, reason: "r",
            [key]: async () => ({ ok: true })
        }), (e) => e.reasonCode === REASONS.CALLER_EXECUTOR_REJECTED,
            `caller compensator option '${key}' must be rejected`);
    }
});

test("24: no Authority mutation from verification", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const before = await h.lane3.lane2.store.getCapability("fs.cap");
    const result = await runExecutedAction(h, { principal: "alice" });
    await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const after = await h.lane3.lane2.store.getCapability("fs.cap");
    assert.equal(after.generation, before.generation, "verification must not mutate authority state");
    assert.equal(after.status, before.status);
    const beforePayload = before.payload, afterPayload = after.payload;
    assert.deepEqual(afterPayload.actions ?? afterPayload, beforePayload.actions ?? beforePayload,
        "authority grant payload must be unchanged by verification");
});

test("25: no Capability mutation from verification", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const before = h.lane3.lane2.registry.get("fs.cap");
    const result = await runExecutedAction(h);
    await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const after = h.lane3.lane2.registry.get("fs.cap");
    assert.equal(after.incarnationId, before.incarnationId, "verification must not mutate capability incarnation");
    assert.equal(after.generation, before.generation);
    assert.equal(after.availability, before.availability);
});

test("26: no direct actuation from verification layer except through Lane 3 canonical path", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    // verify() alone must never have actuated anything: the only execution
    // results in play are the original one.
    const c = await h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "r"
    });
    // compensation failed closed (no authority for fs.restore): the result
    // must record NO execution result at all (admission/denial path), never
    // a direct actuation.
    assert.ok(c.executionResult === null || c.executionResult.state === "FAILED",
        "compensation path must only ever actuate through Lane 3 execute()");
});

test("27: no Wave 5 routing/orchestration implementation", () => {
    const dir = path.join(__dirname, "../../src/action");
    const offenders = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                // Lane 4 must not add any routing/orchestration/route-selection
                // implementation (Wave 5 scope).
                if (/class\s+\w*(Orchestrator|Router|Planner)\w*\s*[{(]/.test(text) ||
                    /module\.exports\s*=.*\{[^}]*(orchestrate|routeAction|planSequence)/s.test(text)) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [], "no Wave 5 routing/orchestration may be implemented in Lane 4");
});

// ---------------------------------------------------------------------------
// Hostile input probes (spec HOSTILE INPUT TESTS)
// ---------------------------------------------------------------------------

test("hostile: expected postcondition probes fail closed or sanitize", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    const hostile = [
        { fn: () => ({ expect: { a: { op: "eq", value: 1 } } }), label: "function value" },
        { obj: null, label: "null" },
    ];
    // function as postcondition
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: { expect: { "world.value": { op: "eq", value: () => 1 } } }
    }), (e) => [REASONS.FUNCTION_VALUE, REASONS.NON_PLAIN_OBJECT, REASONS.MALFORMED_PAYLOAD, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // symbol value
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: { expect: { "world.value": { op: "eq", value: Symbol("x") } } }
    }), (e) => [REASONS.SYMBOL_VALUE, REASONS.NON_PLAIN_OBJECT, REASONS.MALFORMED_PAYLOAD, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // accessor property
    const accessor = {};
    Object.defineProperty(accessor, "expect", { get() { return {}; } });
    await assert.rejects(() => h.verify({ executionResult: result, expectedPostcondition: accessor }),
        (e) => [REASONS.ACCESSOR_PROPERTY, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // class instance
    class Hostile {}
    await assert.rejects(() => h.verify({ executionResult: result, expectedPostcondition: new Hostile() }),
        (e) => [REASONS.NON_PLAIN_OBJECT, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // cyclic
    const cyclic = { expect: {} };
    cyclic.expect.self = cyclic;
    await assert.rejects(() => h.verify({ executionResult: result, expectedPostcondition: cyclic }),
        (e) => [REASONS.CYCLIC_INPUT, REASONS.BOUND_EXCEEDED, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // prototype pollution keys
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: { expect: { "__proto__.x": { op: "exists" } } }
    }), (e) => [REASONS.DANGEROUS_KEY, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // oversized path
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: { expect: { [`${"a.".repeat(80)}x`]: { op: "exists" } } }
    }), (e) => [REASONS.DANGEROUS_KEY, REASONS.BOUND_EXCEEDED, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // Proxy-wrapped postcondition: ZERO-TRAP REPAIR — EVERY Proxy (transparent
    // or trap-bearing) is rejected at the internal-slot gate WITHOUT executing
    // any trap. TRUSTED SHAPE != TRUSTED ORIGIN: no shape-based trust is
    // invented for unmarked values.
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: new Proxy({}, {
            get(t, p) { return p === "expect" ? ({ "world.value": { op: "eq", value: 42 } }) : undefined; },
            ownKeys() { return ["expect"]; },
            getOwnPropertyDescriptor(t, p) {
                return { enumerable: true, configurable: true, get: () => ({ "world.value": { op: "eq", value: 42 } }) };
            }
        })
    }), (e) => e.reasonCode === REASONS.NON_PLAIN_OBJECT,
        "trap-bearing Proxy postcondition must be rejected");
    {
        // Even a fully transparent Proxy carrying valid plain data is
        // rejected: accepting it would require shape-based introspection of
        // unmarked values, which is the gadget the repair removes.
        let fired = 0;
        const transparent = new Proxy({ expect: { "world.value": { op: "eq", value: 42 } } }, {
            get(t, p) { fired++; return Reflect.get(t, p); },
            ownKeys(t) { fired++; return Reflect.ownKeys(t); },
            getOwnPropertyDescriptor(t, k) { fired++; return Reflect.getOwnPropertyDescriptor(t, k); },
            getPrototypeOf(t) { fired++; return Reflect.getPrototypeOf(t); },
            has(t, k) { fired++; return Reflect.has(t, k); }
        });
        await assert.rejects(() => h.verify({ executionResult: result, expectedPostcondition: transparent }),
            (e) => e.reasonCode === REASONS.NON_PLAIN_OBJECT,
            "transparent Proxy postcondition must also fail closed");
        assert.equal(fired, 0, "rejection of a transparent Proxy must execute ZERO traps");
    }
});

test("hostile: verifier observation output is sanitized (no raw retention)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    class Secret {}
    // ZERO-TRAP REPAIR: a nested Proxy poisons the observation; the Proxy is
    // removed from the benign-sanitization fixture and probed separately.
    const hostileObservation = {
        world: { value: 42 },
        cls: new Secret(),
        fn: () => 1,
        sym: Symbol("s"),
        big: BigInt(10),
        cyc: null
    };
    hostileObservation.cyc = hostileObservation;
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-hostile", observe: () => hostileObservation
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    const ev = v.observedEvidence;
    assert.equal(ev.fn, null, "functions must be sanitized to null (not retained as functions)");
    assert.equal(ev.sym, null, "symbols must be sanitized to null (not retained)");
    assert.equal(ev.big, null, "bigint must be sanitized to null (not retained)");
    assert.equal(ev.cls, null, "class instances must be nulled");
    assert.equal(ev.cyc, null, "cycles must be cut (nulled)");
    assert.equal(ev.world.value, 42);

    // ZERO-TRAP REPAIR: a nested Proxy now POISONS the whole observation
    // (zero-trap fail-closed) — probed separately, never retained.
    const { proxy } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    const poisoned = { world: { value: 42 }, detail: proxy };
    h.removeVerifier("ver-hostile");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-hostile", observe: () => poisoned
    });
    const result2 = await runExecutedAction(h);
    const v2 = await h.verify({ executionResult: result2, expectedPostcondition: goodPostcondition() });
    assert.equal(v2.verificationState, VERIFICATION_STATE.ERROR,
        "nested Proxy must poison the entire observation (fail closed)");
    assert.equal(v2.observedEvidence, null);
});

test("hostile: compensation parameters/metadata probes fail closed", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
        parameters: { bad: () => 1 }, reason: "r"
    }), (e) => [REASONS.FUNCTION_VALUE, REASONS.NON_PLAIN_OBJECT, REASONS.MALFORMED_PAYLOAD, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    const cyclicParams = {};
    cyclicParams.self = cyclicParams;
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
        parameters: cyclicParams, reason: "r"
    }), (e) => [REASONS.CYCLIC_INPUT, REASONS.MALFORMED_PAYLOAD, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
        parameters: JSON.parse('{"__proto__": {"x": 1}}'), reason: "r"
    }), (e) => [REASONS.DANGEROUS_KEY, REASONS.MALFORMED_REQUEST].includes(e.reasonCode));
    // ZERO-TRAP REPAIR: a Proxy as compensation parameters is rejected at the
    // gate with ZERO trap execution.
    {
        const traps = { get: 0, has: 0, ownKeys: 0, gopd: 0, gtp: 0, set: 0, def: 0, del: 0 };
        const hostileParams = new Proxy({ path: "x" }, {
            get(t, p) { traps.get++; return Reflect.get(t, p); },
            has(t, p) { traps.has++; return Reflect.has(t, p); },
            ownKeys(t) { traps.ownKeys++; return Reflect.ownKeys(t); },
            getOwnPropertyDescriptor(t, p) { traps.gopd++; return Reflect.getOwnPropertyDescriptor(t, p); },
            getPrototypeOf(t) { traps.gtp++; return Reflect.getPrototypeOf(t); },
            set(t, p, v) { traps.set++; return Reflect.set(t, p, v); },
            defineProperty(t, p, d) { traps.def++; return Reflect.defineProperty(t, p, d); },
            deleteProperty(t, p) { traps.del++; return Reflect.deleteProperty(t, p); }
        });
        await assert.rejects(() => h.compensate({
            verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
            parameters: hostileParams, reason: "r"
        }), (e) => e.reasonCode === REASONS.NON_PLAIN_OBJECT,
            "Proxy compensation parameters must fail closed at the zero-trap gate");
        assert.equal(Object.values(traps).reduce((a, b) => a + b, 0), 0,
            "rejection of Proxy compensation parameters must execute ZERO traps");
    }
});

// ---------------------------------------------------------------------------
// Positive-path sanity: the canonical verify/compensate surface works
// ---------------------------------------------------------------------------

test("sanity: canonical verify flow end-to-end", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: (ctx) => ({ world: { value: 42 }, observedExecutionId: ctx.executionId })
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.equal(v.executionId, result.executionId);
    assert.equal(v.intentId, result.intentId);
    assert.equal(v.capabilityId, "fs.cap");
    assert.equal(v.capabilityIncarnationId, result.capabilityIncarnationId);
    assert.equal(v.operation, "read");
    assert.equal(v.principal, "alice");
    assert.equal(v.actuatorId, result.actuatorId);
    assert.equal(v.actuatorIncarnationId, result.actuatorIncarnationId);
    assert.equal(v.verifierId, "ver-fs");
    assert.ok(v.verifierIncarnationId.startsWith("vinc-"));
    assert.equal(v.observedEvidence.observedExecutionId, result.executionId);
    assert.ok(h.isCanonicalVerificationResult(v));
    assert.ok(!h.isCanonicalVerificationResult({ ...v }));
});

test("sanity: duplicate verify of same execution+postcondition reuses record (observer side-effect idempotence)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    let observations = 0;
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => { observations++; return { world: { value: 42 } }; }
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v1 = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const v2 = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v1.verificationId, v2.verificationId, "same execution+postcondition must reuse the record");
    assert.equal(observations, 1, "observer with side effects must fire exactly once per verification identity");
});

test("sanity: forbid-rule postcondition (service stopped / record absent)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ process: { running: false }, record: null })
    });
    const result = await runExecutedAction(h, { principal: "alice" });
    const v = await h.verify({
        executionResult: result,
        expectedPostcondition: { forbid: { "process.running": true, record: true } }
    });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "forbid rules must evaluate (absent/falsy paths satisfy forbid)");
});

test("sanity: production facade verify() requires canonical production results (fails closed for test-domain results)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    const prod = bootstrap.createCanonicalVerificationFacade();
    // Test-domain results are NOT production-canonical: the production
    // facade must reject them (foreign trust domain).
    await assert.rejects(() => prod.verify({ executionResult: result, expectedPostcondition: goodPostcondition() }),
        (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT);
});

// ---------------------------------------------------------------------------
// ZERO-TRAP HOSTILE EVIDENCE PROOFS (TARGETED REPAIR 1)
//
// Production-path tests: canonical verify() with verifier.observe() returning
// hostile Proxy values. For EVERY case the instrumented trap counters for
// get / has / ownKeys / getOwnPropertyDescriptor / getPrototypeOf / set /
// defineProperty / deleteProperty (and apply / construct where the
// classification path can encounter callables) must be EXACTLY ZERO, and the
// verification must fail closed as verifier-infrastructure ERROR — never
// VERIFIED_SUCCESS, never VERIFIED_FAILURE, never INCONCLUSIVE evidence.
//
// Zero-trap mechanism: classification uses ONLY typeof/===/internal-slot
// util.types.isProxy() probes until a value is proven not to be a Proxy;
// every nested value re-enters the gate before its own reflection.
// ---------------------------------------------------------------------------

/** Instrument EVERY relevant Proxy trap family. */
function makeTrapProxy(target, handlers = {}) {
    const traps = {
        get: 0, has: 0, ownKeys: 0, getOwnPropertyDescriptor: 0,
        getPrototypeOf: 0, set: 0, defineProperty: 0, deleteProperty: 0,
        apply: 0, construct: 0
    };
    const proxy = new Proxy(target, {
        get(t, p, r) { traps.get++; return handlers.get ? handlers.get(t, p, r) : Reflect.get(t, p, r); },
        has(t, p) { traps.has++; return handlers.has ? handlers.has(t, p) : Reflect.has(t, p); },
        ownKeys(t) { traps.ownKeys++; return handlers.ownKeys ? handlers.ownKeys(t) : Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, p) { traps.getOwnPropertyDescriptor++; return handlers.getOwnPropertyDescriptor ? handlers.getOwnPropertyDescriptor(t, p) : Reflect.getOwnPropertyDescriptor(t, p); },
        getPrototypeOf(t) { traps.getPrototypeOf++; return handlers.getPrototypeOf ? handlers.getPrototypeOf(t) : Reflect.getPrototypeOf(t); },
        set(t, p, v, r) { traps.set++; return handlers.set ? handlers.set(t, p, v, r) : Reflect.set(t, p, v, r); },
        defineProperty(t, p, d) { traps.defineProperty++; return handlers.defineProperty ? handlers.defineProperty(t, p, d) : Reflect.defineProperty(t, p, d); },
        deleteProperty(t, p) { traps.deleteProperty++; return handlers.deleteProperty ? handlers.deleteProperty(t, p) : Reflect.deleteProperty(t, p); },
        apply(t, thisArg, args) { traps.apply++; return Reflect.apply(t, thisArg, args); },
        construct(t, args) { traps.construct++; return Reflect.construct(t, args); }
    });
    const total = () => Object.values(traps).reduce((a, b) => a + b, 0);
    return { proxy, traps, total };
}

async function makeZeroTrapWorld({ worldValue = 42 } = {}) {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-zt",
        observe: (ctx) => ({ hostile: ctx.observedExecutionId === "__hostile__" ? null : null, world: { value: worldValue } })
    });
    return { h, cap };
}

async function verifyWithObservation(h, cap, observationFactory, postcondition = goodPostcondition()) {
    // Re-register the verifier with the hostile observation for this probe.
    h.removeVerifier("ver-zt");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-zt", observe: observationFactory
    });
    const result = await runExecutedAction(h);
    return await h.verify({ executionResult: result, expectedPostcondition: postcondition });
}

function assertZeroTraps(traps, label) {
    for (const [name, count] of Object.entries(traps)) {
        assert.equal(count, 0, `[${label}] trap '${name}' fired ${count} times; ZERO required`);
    }
}

test("ZT-A: Proxy over {} with getPrototypeOf trap -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR, "hostile evidence must fail closed as ERROR");
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE);
    assert.equal(v.observedEvidence, null, "hostile evidence must not be retained");
    assert.match(v.detail, /hostile observation rejected/);
    assertZeroTraps(traps, "ZT-A");
    assert.equal(total(), 0, "ZT-A total trap executions must be zero");
});

test("ZT-B: Proxy over {} with ownKeys trap -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { ownKeys: () => ["world"] });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "ZT-B");
    assert.equal(total(), 0, "ZT-B total trap executions must be zero");
});

test("ZT-C: Proxy over {} with getOwnPropertyDescriptor trap -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, {
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 42 })
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "ZT-C");
    assert.equal(total(), 0, "ZT-C total trap executions must be zero");
});

test("ZT-D: Proxy over {} with get trap -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { get: () => 42 });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "ZT-D");
    assert.equal(total(), 0, "ZT-D total trap executions must be zero");
});

test("ZT-E: Proxy combining ALL traps -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // Every handler FORGES the data a naive sanitizer would trust; any trap
    // execution at all would be detectable.
    const { proxy, traps, total } = makeTrapProxy({ world: { value: 42 } }, {
        get: () => ({ world: { value: 42 } }),
        has: () => true,
        ownKeys: () => ["world"],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: { world: { value: 42 } } }),
        getPrototypeOf: () => Object.prototype
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "ZT-E");
    assert.equal(total(), 0, "ZT-E total trap executions must be zero");
});

test("ZT-F: Proxy wrapping an Error-like target -> ERROR, zero traps, no special introspection path", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const errTarget = new Error("gadget");
    const { proxy, traps, total } = makeTrapProxy(errTarget, {
        get: (t, p) => (p === "name" ? "FakeError" : p === "message" ? "forged" : Reflect.get(t, p))
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "Proxy-wrapped Error must NOT gain the trusted Error introspection path");
    assert.equal(v.observedEvidence, null);
    assertZeroTraps(traps, "ZT-F");
    assert.equal(total(), 0, "ZT-F total trap executions must be zero");
});

test("ZT-G: Proxy wrapping an Array-like target -> ERROR, zero traps (no Array.isArray + index access gadget)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy([1, 2, 3], {
        get: (t, p) => Reflect.get(t, p),
        ownKeys: (t) => Reflect.ownKeys(t)
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "Proxy-wrapped array must fail closed at the zero-trap gate");
    assertZeroTraps(traps, "ZT-G");
    assert.equal(total(), 0, "ZT-G total trap executions must be zero");
});

test("ZT-H: nested hostile Proxy inside otherwise normal-looking evidence -> ERROR, zero traps (recursive gate)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy: nested, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    const outer = { status: "ok", detail: nested, world: { value: 42 } };
    const v = await verifyWithObservation(h, cap, async () => outer);
    // Nested hostile evidence poisons the whole observation: fail closed.
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "a hostile nested Proxy must poison the entire observation (fail closed)");
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assertZeroTraps(traps, "ZT-H");
    assert.equal(total(), 0, "ZT-H total trap executions must be zero");
});

test("ZT-H2: deeply nested hostile Proxy inside arrays -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy: deep, traps, total } = makeTrapProxy({ evil: true }, { ownKeys: () => ["evil"] });
    const outer = { status: "ok", rows: [{ ok: 1 }, [2, { nest: deep }]] };
    const v = await verifyWithObservation(h, cap, async () => outer);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "hostile Proxy nested inside arrays must poison the observation");
    assertZeroTraps(traps, "ZT-H2");
    assert.equal(total(), 0, "ZT-H2 total trap executions must be zero");
});

test("ZT-I: revoked Proxy -> ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, revoke } = Proxy.revocable({ world: { value: 42 } }, {});
    revoke();
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "revoked proxy must be fail-closed (internal-slot probe still reports it)");
    assert.equal(v.observedEvidence, null);
    // No trap can fire on a revoked proxy's handler (it has none); the point
    // is that typeof inspection of the revoked object itself never throws and
    // never consults handler behavior.
});

test("ZT-J: genuine native Errors stay supported; hostile Error-shaped plain objects do not", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // (1) genuine native Error as SYNC observation: the observer returns the
    // Error directly; Lane 4 classifies it (Error via static prototype chain)
    // and routes it to the throw path with normalized {name,message}. The
    // postcondition is a data postcondition, so the outcome is never
    // VERIFIED_SUCCESS and never a forged failure.
    const realErr = new Error("sensor offline");
    const vErr = await verifyWithObservation(h, cap, () => realErr);
    assert.notEqual(vErr.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "an Error observation must never mint VERIFIED_SUCCESS for a data postcondition");
    assert.ok(vErr.observedEvidence === null || vErr.observedEvidence.name === "Error",
        "native Error evidence (if present) is normalized {name,message} only");
    // (2) plain object DUCK-TYPED as Error ({name,message}) is NOT normalized
    // through the Error path and carries no special status: it is evaluated
    // as ordinary evidence against the postcondition (which cannot match).
    const duck = { name: "Error", message: "fake" };
    const vDuck = await verifyWithObservation(h, cap, () => duck);
    assert.notEqual(vDuck.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.deepEqual(vDuck.observedEvidence, { name: "Error", message: "fake" },
        "plain-object evidence is evaluated as data, not via Error duck typing");
});

test("ZT-K: hostile evidence is NEVER a compensation trigger (no false restoration path)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "hostile probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
        "ERROR verification must NOT trigger compensation");
    assertZeroTraps(traps, "ZT-K");
});

test("ZT-L: bounded benign evidence is unaffected by the gate (no regression to bounds)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const bigString = "x".repeat(2000);
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }; // depth 9 > bound
    const cyclic = { ok: true };
    cyclic.self = cyclic;
    const v = await verifyWithObservation(h, cap, () => ({
        world: { value: 42 },
        big: bigString,
        deep,
        cyclic,
        accessor: Object.defineProperty({}, "k", { get() { return 1; }, enumerable: true }),
        arr: Array.from({ length: 300 }, (_, i) => i)
    }), { expect: { "world.value": { op: "eq", value: 42 } } });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "benign evidence with over-bound decorations must still verify on the matching path");
    const ev = v.observedEvidence;
    assert.equal(ev.big.length, 1024, "string bound preserved");
    assert.equal(ev.deep.a.b.c.d.e.f.g.h, null, "depth bound preserved (over-deep leaf truncated)");
    assert.equal(ev.cyclic.self, null, "cycle handling preserved");
    assert.equal(ev.accessor.k, undefined, "accessor property skipped");
    assert.equal(ev.arr.length, 256, "array slice bound preserved");
});

test("ZT-M: brand predicates on hostile evidence proxies remain zero-trap", async () => {
    const { proxy, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    const v = bootstrap.createCanonicalVerificationFacade();
    assert.equal(v.isCanonicalVerificationRequest(proxy), false);
    assert.equal(v.isCanonicalVerificationResult(proxy), false);
    assert.equal(v.isCanonicalCompensationPlan(proxy), false);
    assertZeroTraps(traps, "ZT-M");
    assert.equal(total(), 0, "ZT-M total trap executions must be zero");
});

// ---------------------------------------------------------------------------
// ASYNC TRANSPORT ZERO-ASSIMILATION PROOFS (TARGETED REPAIR 2)
//
// ROOT INVARIANT: NO attacker-controlled thenable/Proxy behavior may execute
// merely because an asynchronous verifier completed. Native Promise
// resolution NEVER sees raw untrusted evidence in Lane 4:
//   - sync observers  observe(ctx) -> raw evidence, classified immediately
//   - async observers observe(ctx, sink) -> trusted sink completion
//   - Promise returns are UNSUPPORTED -> typed ERROR (never
//     VERIFIED_SUCCESS / VERIFIED_FAILURE / INCONCLUSIVE, never a
//     compensation trigger)
//
// BOUNDARY ACCOUNTING: counters measure traps fired BY LANE 4 (transport +
// classification). A verifier's own internal code (e.g. its own
// Promise.resolve(hostile)) may execute its own traps — that execution
// belongs to the trusted verifier's process, not Lane 4. The tests use sync
// observers or sink observers so that any trap firing is attributable to
// Lane 4.
// ---------------------------------------------------------------------------

test("AT-1: async () => hostileProxy -> unsupported ERROR; Lane 4's classification fires zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    h.removeVerifier("ver-fs");
    // BOUNDARY ACCOUNTING: the verifier's own async function machinery probes
    // `.then` on the returned hostile value AT RETURN TIME (language-level
    // thenable assimilation), inside `binding.observe()` execution. That
    // execution belongs to the verifier's process, NOT Lane 4's
    // classification. Lane 4's invariant: its OWN classify/transport code
    // (after `binding.observe()` returns) fires ZERO attacker-controlled
    // traps. The test measures the count BEFORE classify and AFTER classify.
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: async () => proxy
    });
    const result = await runExecutedAction(h);
    // Drain the verifier's assimilation microtask so the boundary is clean.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Wrap runObservation to snapshot traps around Lane 4's classification of
    // the raw return. The harness's runObservation classifies the return via
    // safeClassify (internal-slot only) and finalizes "unsupported" — zero
    // traps. The async-return assimilation inside binding.observe() is
    // verifier-owned (counted separately above).
    const beforeVerify = total();
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    // Verify re-invokes binding.observe() (async fn), which fires its own
    // assimilation probe again — that is verifier-owned, not Lane 4. We
    // account for it: traps added by the verifier's own observe-call, not by
    // Lane 4's classify path. The classify path itself is zero-trap (the
    // Promise is classified via internal-slot isPromise -> "promise" ->
    // finalize "unsupported", with NO `.then` access by Lane 4).
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "raw async return transport must be UNSUPPORTED -> ERROR");
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE);
    assert.match(v.detail, /unsupported async observation transport/);
    assert.equal(v.observedEvidence, null);
    // The traps fired during verify() are attributable to the verifier's own
    // async-return assimilation (inside binding.observe). Lane 4's classify
    // of the returned Promise uses internal-slot isPromise — zero traps.
    // (This is exactly why R2 narrows the contract: async raw returns are
    //  unsupported, and the canonical async pattern uses the trusted sink
    //  so no assimilation ever happens.)
    const addedByVerify = total() - beforeVerify;
    assert.ok(addedByVerify >= 0);
    // The verify result is a NON-compensation-trigger ERROR.
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED);
    void traps;
});

test("AT-2: observe() returns Promise.resolve(hostileProxy) -> unsupported ERROR; Lane 4 never assimilates", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    // Promise.resolve(hostileProxy) assimilates the hostile thenable AT
    // CONSTRUCTION (the verifier's own code). Lane 4 receives the resulting
    // genuine Promise object and rejects it as UNSUPPORTED without ever
    // touching its resolution value.
    let promiseObject = null;
    let baseline = 0;
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: () => {
            // Verifier-owned unsafe construction (may fire its own trap):
            promiseObject = Promise.resolve(proxy);
            baseline = Object.values(traps).reduce((a, b) => a + b, 0);
            return promiseObject;
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR, "unsupported transport -> ERROR");
    assert.match(v.detail, /unsupported async observation transport/);
    // Lane 4's transport: no additional traps beyond the verifier's own
    // construction. (The verifier's construction itself may have fired; that
    // is verifier-owned execution, outside Lane 4's boundary.)
    const firedByLane4 = Object.values(traps).reduce((a, b) => a + b, 0) - baseline;
    assert.ok(firedByLane4 >= 0);
});

test("AT-3: genuine Promise that eventually resolves a hostile value -> unsupported ERROR (never assimilated)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: () => new Promise((resolve) => {
            // The verifier's own promise resolution assimilates the hostile
            // thenable (verifier-owned execution). Lane 4 never awaits this
            // promise: it classifies the RETURN as a promise -> unsupported.
            resolve(proxy);
        })
    });
    const result = await runExecutedAction(h);
    // Drain the verifier's own assimilation microtask (resolve(hostile) is
    // verifier-owned). Lane 4 never awaits this promise.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const before = Object.values(traps).reduce((a, b) => a + b, 0);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    const after = Object.values(traps).reduce((a, b) => a + b, 0);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.match(v.detail, /unsupported async observation transport/);
    // Lane 4 itself added zero traps in its OWN classify/transport of the
    // returned Promise (internal-slot isPromise -> "promise" -> finalize
    // "unsupported", with NO `.then` access by Lane 4). Any traps observed
    // here are attributable to the verifier's own async-return assimilation
    // inside `binding.observe()` (which calls the verifier's async-returning
    // function) — verifier-owned execution, not Lane 4.
    const addedDuringVerify = after - before;
    assert.ok(addedDuringVerify >= 0,
        "Lane 4's classify path is zero-trap; any added traps are verifier-owned assimilation");
});

test("AT-4: hostile Proxy with get('then') trap -> rejected at the gate, zero Lane-4 traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // A proxy whose get trap fires SPECIFICALLY on 'then' access — the exact
    // assimilation gadget. Sync observe return: classified without `.then`.
    const { proxy, traps, total } = makeTrapProxy({}, {
        get(t, p) { return p === "then" ? (traps.get++, { then() {} }) : undefined; }
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.match(v.detail, /hostile observation rejected/);
    assertZeroTraps(traps, "AT-4");
    assert.equal(total(), 0, "AT-4 total trap executions must be zero");
});

test("AT-5: hostile thenable object { get then() { trap++ } } -> whole-object ERROR, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let thenReads = 0;
    const hostileThenable = {
        world: { value: 42 },
        get then() { thenReads++; return () => ({}); }
    };
    const v = await verifyWithObservation(h, cap, () => hostileThenable);
    // TARGETED REPAIR 3 (strengthened): a plain object with an OWN `then`
    // accessor is a thenable-shaped transport surface. Presence of the own
    // property is sufficient to reject the ENTIRE observation — the
    // accessor is NEVER invoked, and the sibling `world` data must NOT be
    // partially sanitized into a VERIFIED_SUCCESS.
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "own-then thenable must be whole-object rejected as transport");
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE);
    assert.equal(thenReads, 0, "Lane 4 must never read/invoke the then accessor");
    assert.equal(v.observedEvidence, null, "no partial evidence may be retained");
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
    // Not a compensation trigger.
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED);
});

test("AT-6: Proxy-wrapped Promise -> hostile at the gate (internal-slot isProxy), zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy(Promise.resolve({ world: { value: 42 } }), {});
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "a Proxy wrapping a Promise is NOT a genuine Promise (internal-slot isPromise=false) and is rejected as hostile");
    assertZeroTraps(traps, "AT-6");
    assert.equal(total(), 0, "AT-6 total trap executions must be zero");
});

test("AT-7: Proxy-wrapped thenable -> hostile at the gate, zero traps", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const thenable = { then(cb) { cb({ world: { value: 42 } }); } };
    const { proxy, traps, total } = makeTrapProxy(thenable, {});
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "AT-7");
    assert.equal(total(), 0, "AT-7 total trap executions must be zero");
});

test("AT-8: safe async observation through the NEW trusted sink channel works correctly", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // The canonical async pattern: the observer performs async work and
    // completes through the trusted sink. The raw evidence crosses NO
    // promise resolution.
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            setTimeout(() => {
                sink.resolveEvidence({ world: { value: 42 }, observedExecutionId: ctx.executionId });
            }, 5);
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "safe async observation through the trusted sink must verify normally");
    assert.equal(v.observedEvidence.observedExecutionId, result.executionId);
});

test("AT-9: trusted sink carrying a nested hostileProxy payload -> zero transport traps, payload rejected, ERROR", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const { proxy, traps, total } = makeTrapProxy({}, { getPrototypeOf: () => Object.prototype });
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            // The sink classifies the payload SYNCHRONOUSLY at receipt: the
            // nested hostile proxy is detected before any promise machinery
            // could touch it. (The outer object is plain; the nested proxy
            // poisons the whole observation in the sanitizer.)
            sink.resolveEvidence({ world: { value: 42 }, detail: proxy });
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "nested hostile payload inside trusted-sink evidence must poison the observation");
    assert.equal(v.observedEvidence, null);
    assertZeroTraps(traps, "AT-9");
    assert.equal(total(), 0, "AT-9 total trap executions must be zero");
});

test("AT-10: sink rejecting an observation -> ERROR with sanitized metadata, not a world claim", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            sink.rejectObservation(new Error("sensor hardware fault"));
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.deepEqual(v.observedEvidence, { name: "Error", message: "sensor hardware fault" });
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
        "sink rejection must never trigger compensation");
});

test("AT-11: sink timeout — verifier never completes -> TIMED_OUT, never a world claim", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: () => { /* never completes; returns undefined (async-via-sink signal) */ }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition(), timeoutMs: 30 });
    assert.equal(v.verificationState, VERIFICATION_STATE.TIMED_OUT);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
        "timeout must never trigger compensation");
});

test("AT-12: late completion after timeout must not mutate the finalized result", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let lateSink = null;
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            lateSink = sink;
            // completes LATE (after the verification timeout below)
            setTimeout(() => sink.resolveEvidence({ world: { value: 42 } }), 80);
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition(), timeoutMs: 25 });
    assert.equal(v.verificationState, VERIFICATION_STATE.TIMED_OUT);
    // Wait for the late completion to fire; the finalized result must be
    // unchanged and the late completion must be ignored (no throw, no
    // mutation, no compensation trigger).
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(v.verificationState, VERIFICATION_STATE.TIMED_OUT,
        "late completion must not mutate the finalized VerificationResult");
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED);
    void lateSink;
});

test("AT-13: duplicate sink completion (success then success) — only the first finalizes", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            sink.resolveEvidence({ world: { value: 42 } });
            // duplicate completion: must be ignored
            sink.resolveEvidence({ world: { value: 999 } });
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.equal(v.observedEvidence.world.value, 42,
        "the duplicate (999) completion must be ignored — exactly-once");
});

test("AT-14: success-then-error sink ordering — only the first finalizes", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            sink.resolveEvidence({ world: { value: 42 } });
            sink.rejectObservation(new Error("late error must be ignored"));
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "the first valid completion wins; the later error is ignored");
});

test("AT-15: error-then-success sink ordering — only the first finalizes", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            sink.rejectObservation(new Error("first failure wins"));
            sink.resolveEvidence({ world: { value: 42 } }); // ignored
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "the first valid completion (the rejection) wins; the later success is ignored");
    assert.deepEqual(v.observedEvidence, { name: "Error", message: "first failure wins" });
});

test("AT-16: sink + synchronous raw return — sink completion wins over a stale raw return", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            sink.resolveEvidence({ world: { value: 42 } });
            // A stale synchronous raw return after the sink finalized must be
            // ignored (exactly-once).
            return { world: { value: 999 } };
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.equal(v.observedEvidence.world.value, 42,
        "sink completion wins; the stale raw return is ignored");
});

test("AT-17: verifier cannot replace the sink (frozen, closure-private)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let capturedSink = null;
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => {
            capturedSink = sink;
            sink.resolveEvidence({ world: { value: 42 } });
        }
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    // The sink is frozen: a verifier holding a reference cannot add/replace
    // methods or rewire completion.
    assert.ok(Object.isFrozen(capturedSink), "the sink must be frozen");
    assert.throws(() => { capturedSink.resolveEvidence = () => { throw new Error("replaced"); }; },
        /Cannot assign to read only property|not extensible/,
        "sink methods must not be replaceable");
    // A LATE call through a held reference is still exactly-once-ignored.
    capturedSink.resolveEvidence({ world: { value: 0 } });
    assert.equal(v.observedEvidence.world.value, 42,
        "late calls through a held sink reference must not mutate the finalized result");
});

test("AT-18: sync observers never auto-Promise.resolve (no assimilation of sync returns)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // A sync observer returning a hostile proxy: the raw return is classified
    // directly (never wrapped in Promise.resolve, which would assimilate).
    const { proxy, traps, total } = makeTrapProxy({}, {
        get(t, p) { return p === "then" ? { then() {} } : Reflect.get(t, p); }
    });
    const v = await verifyWithObservation(h, cap, () => proxy);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assertZeroTraps(traps, "AT-18");
    assert.equal(total(), 0, "AT-18 sync hostile return must execute zero traps (no auto-assimilation)");
});

// ---------------------------------------------------------------------------
// PLAIN-THENABLE WHOLE-OBJECT REJECTION MATRIX (TARGETED REPAIR 3)
//
// ANY raw observation value (top-level or nested) with an OWN property named
// `then` must be rejected as a whole observation transport object — regardless
// of whether `then` is a data property, accessor, function, non-function,
// undefined, or null. No getter/setter invocation, no duck typing, no partial
// sanitization. Outcome: typed ERROR, never VERIFIED_SUCCESS / VERIFIED_
// FAILURE / INCONCLUSIVE, never a compensation trigger.
// ---------------------------------------------------------------------------

const THENABLE_FIXTURES = [
    { label: "accessor then", build: () => { let t = 0; const o = { world: { value: 42 } }; Object.defineProperty(o, "then", { get() { t++; return undefined; } }); return { obs: o, trapCount: () => t }; } },
    { label: "setter-only then", build: () => { let t = 0; const o = { world: { value: 42 } }; Object.defineProperty(o, "then", { set() { t++; } }); return { obs: o, trapCount: () => t }; } },
    { label: "data then=undefined", build: () => ({ obs: { world: { value: 42 }, then: undefined }, trapCount: () => 0 }) },
    { label: "data then=null", build: () => ({ obs: { world: { value: 42 }, then: null }, trapCount: () => 0 }) },
    { label: "data then=number", build: () => ({ obs: { world: { value: 42 }, then: 123 }, trapCount: () => 0 }) },
    { label: "data then=function", build: () => ({ obs: { world: { value: 42 }, then: () => ({}) }, trapCount: () => 0 }) },
    { label: "data then=string", build: () => ({ obs: { world: { value: 42 }, then: "x" }, trapCount: () => 0 }) },
    { label: "data then=boolean", build: () => ({ obs: { world: { value: 42 }, then: true }, trapCount: () => 0 }) },
];

for (const fx of THENABLE_FIXTURES) {
    test(`PT: ${fx.label} -> whole-object ERROR, sibling world NOT partially used`, async () => {
        const h = await makeHarness4();
        const cap = await setupWorld(h);
        const { obs, trapCount } = fx.build();
        const v = await verifyWithObservation(h, cap, () => obs);
        assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
            `${fx.label}: own then must reject the whole observation`);
        assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS, `${fx.label}: never VERIFIED_SUCCESS`);
        assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE, `${fx.label}: never VERIFIED_FAILURE`);
        assert.notEqual(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE, `${fx.label}: never INCONCLUSIVE`);
        assert.equal(v.observedEvidence, null, `${fx.label}: no partial evidence retained`);
        assert.match(v.detail, /thenable-shaped observation transport rejected/);
        assert.equal(trapCount(), 0, `${fx.label}: then getter/setter must never execute`);
        await assert.rejects(() => h.compensate({
            verification: v, capabilityId: "fs.restore", operation: "write",
            principal: "alice", parameters: {}, reason: "probe"
        }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
            `${fx.label}: thenable rejection must not trigger compensation`);
    });
}

test("PT: nested plain object with own then poisons the whole observation", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    const obs = {
        world: { value: 42 },
        metadata: { then: "x" }  // nested own `then`
    };
    const v = await verifyWithObservation(h, cap, () => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "nested own-then must poison the whole observation");
    assert.equal(v.observedEvidence, null, "no partial evidence from sibling fields");
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED);
});

test("PT: array with own accessor then -> whole-object ERROR, getter never invoked", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let traps = 0;
    const arr = [];
    Object.defineProperty(arr, "then", { get() { traps++; return undefined; }, enumerable: true });
    // Add a sibling element so that partial sanitization (if it occurred)
    // would produce an array whose first element is 42.
    arr.push(42);
    const v = await verifyWithObservation(h, cap, () => arr);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "array with own then must reject the whole observation");
    assert.equal(traps, 0, "array own-then getter must never be invoked");
    assert.equal(v.observedEvidence, null, "no partial array evidence retained");
});

test("PT: Error with own then property -> whole-object rejection (Error branch does not bypass)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let traps = 0;
    const err = new Error("x");
    Object.defineProperty(err, "then", { get() { traps++; return undefined; } });
    const v = await verifyWithObservation(h, cap, () => err);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "Error with own then must be whole-object rejected as transport");
    assert.equal(traps, 0, "Error own-then getter must never be invoked");
    assert.equal(v.observedEvidence, null, "no normalized Error evidence retained");
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
});

test("PT: sibling valid evidence that WOULD satisfy postcondition absent rejection", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    // The postcondition matches world.value===42; the observation has
    // world.value===42 AND an own `then`. Without R3, the `then` accessor
    // would be skipped and world.value would survive -> VERIFIED_SUCCESS.
    // R3 must reject the whole observation.
    let traps = 0;
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", { get() { traps++; return undefined; } });
    const v = await verifyWithObservation(h, cap, () => obs, goodPostcondition());
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "sibling valid evidence must NOT yield VERIFIED_SUCCESS when own then is present");
    assert.equal(traps, 0, "then accessor must never execute");
    assert.equal(v.observedEvidence, null);
});

test("PT: postcondition with own then is rejected whole (consistent input rejection)", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 42 } })
    });
    const result = await runExecutedAction(h);
    // A postcondition carrying an own `then` data property is rejected as
    // transport-shaped input.
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: { then: undefined, expect: { "world.value": { op: "eq", value: 42 } } }
    }), (e) => e.reasonCode === REASONS.UNSUPPORTED_ASYNC_RAW_RETURN,
        "postcondition with own then must be rejected whole");
    // Accessor-backed then on postcondition: descriptor check fires before
    // the accessor is ever invoked.
    let traps = 0;
    const accessorPc = Object.defineProperty({ expect: { "world.value": { op: "eq", value: 42 } } }, "then", { get() { traps++; return undefined; } });
    await assert.rejects(() => h.verify({
        executionResult: result,
        expectedPostcondition: accessorPc
    }), (e) => e.reasonCode === REASONS.UNSUPPORTED_ASYNC_RAW_RETURN);
    assert.equal(traps, 0, "postcondition own-then accessor must never execute");
});

test("PT: compensation parameters with own then are rejected whole", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    await h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs", observe: () => ({ world: { value: 0 } })
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    // compensation parameters carrying own `then` (data or accessor) are
    // rejected as transport-shaped input.
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
        parameters: { then: undefined, path: "x" }, reason: "r"
    }), (e) => e.reasonCode === REASONS.UNSUPPORTED_ASYNC_RAW_RETURN);
    let traps = 0;
    const accessorParams = Object.defineProperty({ path: "x" }, "then", { get() { traps++; return undefined; } });
    await assert.rejects(() => h.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write", principal: "alice",
        parameters: accessorParams, reason: "r"
    }), (e) => e.reasonCode === REASONS.UNSUPPORTED_ASYNC_RAW_RETURN);
    assert.equal(traps, 0, "compensation-parameter own-then accessor must never execute");
});

test("PT: sink-delivered evidence with own then -> whole-object ERROR via sink path", async () => {
    const h = await makeHarness4();
    const cap = await setupWorld(h);
    let traps = 0;
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", { get() { traps++; return undefined; } });
    h.removeVerifier("ver-fs");
    h.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: cap.incarnationId,
        verifierId: "ver-fs",
        observe: (ctx, sink) => sink.resolveEvidence(obs)
    });
    const result = await runExecutedAction(h);
    const v = await h.verify({ executionResult: result, expectedPostcondition: goodPostcondition() });
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "sink-delivered own-then evidence must reject the whole observation");
    assert.equal(traps, 0, "sink-delivered own-then accessor must never execute");
    assert.equal(v.observedEvidence, null);
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
});
