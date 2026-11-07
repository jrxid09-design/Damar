"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const selector = require("../../src/runtime/recovery/selector");
const { RecoveryStatusTracker } = require("../../src/runtime/recovery/status");

async function buildAndDecide(s) {
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const decision = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    return { cap, decision };
}

test("status: records last complete capsule and epoch", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const { cap } = await buildAndDecide(s);
    const t = new RecoveryStatusTracker(s.config.maxDiagnostics);
    t.recordRuntimeGeneration(s.generationLedger.current);
    t.recordCheckpoint(cap);
    const status = t.getRecoveryStatus();
    assert.equal(status.lastCompleteCapsuleId, cap.manifest.capsuleId);
    assert.equal(status.lastEpoch, cap.manifest.epochId);
    assert.equal(status.currentRuntimeGeneration, s.generationLedger.current);
});

test("status: degraded flag reflects degraded restore decision", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    s.registry.register(
        makeFakeProvider({ id: "opt", classification: "PUBLIC_STATE", required: false, capture: () => null })
    );
    const { decision } = await buildAndDecide(s);
    assert.equal(decision.outcome, "DEGRADED_RESTORE");
    const t = new RecoveryStatusTracker(100);
    t.recordDecision(decision);
    assert.equal(t.getRecoveryStatus().degraded, true);
});

test("status: snapshot is frozen and contains no raw section payload", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc", data: { secretBlob: "TOPSECRET" } }));
    const { cap, decision } = await buildAndDecide(s);
    const t = new RecoveryStatusTracker(100);
    t.recordCheckpoint(cap);
    t.recordDecision(decision);
    const status = t.getRecoveryStatus();
    assert.ok(Object.isFrozen(status));
    assert.ok(Object.isFrozen(status.diagnostics));
    const json = JSON.stringify(status);
    assert.ok(!json.includes("TOPSECRET"), "status must never leak section data");
});

test("status: diagnostics ring bounded", () => {
    const t = new RecoveryStatusTracker(5);
    const diags = Array.from({ length: 20 }, (_, i) => ({ code: "UNKNOWN", capsuleId: null, sectionId: null, message: String(i) }));
    t.pushDiagnostics(diags);
    assert.equal(t.getRecoveryStatus().diagnostics.length, 5);
});
