"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeSelfContinuity } = require("../../../src/selfcontinuity/index");
const { makeIdentityRecord } = require("../../../src/selfcontinuity/identity");

function makeOps() {
    return makeSelfContinuity(createMemoryAccStore());
}

test("RT-W10-11: identity without keyRef refused", async () => {
    const { genesis } = makeOps();
    await assert.rejects(
        () => genesis.createIdentity({ identityId: "id-11" }),
        /keyRef required|key-bound/i
    );
});

test("RT-W10-12: fork detected when same generation runs in two instances", async () => {
    const { genesis, incarnation } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-12", keyRef: "key-12" });
    await incarnation.recordIncarnation(identity, "instance-A");
    await incarnation.recordIncarnation(identity, "instance-B");
    const result = await incarnation.detectFork(identity, "instance-A");
    assert.equal(result.forked, true);
    assert.ok(result.instances.includes("instance-B"));
});

test("RT-W10-13: silent fork merge forbidden — owner consent required", async () => {
    const { genesis, fork } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-13", keyRef: "key-13" });
    await assert.rejects(
        () => fork.recordFork(identity, "fork-X", false),
        /silent fork merge forbidden|owner consent/i
    );
});

test("RT-W10-14: restore never restores grants", async () => {
    const { genesis } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-14", keyRef: "key-14" });
    identity.grants = [{ grantId: "g1", permission: "write" }];
    assert.ok(identity.grants.length > 0, "precondition: grants added");
    const restored = makeIdentityRecord({ identityId: "id-14", keyRef: "key-14" });
    assert.deepEqual(restored.grants, [], "restored identity must have empty grants (W10-L2/RT-W10-14)");
    // Adversarial: passing grants in opts must be stripped
    const withGrants = makeIdentityRecord({ identityId: "id-14b", keyRef: "key-14b", grants: [{ grantId: "evil", permission: "admin" }] });
    assert.deepEqual(withGrants.grants, [], "opts.grants passthrough must be refused (W10-L2/RT-W10-14)");
});

test("RT-W10-15: generation regression refused", async () => {
    const { genesis, chain } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-15", keyRef: "key-15" });
    await chain.advanceGeneration(identity, "step-1");
    identity.generation = 0;
    await assert.rejects(
        () => chain.advanceGeneration(identity, "regressed"),
        /monotonically increasing|regression/i
    );
    // Equal-generation case: nextGen == last recorded gen is also refused (invariant boundary)
    const ops2 = makeOps();
    const identity2 = await ops2.genesis.createIdentity({ identityId: "id-15b", keyRef: "key-15b" });
    await ops2.chain.advanceGeneration(identity2, "step-1b");
    const lastGen = identity2.generation;
    identity2.generation = lastGen - 1; // nextGen = lastGen == lastEntry.generation
    await assert.rejects(
        () => ops2.chain.advanceGeneration(identity2, "equal-advance"),
        /monotonically increasing|regression/i
    );
});

test("RT-W10-16: tampered identity reports DISPUTED", async () => {
    const { genesis, checkpoint } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-16", keyRef: "key-16" });
    const cp = checkpoint.makeCheckpoint(identity);
    identity.generation = 999;
    const state = checkpoint.verifyCheckpoint(identity, cp);
    assert.equal(state, "DISPUTED");
});

test("RT-W10-17: generation gap detected as PARTIAL", async () => {
    const { genesis, chain } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-17", keyRef: "key-17" });
    await chain.advanceGeneration(identity, "step-1");
    identity.generation = 10;
    const level = await chain.detectPartial(identity);
    assert.equal(level, "PARTIAL");
});

test("RT-W10-18: provider swap preserves identityId", async () => {
    const opts = { identityId: "stable-id-18", keyRef: "stable-key-18" };
    const recordA = makeIdentityRecord({ ...opts });
    const recordB = makeIdentityRecord({ ...opts });
    assert.equal(recordA.identityId, recordB.identityId);
    assert.equal(recordA.keyRef, recordB.keyRef);
});

test("RT-W10-19: migration without policy refused", async () => {
    const { genesis, migration } = makeOps();
    const identity = await genesis.createIdentity({ identityId: "id-19", keyRef: "key-19" });
    assert.throws(
        () => migration.checkMigrationPolicy(identity, null),
        /no policy|migration refused/i
    );
});

test("RT-W10-20: second genesis refused", async () => {
    const { genesis } = makeOps();
    await genesis.createIdentity({ identityId: "id-20", keyRef: "key-20" });
    await assert.rejects(
        () => genesis.createIdentity({ identityId: "id-20b", keyRef: "key-20b" }),
        /single genesis|already exists/i
    );
});
