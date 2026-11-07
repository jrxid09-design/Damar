"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const { analyzeLineage } = require("../../src/runtime/recovery/lineage");

async function buildChain(s, depth) {
    const caps = [];
    let parent = null;
    for (let i = 0; i < depth; i += 1) {
        const cap = await new CheckpointBuilder(s).run({
            reason: "TEST",
            runtimeGenerationId: s.generationLedger.current,
            parentCapsuleId: parent
        });
        caps.push(cap);
        parent = cap.manifest.capsuleId;
    }
    return caps;
}

test("lineage: clean chain produces no diagnostics", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const caps = await buildChain(s, 3);
    const result = analyzeLineage(caps, s.config);
    assert.ok(result.ok);
    assert.deepEqual(result.diagnostics, []);
});

test("lineage: missing parent detected explicitly", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const [cap] = await buildChain(s, 1);
    const orphan = JSON.parse(JSON.stringify(cap));
    orphan.manifest.parentCapsuleId = "rc-" + "d".repeat(32);
    // parent not present in analyzed set
    const result = analyzeLineage([orphan], s.config);
    assert.ok(!result.ok);
    assert.ok(result.diagnostics.some((d) => d.code === "LINEAGE_MISSING_PARENT"));
});

test("lineage: cycle detected and never silently resolved", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const caps = await buildChain(s, 2);
    const a = JSON.parse(JSON.stringify(caps[0]));
    const b = JSON.parse(JSON.stringify(caps[1]));
    a.manifest.parentCapsuleId = b.manifest.capsuleId;
    const result = analyzeLineage([a, b], s.config);
    assert.equal(result.hasCycle, true);
    assert.ok(result.diagnostics.some((d) => d.code === "LINEAGE_CYCLE"));
});

test("lineage: fork (one parent, two children) produces explicit diagnostic", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const root = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const child1 = await new CheckpointBuilder(s).run({
        reason: "TEST",
        runtimeGenerationId: s.generationLedger.current,
        parentCapsuleId: root.manifest.capsuleId
    });
    const child2 = await new CheckpointBuilder(s).run({
        reason: "TEST",
        runtimeGenerationId: s.generationLedger.current,
        parentCapsuleId: root.manifest.capsuleId
    });
    const result = analyzeLineage([root, child1, child2], s.config);
    assert.equal(result.hasFork, true);
    assert.ok(result.diagnostics.some((d) => d.code === "LINEAGE_FORK"));
});

test("lineage: same epoch conflicting capsules produce diagnostic", () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc" }));
    void s;
    const mk = (capsuleId, epochId) => ({
        manifest: {
            capsuleFormatVersion: 1,
            capsuleId,
            parentCapsuleId: null,
            epochId,
            runtimeGenerationId: "rtg-" + "1".repeat(32),
            createdAtMs: 1,
            reason: "TEST",
            status: "COMPLETE",
            sections: [],
            manifestDigest: "0".repeat(64)
        },
        sections: {}
    });
    const result = analyzeLineage(
        [mk("rc-" + "a".repeat(32), "repoch-00000000000000000001"), mk("rc-" + "b".repeat(32), "repoch-00000000000000000001")],
        s.config
    );
    assert.ok(result.diagnostics.some((d) => d.code === "LINEAGE_CONFLICTING_EPOCH"));
});

test("lineage: excessive depth bounded", async () => {
    const s = makeSystem({ maxLineageDepth: 4 });
    s.registry.register(makeFakeProvider({ id: "acc" }));
    const caps = await buildChain(s, 8);
    const result = analyzeLineage(caps, s.config);
    assert.ok(result.diagnostics.some((d) => d.code === "LINEAGE_TOO_DEEP"));
});
