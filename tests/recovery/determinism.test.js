"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const selector = require("../../src/runtime/recovery/selector");
const { canonicalBytes } = require("../../src/runtime/recovery/canonicalJson");

test("determinism: provider registration order does not affect section bytes or ordering", async () => {
    const mkProviders = () => [
        { id: "alpha", data: { n: 1 } },
        { id: "beta", data: { n: [2, 1] } },
        { id: "gamma", data: { deep: { z: 26, a: 1 } } }
    ];

    const s1 = makeSystem();
    for (const p of mkProviders()) {
        s1.registry.register(makeFakeProvider(p));
    }
    const s2 = makeSystem();
    for (const p of [...mkProviders()].reverse()) {
        s2.registry.register(makeFakeProvider(p));
    }

    const cap1 = await new CheckpointBuilder(s1).run({ reason: "TEST", runtimeGenerationId: s1.generationLedger.current });
    const cap2 = await new CheckpointBuilder(s2).run({ reason: "TEST", runtimeGenerationId: s2.generationLedger.current });

    const ids1 = cap1.manifest.sections.map((x) => x.sectionId);
    const ids2 = cap2.manifest.sections.map((x) => x.sectionId);
    assert.deepEqual(ids1, ["alpha", "beta", "gamma"]);
    assert.deepEqual(ids1, ids2);

    for (const entry of cap1.manifest.sections) {
        const other = cap2.manifest.sections.find((x) => x.sectionId === entry.sectionId);
        assert.equal(entry.digest, other.digest, `digest mismatch for ${entry.sectionId}`);
        assert.equal(entry.byteLength, other.byteLength);
    }

    const payloadBytes1 = canonicalBytes(cap1.sections);
    const payloadBytes2 = canonicalBytes(cap2.sections);
    assert.deepEqual(payloadBytes1, payloadBytes2);
});

test("determinism: candidate arrival order never changes the RecoveryDecision", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const capA = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const capB = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const capC = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });

    const decide = (candidates) =>
        selector.decide({
            candidates,
            registry: s.registry,
            config: s.config,
            policy: "NEWEST_VALID"
        });

    const d1 = decide([capA, capB, capC]);
    const d2 = decide([capC, capA, capB]);
    const d3 = decide([capB, capC, capA]);
    assert.equal(JSON.stringify(d1), JSON.stringify(d2));
    assert.equal(JSON.stringify(d2), JSON.stringify(d3));
    assert.equal(d1.capsuleId, capC.manifest.capsuleId, "newest epoch must win under explicit policy");
});

test("determinism: no Map insertion-order dependence in registry listing", () => {
    const s = makeSystem();
    for (const id of ["zulu", "alpha", "mike"]) {
        s.registry.register(makeFakeProvider({ id }));
    }
    assert.deepEqual(
        s.registry.list().map((p) => p.id),
        ["alpha", "mike", "zulu"]
    );
});
