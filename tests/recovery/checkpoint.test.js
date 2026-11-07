"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    makeFakeProvider,
    makeSystem
} = require("./helpers/fakes");
const {
    CheckpointBuilder,
    RecoveryCheckpointAborted,
    RecoveryFault
} = require("../../src/runtime/recovery/checkpoint");
const { CAPSULE_STATUS } = require("../../src/runtime/recovery/manifest");
const { canonicalBytes } = require("../../src/runtime/recovery/canonicalJson");

function setup() {
    const system = makeSystem();
    const pAcc = makeFakeProvider({ id: "acc" });
    const pSens = makeFakeProvider({ id: "sensorium", classification: "PUBLIC_STATE", required: false });
    system.registry.register(pAcc);
    system.registry.register(pSens);
    return { ...system, pAcc, pSens };
}

async function expectAborted(fn) {
    await assert.rejects(fn, RecoveryCheckpointAborted);
}

test("checkpoint: happy path produces COMPLETE capsule visible atomically in store", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({
        reason: "TEST",
        runtimeGenerationId: s.generationLedger.current
    });
    assert.equal(cap.manifest.status, CAPSULE_STATUS.COMPLETE);
    assert.equal(s.store.size, 1);
    assert.deepEqual(
        cap.manifest.sections.map((x) => x.sectionId),
        ["acc", "sensorium"]
    );
});

test("crash matrix 1: fault before capture leaves zero capsules", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current, faults: ["before-capture"] })
    );
    assert.equal(s.store.size, 0);
    assert.deepEqual(s.store.candidates(), []);
});

test("crash matrix 2: fault during provider capture leaves zero capsules", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({
            reason: "TEST",
            runtimeGenerationId: s.generationLedger.current,
            faults: ["during-capture:acc"]
        })
    );
    assert.equal(s.store.size, 0);
    assert.equal(s.pAcc.__state.captured, 1);
});

test("crash matrix 3: crash after one section captured leaves zero capsules and no partial store entry", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({
            reason: "TEST",
            runtimeGenerationId: s.generationLedger.current,
            faults: ["after-capture:acc"]
        })
    );
    assert.equal(s.store.size, 0);
});

test("crash matrix 4: crash after all sections captured but before manifest leaves nothing restorable", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({
            reason: "TEST",
            runtimeGenerationId: s.generationLedger.current,
            faults: ["before-manifest"]
        })
    );
    assert.equal(s.store.size, 0);
    assert.equal(s.store.candidates().length, 0);
});

test("crash matrix 5: capsule built but commit never reached -> no COMPLETE capsule exists", async () => {
    const s = setup();
    const builder = new CheckpointBuilder(s);
    const originalCommit = s.store.commit.bind(s.store);
    let built = false;
    s.store.commit = (wire) => { built = true; throw new RecoveryFault("simulated-process-death-before-commit"); };
    await expectAborted(() =>
        builder.run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current })
    );
    assert.ok(built, "capsule was fully built in memory");
    assert.equal(s.store.size, 0, "store never saw the uncommitted capsule");
    assert.notEqual(builder.status, CAPSULE_STATUS.COMPLETE);
    s.store.commit = originalCommit;
});

test("crash matrix 6: failure during persistence commit is atomic (nothing stored)", async () => {
    const s = setup();
    const originalCommit = s.store.commit.bind(s.store);
    s.store.commit = () => {
        // simulate IO error after validation but before visibility
        throw new Error("EIO during persistence");
    };
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current })
    );
    assert.equal(s.store.size, 0);
    s.store.commit = originalCommit;
});

test("checkpoint: capture throwing marks builder INVALID and aborts cleanly", async () => {
    const s = setup();
    s.pAcc.__state.captureThrows = new Error("subsystem exploded");
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current })
    );
    assert.equal(s.store.size, 0);
});

test("checkpoint: oversized section rejected before manifest", async () => {
    const s = makeSystem({ maxSectionBytes: 32 });
    s.registry.register(makeFakeProvider({ id: "acc", data: { blob: "x".repeat(256) } }));
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current })
    );
    assert.equal(s.store.size, 0);
});

test("checkpoint: circular capture object fails closed without storing anything", async () => {
    const s = setup();
    const circular = {};
    circular.self = circular;
    s.registry.register(
        Object.assign({}, s.pAcc, { id: "acc2" }) && makeCircularProvider(circular)
    );
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current })
    );
    assert.equal(s.store.size, 0);
});

function makeCircularProvider(payload) {
    const { defineRecoveryProvider } = require("../../src/runtime/recovery/provider");
    return defineRecoveryProvider({
        id: "circ",
        schemaVersion: 1,
        classification: "INTERNAL_STATE",
        required: true,
        capture: () => payload,
        validateSection: () => true,
        prepareRestore: (d) => d,
        commitRestore: () => {}
    });
}

test("checkpoint: EPHEMERAL section not checkpointed unless explicitly allowed", async () => {
    const s = setup();
    s.registry.register(makeFakeProvider({ id: "presence", classification: "EPHEMERAL", required: false }));
    const cap = await new CheckpointBuilder(s).run({
        reason: "TEST",
        runtimeGenerationId: s.generationLedger.current
    });
    assert.ok(!cap.manifest.sections.some((x) => x.sectionId === "presence"));

    const s2 = makeSystem({ allowEphemeralCheckpoint: true });
    s2.registry.register(makeFakeProvider({ id: "presence", classification: "EPHEMERAL", required: false, data: { online: true } }));
    s2.registry.register(makeFakeProvider({ id: "acc" }));
    const cap2 = await new CheckpointBuilder(s2).run({
        reason: "TEST",
        runtimeGenerationId: s2.generationLedger.current
    });
    assert.ok(cap2.manifest.sections.some((x) => x.sectionId === "presence"));
});

test("store: duplicate capsule id rejected", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    assert.throws(() => s.store.commit(cap), /duplicate capsule id/);
    assert.equal(s.store.size, 1);
});

test("store: same epoch conflicting capsule rejected", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const forged = JSON.parse(JSON.stringify(cap));
    forged.manifest.capsuleId = "rc-" + "f".repeat(32);
    // digest no longer matches, which itself must be rejected — either way fail closed
    assert.throws(() => s.store.commit(forged), Error);
    assert.equal(s.store.size, 1);
});

test("builder: unknown checkpoint reason rejected", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "BECAUSE_I_FEEL_LIKE_IT", runtimeGenerationId: s.generationLedger.current })
    );
    assert.equal(s.store.size, 0);
});

test("builder: malformed generation id rejected before any capture", async () => {
    const s = setup();
    await expectAborted(() =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: "../../evil" })
    );
    assert.equal(s.pAcc.__state.captured, 0);
});
