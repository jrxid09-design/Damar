"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const selector = require("../../src/runtime/recovery/selector");
const { executeRestore } = require("../../src/runtime/recovery/restore");

/**
 * R25 contract tests: recovered state is historical checkpoint evidence.
 * It must never imply the world is still in that state now.
 */

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

test("R25: every successful restore record carries the belief-vs-reality disclaimer", async () => {
    const s = makeSystem();
    s.registry.register(
        makeFakeProvider({
            id: "sensorium",
            classification: "PUBLIC_STATE",
            required: false,
            data: { devices: [{ id: "lamp", online: true }] }
        })
    );
    const { cap, decision } = await buildAndDecide(s);
    const rec = await executeRestore(decision, cap, s.registry);
    assert.equal(rec.outcome, "RESTORED");
    assert.match(rec.note, /NOT freshly verified reality/i);
    assert.ok(
        !Object.keys(rec).includes("devices"),
        "restore record must not reassert world facts as current"
    );
});

test("R25: device-online-before-crash does not become device-online-now", async () => {
    const s = makeSystem();
    let capturedWorld = { lampOnline: true };
    s.registry.register(
        makeFakeProvider({
            id: "sensorium",
            classification: "PUBLIC_STATE",
            required: false,
            capture: () => ({ lampOnline: capturedWorld.lampOnline })
        })
    );
    const { cap, decision } = await buildAndDecide(s);

    // The real world changed after checkpoint (power loss, device offline).
    capturedWorld = { lampOnline: false };

    // Recovery restores the CHECKPOINTED section verbatim as historical data;
    // it has no channel to claim current truth about the lamp.
    assert.equal(cap.sections.sensorium.data.lampOnline, true, "checkpoint preserved past observation");
    assert.equal(capturedWorld.lampOnline, false, "reality moved on independently");
    const rec = await executeRestore(decision, cap, s.registry);
    assert.match(rec.note, /re-observed/i);
});

test("R25: NON_RESUMABLE unfinished side effects surface as INTERRUPTED, never resumed", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    s.registry.register(
        makeFakeProvider({
            id: "interaction",
            classification: "NON_RESUMABLE",
            required: false,
            data: { pendingKeystrokes: ["ctrl", "s"], partialToolSequence: ["fs.write"] }
        })
    );
    const { decision } = await buildAndDecide(s);
    assert.deepEqual(
        decision.deferredSections.filter((d) => d.sectionId === "interaction"),
        [{ sectionId: "interaction", status: "INTERRUPTED" }]
    );
    assert.ok(decision.reasonCodes.includes("NON_RESUMABLE_STATE_DEFERRED"));
});
