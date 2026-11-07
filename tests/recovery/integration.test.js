"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const recovery = require("../../src/runtime/recovery");
const { makeFakeProvider } = require("./helpers/fakes");

test("integration: full checkpoint -> select -> restore cycle", async () => {
    const system = recovery.checkpoint.createRecoverySystem();
    const ledger = new recovery.GenerationLedger();

    for (const spec of [
        { id: "acc", data: { seq: 7 } },
        { id: "presence", classification: "EPHEMERAL", required: false, data: {} }
    ]) {
        system.registry.register(makeFakeProvider(spec));
    }
    system.registry.register(
        makeFakeProvider({
            id: "actuation",
            classification: "NON_RESUMABLE",
            required: false,
            data: { pendingShellCommand: "git push" }
        })
    );

    const cap = await new recovery.checkpoint.CheckpointBuilder(system).run({
        reason: "SHUTDOWN",
        runtimeGenerationId: ledger.current
    });
    assert.ok(cap.manifest.capsuleId.startsWith("rc-"));
    assert.ok(!cap.manifest.sections.some((s) => s.sectionId === "presence"), "ephemeral skipped");

    // crash simulation: fresh process re-loads candidates from store
    const candidates = system.store.candidates();
    const decision = recovery.selector.decide({
        candidates,
        registry: system.registry,
        config: system.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.equal(decision.outcome, "RESTORE");
    assert.ok(decision.reasonCodes.includes("NON_RESUMABLE_STATE_DEFERRED"));

    const gen2 = ledger.advance("post-recovery").generationId;
    const rec = await recovery.restore.executeRestore(decision, system.store.get(decision.capsuleId), system.registry, {
        runtimeGenerationId: gen2
    });
    assert.equal(rec.outcome, "RESTORED");
    assert.equal(rec.runtimeGenerationId, gen2);
});

test("ports: inert integration ports exist, validate names, wire nothing", () => {
    const expected = [
        "acc", "authority", "sensorium", "semantic-desktop",
        "resource-governor", "presence-runtime", "interaction-bus", "actuation-fabric"
    ];
    for (const name of expected) {
        const port = recovery.ports.createInertPort(name);
        assert.equal(port.port, name);
        assert.equal(port.wired, false);
    }
    assert.throws(() => recovery.ports.createInertPort("not-a-port"), RangeError);
});

test("public API is frozen (no live mutation surface)", () => {
    assert.ok(Object.isFrozen(recovery));
});
