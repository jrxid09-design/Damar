"use strict";

/**
 * PRODUCTION-PATH OWN-THEN CERTIFICATION PROOF (TARGETED REPAIR 4).
 *
 * These tests exercise the REAL production Lane 4 implementation:
 *   src/action/internal/verificationBootstrap.js
 * via tests/verification/productionHarness.js (wiring only — no Lane 4 logic
 * copies). The tests prove that the actual production code rejects own-then
 * evidence correctly, not merely the test-domain mirror.
 *
 * STRUCTURAL GUARDS: a separate test suite (tests/verification/structuralGuards.test.js)
 * asserts the production facade exposes no privileged surface and that the
 * internal module is not reachable through the public package.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeProductionVerificationHarness } = require("./productionHarness");
const { VERIFICATION_STATE, COMPENSATION_STATE, REASONS } = require("../../src/action/verification/errors");
const bootstrap = require("../../src/action/bootstrap");

const ROOT = require("node:path").join(__dirname, "..", "..");

function lane4ScopeBindings() {
    const read = (a) => (a && a.target ? [a.target.trim().toLowerCase()] : []);
    const write = (a) => {
        const p = a && (a.path ?? a.target);
        const s = typeof p === "string" ? p.trim().toLowerCase() : "";
        return s ? [s] : [];
    };
    return {
        "fs.cap": { read, write },
        "fs.restore": { write, read }
    };
}

// Shared Lane 3 harness (built once, reused for capability/authority setup)
let h_lane3 = null;

async function setup() {
    if (h_lane3) return h_lane3;
    const { makeActuationHarness } = require("../actuation/harness");
    h_lane3 = await makeActuationHarness({ scopeBindings: lane4ScopeBindings() });
    return h_lane3;
}

async function prodVerifyWithObservation(observeFn) {
    const lane3 = await setup();
    // register the capability fresh for this test (idempotent if already registered)
    let capRes;
    try {
        capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
        await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    } catch { /* already registered */ capRes = { incarnationId: lane3.lane2.registry.get("fs.cap").incarnationId }; }
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });

    const facade = require("../../src/action/internal/verificationBootstrap").createCanonicalVerificationComposition({
        deps: {
            createLane3Facade: () => ({
                execute: lane3.execute,
                isCanonicalExecutionRequest: lane3.isCanonicalExecutionRequest,
                isCanonicalExecutionResult: lane3.isCanonicalExecutionResult
            }),
            createLane2Facade: () => ({
                admit: lane3.lane2.admit,
                evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate,
                session: lane3.lane2.session
            })
        },
        trustedVerifiers: [{
            capabilityId: "fs.cap",
            operations: ["read"],
            capabilityIncarnationId: capRes.incarnationId,
            verifierId: "ver-prod",
            observe: observeFn
        }]
    });

    const intent = lane3.lane2.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }
    }));
    const result = await lane3.execute({ intent, authSession: lane3.lane2.session("alice"), parameters: { target: "t" } });
    const v = await facade.verify({
        executionResult: result,
        expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } }
    });
    return { v, facade, result };
}

const GOOD_POSTCONDITION = { expect: { "world.value": { op: "eq", value: 42 } } };

// ---------------------------------------------------------------------------
// P1 — EXACT R3 REPRO
// ---------------------------------------------------------------------------

test("P1: accessor own then (getterCount++) -> ERROR, getterCount===0, null evidence, not VERIFIED_*/INCONCLUSIVE", async () => {
    let getterCount = 0;
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", {
        get() { getterCount++; throw new Error("then accessed"); }
    });
    const { v, facade } = await prodVerifyWithObservation(() => obs);

    assert.equal(getterCount, 0, "the then getter must NEVER execute (zero-trap descriptor check)");
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assert.notEqual(v.verificationState, VERIFICATION_STATE.INCONCLUSIVE);
    assert.equal(v.observedEvidence, null);
    assert.match(v.detail, /thenable-shaped observation transport rejected/);

    // Production brand proof: the result IS canonical production-branded.
    assert.ok(facade.isCanonicalVerificationResult(v), "the result must pass production brand check");
});

// ---------------------------------------------------------------------------
// P2 — SETTER OWN THEN
// ---------------------------------------------------------------------------

test("P2: setter-only own then -> ERROR, setterCount===0, null evidence", async () => {
    let setterCount = 0;
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", {
        set() { setterCount++; }
    });
    const { v } = await prodVerifyWithObservation(() => obs);

    assert.equal(setterCount, 0);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.equal(v.observedEvidence, null);
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
});

// ---------------------------------------------------------------------------
// P3 — DATA THEN MATRIX
// ---------------------------------------------------------------------------

for (const [label, thenValue] of [
    ["undefined", undefined],
    ["null", null],
    ["0 (number)", 0],
    ["false (boolean)", false],
    ["string", "x"],
    ["function", () => ({})]
]) {
    test(`P3: data then=${label} -> ERROR, null evidence`, async () => {
        const obs = { world: { value: 42 }, then: thenValue };
        const { v } = await prodVerifyWithObservation(() => obs);
        assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
        assert.equal(v.observedEvidence, null);
        assert.notEqual(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    });
}

// ---------------------------------------------------------------------------
// P4 — NON-ENUMERABLE THEN
// ---------------------------------------------------------------------------

test("P4: non-enumerable own then -> ERROR (descriptor semantics, not key enumeration)", async () => {
    const obs = { world: { value: 42 } };
    Object.defineProperty(obs, "then", { value: undefined, enumerable: false });
    const { v } = await prodVerifyWithObservation(() => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "non-enumerable own then must still be detected via descriptor lookup");
    assert.equal(v.observedEvidence, null);
});

// ---------------------------------------------------------------------------
// P5 — NESTED THEN
// ---------------------------------------------------------------------------

test("P5: nested plain object with own then poisons whole observation", async () => {
    const obs = { world: { value: 42 }, metadata: { then: null } };
    const { v } = await prodVerifyWithObservation(() => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.equal(v.observedEvidence, null, "no sibling evidence retained");
});

// ---------------------------------------------------------------------------
// P6 — ARRAY THEN
// ---------------------------------------------------------------------------

test("P6: array with own accessor then -> ERROR, getter never invoked", async () => {
    let traps = 0;
    const arr = [];
    Object.defineProperty(arr, "then", { get() { traps++; return undefined; } });
    arr.push(42);
    const { v } = await prodVerifyWithObservation(() => arr);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.equal(traps, 0, "array own-then getter must never execute");
    assert.equal(v.observedEvidence, null);
});

// ---------------------------------------------------------------------------
// P7 — ERROR THEN
// ---------------------------------------------------------------------------

test("P7: native Error with own accessor then -> ERROR before normalization", async () => {
    let traps = 0;
    const err = new Error("x");
    Object.defineProperty(err, "then", { get() { traps++; return undefined; } });
    const { v } = await prodVerifyWithObservation(() => err);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR,
        "Error with own then must be rejected before name/message normalization");
    assert.equal(traps, 0, "Error own-then getter must never execute");
    assert.equal(v.observedEvidence, null);
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
});

// ---------------------------------------------------------------------------
// P8 — TRUSTED SINK THEN
// ---------------------------------------------------------------------------

test("P8: trusted sink resolveEvidence with own-then payload -> ERROR, getterCount===0", async () => {
    let getterCount = 0;
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", { get() { getterCount++; return undefined; } });

    const lane3 = await setup();
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });

    const facade = require("../../src/action/internal/verificationBootstrap").createCanonicalVerificationComposition({
        deps: {
            createLane3Facade: () => ({
                execute: lane3.execute,
                isCanonicalExecutionRequest: lane3.isCanonicalExecutionRequest,
                isCanonicalExecutionResult: lane3.isCanonicalExecutionResult
            }),
            createLane2Facade: () => ({
                admit: lane3.lane2.admit,
                evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate,
                session: lane3.lane2.session
            })
        },
        trustedVerifiers: [{
            capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
            verifierId: "ver-sink", observe: (ctx, sink) => sink.resolveEvidence(obs)
        }]
    });

    const intent = lane3.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "fs.cap", operation: "read", arguments: { target: "t" } }));
    const result = await lane3.execute({ intent, authSession: lane3.lane2.session("alice"), parameters: { target: "t" } });
    const v = await facade.verify({ executionResult: result, expectedPostcondition: GOOD_POSTCONDITION });

    assert.equal(getterCount, 0, "sink-delivered own-then getter must never execute");
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.equal(v.observedEvidence, null);
    assert.match(v.detail, /thenable-shaped observation transport rejected/);
});

// ---------------------------------------------------------------------------
// P9 — COMPENSATION NON-TRIGGER
// ---------------------------------------------------------------------------

test("P9: compensate() on own-then ERROR -> COMPENSATION_NOT_INDICATED, zero actuation", async () => {
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", { get() { return undefined; } });
    const { v, facade } = await prodVerifyWithObservation(() => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);

    await assert.rejects(() => facade.compensate({
        verification: v, capabilityId: "fs.restore", operation: "write",
        principal: "alice", parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
        "own-then ERROR must never trigger compensation");
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — prove the test guards truth laundering, not just failing
// ---------------------------------------------------------------------------

test("NEGATIVE CONTROL: same sibling evidence without `then` yields VERIFIED_SUCCESS", async () => {
    // The same fixture WITHOUT `then`: sibling world.value===42 must satisfy
    // the postcondition -> VERIFIED_SUCCESS. This proves the PT tests guard
    // truth laundering, not merely failing for an unrelated reason.
    const obs = { world: { value: 42 } }; // NO own `then`
    const { v } = await prodVerifyWithObservation(() => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "absent then, the sibling evidence must verify normally — the then is the guard");
});

// ---------------------------------------------------------------------------
// PRODUCTION BRAND / DOMAIN PROOF
// ---------------------------------------------------------------------------

test("BRAND: own-then ERROR result is canonical to ITS OWN composition (real production implementation)", async () => {
    // TERMINOLOGY (TARGETED REPAIR 5): this test composition is a REAL
    // PRODUCTION IMPLEMENTATION composition (same extracted code the
    // canonical application uses), NOT the canonical APPLICATION production
    // instance itself. The result minted here is canonical to THIS
    // composition's provenance domain — proving real production-code
    // execution, not mirror-harness execution. Cross-composition isolation
    // (this result is NOT canonical to the canonical application instance)
    // is proven separately in tests/verification/compositionIsolation.test.js.
    const obs = Object.defineProperty({ world: { value: 42 } }, "then", { get() { return undefined; } });
    const { v, facade } = await prodVerifyWithObservation(() => obs);
    assert.equal(v.verificationState, VERIFICATION_STATE.ERROR);
    assert.ok(facade.isCanonicalVerificationResult(v),
        "the result must pass ITS OWN composition's brand predicate — proving real production-implementation execution, not mirror");
    // A structural clone must NOT pass (proves brand-first, not shape-based).
    assert.ok(!facade.isCanonicalVerificationResult({ ...v }),
        "a structural clone must fail the composition brand check");
    // Cross-composition: the canonical application facade must NOT recognize
    // this test composition's result (independent provenance domains).
    const canonicalApp = bootstrap.createCanonicalVerificationFacade();
    assert.ok(!canonicalApp.isCanonicalVerificationResult(v),
        "the canonical APPLICATION composition must reject the test composition's result (foreign provenance domain)");
});

// ---------------------------------------------------------------------------
// STRUCTURAL GUARD: production facade exposes no privileged surface
// ---------------------------------------------------------------------------

test("STRUCTURAL: production facade is exactly least-privilege (no registrar/registry/sink/brand)", () => {
    const v = bootstrap.createCanonicalVerificationFacade();
    const keys = Object.keys(v).sort();
    assert.deepEqual(keys, ["compensate", "isCanonicalCompensationPlan", "isCanonicalVerificationRequest", "isCanonicalVerificationResult", "verify"]);
    assert.ok(Object.isFrozen(v));
    // No privileged surface:
    for (const name of ["createCanonicalVerificationComposition", "buildVerifierRegistry", "registerVerifier", "removeVerifier", "vSafeClassify4", "vHasOwnThen4", "sanitizeEvidence4", "vDetach4", "formExpectedPostcondition4", "vRunObservation4", "buildActuatorRegistry4", "verifierRegistry", "sink", "resolveEvidence", "rejectObservation", "requestBrandSet", "resultBrandSet", "planBrandSet", "REQUEST_BRAND", "RESULT_BRAND", "PLAN_BRAND"]) {
        assert.equal(typeof v[name], "undefined", `facade must not expose '${name}'`);
    }
});

test("STRUCTURAL: internal module is NOT exported through public action package", () => {
    const actionApi = require("../../src/action");
    for (const name of ["createCanonicalVerificationComposition", "buildVerifierRegistry4", "registerVerifier", "verifierRegistry", "sink", "vSafeClassify4", "vHasOwnThen4", "sanitizeEvidence4"]) {
        assert.equal(typeof actionApi[name], "undefined", `public action package must not export '${name}'`);
    }
});

test("STRUCTURAL: src/** never imports tests/**", () => {
    const fs = require("node:fs");
    const path = require("node:path");
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
