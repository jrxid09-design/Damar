"use strict";

/**
 * COMPENSATION LIFECYCLE + AUTHORITY FLOW — Lane 4 focused suite under the
 * spec-required tests/compensation/ location.
 *
 * Covers the compensation-specific lifecycle semantics in depth:
 *   - COMPENSATION_PROPOSED -> AUTHORIZED -> EXECUTED state observation
 *     through the canonical compensation result
 *   - authority-gated dispatch (Lane 2 revalidation is fresh)
 *   - plan immutability + brand-first provenance
 *   - idempotence (duplicate compensationId reuses the record)
 *   - no false rollback claim (restored stays null until fresh verification)
 *   - INCONCLUSIVE/TIMED_OUT/ERROR source verifications are NOT triggers
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { VERIFICATION_STATE, COMPENSATION_STATE, REASONS } = require("../../src/action/verification/errors");
const { makeVerificationHarness } = require("../verification/harness");

const SCOPE_BINDINGS = {
    "device.cap": { read: (a) => (a && a.target ? [a.target] : []) },
    "device.off": { write: (a) => (a && a.target ? [a.target] : []) }
};

async function makeCompensationWorld({ principal = "ron" } = {}) {
    const h = await makeVerificationHarness({ scopeBindings: SCOPE_BINDINGS });
    const { lane3 } = h;

    const capRes = await lane3.lane2.registerCapability({ id: "device.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("device.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    const offRes = await lane3.lane2.registerCapability({ id: "device.off", operations: ["write"] });
    await lane3.lane2.registry.observeAvailability("device.off", "AVAILABLE", { generation: 1, incarnationId: offRes.incarnationId });

    await lane3.lane2.grantAuthority({ capabilityId: "device.cap", subject: principal, actions: ["read"], identityBinding: { principals: [principal] } });
    await lane3.lane2.grantAuthority({ capabilityId: "device.off", subject: principal, actions: ["write"], identityBinding: { principals: [principal] } });

    const world = { deviceOn: false, lastOffExecution: null };
    let offActuations = 0;
    lane3.registerActuator({
        capabilityId: "device.off", operations: ["write"], capabilityIncarnationId: offRes.incarnationId,
        actuatorId: "act-device-off",
        invoke: async (ctx) => {
            offActuations++;
            world.deviceOn = false;
            world.lastOffExecution = ctx.executionId;
            return { ok: true, device: ctx.parameters?.device ?? null };
        }
    });

    async function executeRead(nonce) {
        const intent = lane3.lane2.admit(JSON.stringify({
            schemaVersion: 1, capabilityId: "device.cap", operation: "read", arguments: { target: "lamp" }
        }));
        return await lane3.execute({ intent, authSession: lane3.lane2.session(principal), parameters: { target: "lamp", nonce } });
    }

    async function verifyState(onValue, nonce) {
        // Register a fresh verifier observing the CURRENT world state.
        h.removeVerifier("ver-device");
        const binding = h.registerVerifier({
            capabilityId: "device.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
            verifierId: "ver-device",
            observe: (octx, sink) => sink.resolveEvidence({ device: { on: world.deviceOn, observedExecutionId: octx.executionId } })
        });
        const result = await executeRead(nonce);
        const v = await h.verify({
            executionResult: result,
            expectedPostcondition: { expect: { "device.on": { op: "eq", value: onValue } } }
        });
        return { v, binding };
    }

    return { h, lane3, world, offRes, offActuationsRef: () => offActuations, verifyState, executeRead, principal };
}

test("compensation flow: VERIFIED_FAILURE -> plan -> authorized dispatch through Lane 3 -> no false rollback", async () => {
    const w = await makeCompensationWorld();
    w.world.deviceOn = true; // the device SHOULD be off but is on
    const { v } = await w.verifyState(false, 1);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE,
        "device-on != expected-off must verify as VERIFIED_FAILURE");

    const c = await w.h.compensate({
        verification: v,
        capabilityId: "device.off",
        operation: "write",
        principal: w.principal,
        scope: ["lamp"],
        parameters: { device: "lamp" },
        reason: "device must be off"
    });

    // The compensation is a NEW canonical action that traversed Lane 2 + Lane 3.
    assert.equal(c.state, COMPENSATION_STATE.EXECUTED,
        "authorized compensation action must execute through Lane 3");
    assert.ok(c.executionResult, "compensation result must carry the canonical Lane 3 execution result");
    assert.equal(c.executionResult.state, "EXECUTED");
    assert.equal(w.offActuationsRef(), 1, "exactly one compensation actuation");
    assert.equal(c.restored, null,
        "COMPENSATION != ROLLBACK GUARANTEE: restored stays null after execution");
    assert.match(c.detail, /restoration NOT claimed/);

    // Only a fresh verification of the compensation's own postcondition may
    // establish restoration truth.
    const { v: v2 } = await w.verifyState(false, 2);
    assert.equal(v2.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS,
        "after the compensation actuation the device is verified off");
});

test("compensation is NOT triggered by non-VERIFIED_FAILURE verification states", async () => {
    const w = await makeCompensationWorld();
    for (const state of [VERIFICATION_STATE.INCONCLUSIVE, VERIFICATION_STATE.TIMED_OUT, VERIFICATION_STATE.ERROR, VERIFICATION_STATE.VERIFIED_SUCCESS, VERIFICATION_STATE.PENDING]) {
        const fake = {
            schemaVersion: 1,
            verificationId: "fake-" + state,
            executionId: "fake-exec",
            intentId: "fake-intent",
            capabilityId: "device.cap",
            capabilityIncarnationId: "inc-00000000000000000000000000000000",
            operation: "read",
            principal: w.principal,
            verificationState: state
        };
        // A fake result is rejected before state inspection; to reach the
        // state check we need a REAL result — so for fake shapes the
        // brand check fires first (also a required behavior).
        await assert.rejects(() => w.h.compensate({
            verification: fake, capabilityId: "device.off", operation: "write",
            principal: w.principal, parameters: {}, reason: "probe"
        }), (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT,
            `fake result with state ${state} must be rejected`);
    }

    // Real canonical result with a NON-trigger state (VERIFIED_SUCCESS):
    w.world.deviceOn = false;
    const { v } = await w.verifyState(false, 10);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_SUCCESS);
    await assert.rejects(() => w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: {}, reason: "probe"
    }), (e) => e.reasonCode === REASONS.COMPENSATION_NOT_INDICATED,
        "VERIFIED_SUCCESS must NOT trigger compensation");
    assert.equal(w.offActuationsRef(), 0);
});

test("compensation plan is immutable and brand-first", async () => {
    const w = await makeCompensationWorld();
    w.world.deviceOn = true;
    const { v } = await w.verifyState(false, 20);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    const c = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r"
    });
    assert.equal(c.state, COMPENSATION_STATE.EXECUTED);
    // The verification result is frozen; a clone loses provenance.
    assert.ok(Object.isFrozen(v), "VerificationResult must be immutable");
    const clone = JSON.parse(JSON.stringify(v));
    await assert.rejects(() => w.h.compensate({
        verification: clone, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: {}, reason: "clone"
    }), (e) => e.reasonCode === REASONS.NOT_CANONICAL_EXECUTION_RESULT,
        "JSON clone of a canonical verification must not authorize compensation");
    assert.equal(w.offActuationsRef(), 1);
});

test("compensation dispatch is authority-gated: revoked authority blocks actuation", async () => {
    const w = await makeCompensationWorld();
    w.world.deviceOn = true;
    const { v } = await w.verifyState(false, 30);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    // Revoke the device.off grant.
    const entry = await w.lane3.lane2.store.getCapability("device.off");
    await w.lane3.lane2.store.upsertCapability("device.off", "REVOKED", entry.generation, JSON.stringify({ ...entry.payload, status: "REVOKED" }));
    const c = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r"
    });
    assert.equal(c.state, COMPENSATION_STATE.FAILED, "revoked authority must block compensation");
    assert.equal(w.offActuationsRef(), 0, "no actuation on revoked authority");
    assert.equal(c.restored, null);
});

test("compensation requires a fresh session per dispatch (no stale evidence bearer)", async () => {
    const w = await makeCompensationWorld();
    w.world.deviceOn = true;
    const { v } = await w.verifyState(false, 40);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    // Compensation runs twice with the same plan inputs but DIFFERENT
    // compensationIds — each dispatch is a fresh canonical action with its
    // own fresh session + fresh Lane 2 evaluation (no bearer reuse).
    const c1 = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r", compensationId: "c-a"
    });
    const c2 = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r", compensationId: "c-b"
    });
    assert.equal(c1.state, COMPENSATION_STATE.EXECUTED);
    assert.equal(c2.state, COMPENSATION_STATE.EXECUTED);
    assert.notEqual(c1.compensationId, c2.compensationId, "distinct ids are distinct actions");
    assert.equal(w.offActuationsRef(), 2, "each distinct compensation actuates exactly once");
});

test("duplicate compensationId returns the SAME record (no duplicate actuation)", async () => {
    const w = await makeCompensationWorld();
    w.world.deviceOn = true;
    const { v } = await w.verifyState(false, 50);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    const c1 = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r", compensationId: "comp-once"
    });
    const c2 = await w.h.compensate({
        verification: v, capabilityId: "device.off", operation: "write",
        principal: w.principal, parameters: { device: "lamp" }, reason: "r", compensationId: "comp-once"
    });
    assert.equal(c1.compensationId, c2.compensationId);
    assert.equal(c2, c1, "the exact same canonical record is returned");
    assert.equal(w.offActuationsRef(), 1, "no duplicate actuation for a duplicate id");
});

test("verification cannot actuate: verify() alone leaves the world untouched", async () => {
    const w = await makeCompensationWorld();
    const before = w.offActuationsRef();
    w.world.deviceOn = true;
    const { v } = await w.verifyState(false, 60);
    assert.equal(v.verificationState, VERIFICATION_STATE.VERIFIED_FAILURE);
    assert.equal(w.offActuationsRef(), before,
        "verification must never actuate; only the canonical compensation path may");
});
