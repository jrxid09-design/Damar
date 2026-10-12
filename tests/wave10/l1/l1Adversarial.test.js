"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeWorkspaceIntelligence } = require("../../../src/cognition/workspace/index");
const { admit: gwAdmit, emptyWorkspace } = require("../../../src/cognition/workspace/GlobalWorkspace");

function makeAcc() { return createMemoryAccStore(); }
function makeOps() { return makeWorkspaceIntelligence(makeAcc()); }

test("RT-W10-01: context flooding retains safety items in stage", async () => {
    const { workspace } = makeOps();
    for (let i = 0; i < 7; i++) {
        await workspace.admit({ itemId: `normal-${i}`, sourceRef: `ref-${i}`, kind: "ref", salience: i * 0.1 });
    }
    await workspace.admit({ itemId: "safety-1", sourceRef: "ref-s1", kind: "ref", safety: true, salience: 0 });
    await workspace.admit({ itemId: "safety-2", sourceRef: "ref-s2", kind: "ref", safety: true, salience: 0 });
    const assembly = await workspace.getAssembly();
    const safetyInAssembly = assembly.filter(i => i.safety === true);
    assert.ok(safetyInAssembly.length >= 1, "Safety items must be retained in assembly despite flooding (W10-L1/RT-W10-01)");
});

test("RT-W10-02: authority object admission refused", async () => {
    const { workspace } = makeOps();
    await assert.rejects(
        () => workspace.admit({ itemId: "auth-1", sourceRef: "ref-a1", kind: "authority" }),
        /privileged.*kind|authority.*forbidden/i
    );
    // Adversarial: uppercase and mixed-case must also be refused (NO_PRIVILEGED_OBJECTS_IN_WORKSPACE)
    await assert.rejects(
        () => workspace.admit({ itemId: "auth-2", sourceRef: "ref-a2", kind: "AUTHORITY" }),
        /privileged.*kind|authority.*forbidden/i
    );
    await assert.rejects(
        () => workspace.admit({ itemId: "auth-3", sourceRef: "ref-a3", kind: "Policy" }),
        /privileged.*kind|policy.*forbidden/i
    );
    // GlobalWorkspace.admit must throw when item has no key (NO_PRIVILEGED_OBJECTS / orphan guard)
    assert.throws(
        () => gwAdmit(emptyWorkspace(), { kind: "ref", novelty: 0.5 }, {}, Date.now()),
        /requires a key|orphan/i
    );
});

test("RT-W10-03: orphan projection without sourceRef refused", async () => {
    const { workspace } = makeOps();
    await assert.rejects(
        () => workspace.admit({ itemId: "orphan-1" }),
        /source reference|orphan/i
    );
});

test("RT-W10-04: stale projection exposed as STALE_REF", async () => {
    const { workspace } = makeWorkspaceIntelligence(makeAcc());
    await workspace.admit({ itemId: "old-item", sourceRef: "ref-old", kind: "ref", freshness: Date.now() - 10 * 60 * 1000 });
    const state = await workspace.checkFreshness("old-item");
    assert.equal(state, "STALE_REF");
});

test("RT-W10-05: pin abuse refused beyond cap", async () => {
    const { workspace } = makeOps();
    const { BOUNDS } = require("../../../src/cognition/workspace/bounds");
    for (let i = 0; i < BOUNDS.MAX_PINS; i++) {
        await workspace.admit({ itemId: `pin-${i}`, sourceRef: `ref-p${i}`, kind: "ref" });
        await workspace.pin(`pin-${i}`);
    }
    await workspace.admit({ itemId: "pin-over", sourceRef: "ref-po", kind: "ref" });
    await assert.rejects(
        () => workspace.pin("pin-over"),
        /pin cap|pin.*refused/i
    );
});

test("RT-W10-06: eviction always audited", async () => {
    const { workspace } = makeOps();
    await workspace.admit({ itemId: "evict-me", sourceRef: "ref-em", kind: "ref" });
    await workspace.evict("evict-me", "test eviction");
    const evictions = await workspace.getEvictions();
    assert.ok(evictions.length >= 1);
    assert.equal(evictions[0].itemId, "evict-me");
});

test("RT-W10-07: token ceiling enforced at assembly", async () => {
    const { BOUNDS } = require("../../../src/cognition/workspace/bounds");
    const { makeAssembly } = require("../../../src/cognition/workspace/assembly");
    const assembly = makeAssembly(BOUNDS);
    const bigItems = Array.from({ length: 3 }, (_, i) => ({
        itemId: `big-${i}`, sourceRef: `ref-b${i}`, kind: "ref",
        tokens: Math.ceil(BOUNDS.MAX_ASSEMBLY_TOKENS / 2), salience: 1,
    }));
    assert.throws(
        () => assembly.checkTokenCeiling(bigItems),
        /token ceiling|token limit/i
    );
});

test("RT-W10-08: duplicate ref refused", async () => {
    const { workspace } = makeOps();
    await workspace.admit({ itemId: "dup-1", sourceRef: "ref-d1", kind: "ref" });
    await assert.rejects(
        () => workspace.admit({ itemId: "dup-1", sourceRef: "ref-d1", kind: "ref" }),
        /duplicate/i
    );
});

test("RT-W10-09: workspace used as content storage refused", async () => {
    const { workspace } = makeOps();
    await assert.rejects(
        () => workspace.admit({ itemId: "content-1", sourceRef: "ref-c1", kind: "ref", content: "unique content here" }),
        /content storage|references only/i
    );
});

test("RT-W10-10: only one focus at a time", async () => {
    const { workspace } = makeOps();
    await workspace.admit({ itemId: "item-a", sourceRef: "ref-a", kind: "ref" });
    await workspace.admit({ itemId: "item-b", sourceRef: "ref-b", kind: "ref" });
    await workspace.setFocus("item-a");
    await workspace.setFocus("item-b");
    const focus = await workspace.getFocus();
    assert.equal(focus, "item-b");
});
