"use strict";

/**
 * W9-L1 Mission Intelligence — adversarial tests (RT-W9-01..10).
 * PM-34: tests written BEFORE implementation.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

const { makeMissionStore } = require("../../../src/cognition/mission/store");
const { makeMission } = require("../../../src/cognition/mission/mission");
const { makeDelegation } = require("../../../src/cognition/mission/delegation");
const { makeReport } = require("../../../src/cognition/mission/report");

function makePorts() {
    const acc = createMemoryAccStore();
    const store = makeMissionStore(acc);
    const mission = makeMission(store);
    const delegation = makeDelegation(store);
    const report = makeReport(store);
    return { store, mission, delegation, report };
}

// RT-W9-01: mission from chat text → DRAFT, requires owner approval
test("RT-W9-01: mission created from chat text starts as DRAFT pending owner approval", async () => {
    const { mission } = makePorts();
    const m = await mission.create("m-01", { label: "Buy ETH", source: "chat" });
    assert.equal(m.state, "DRAFT");
    assert.equal(m.ownerApproved, false);
    await assert.rejects(
        () => mission.activate("m-01"),
        { message: /owner approval|DRAFT/i }
    );
});

// RT-W9-02: scope widening at runtime refused
test("RT-W9-02: Damar cannot widen mission scope at runtime", async () => {
    const { mission } = makePorts();
    await mission.create("m-02", { label: "research", scope: ["read"] });
    await mission.activate("m-02", { ownerApproval: true });
    await assert.rejects(
        () => mission.widenScope("m-02", ["read", "write", "exec"]),
        { message: /scope.*widen|refused|audited/i }
    );
    const m = await mission.get("m-02");
    assert.deepEqual(m.scope, ["read"]);
});

// RT-W9-03: sub-mission budget exceeds parent → refused at write
test("RT-W9-03: sub-mission budget cannot exceed parent slice", async () => {
    const { mission } = makePorts();
    await mission.create("parent", { label: "parent", budget: { cpu: 10 } });
    await mission.activate("parent", { ownerApproval: true });
    await assert.rejects(
        () => mission.create("child", { label: "child", parentId: "parent", budget: { cpu: 20 } }),
        { message: /budget.*exceed|slice.*non-additive/i }
    );
});

// RT-W9-04: completion without T1 evidence stays active
test("RT-W9-04: completion without T1 evidence refused — mission stays active", async () => {
    const { mission } = makePorts();
    await mission.create("m-04", { label: "task" });
    await mission.activate("m-04", { ownerApproval: true });
    await assert.rejects(
        () => mission.complete("m-04", { evidence: "I did it" }),
        { message: /T1|verified evidence|completion.*cite/i }
    );
    const m = await mission.get("m-04");
    assert.equal(m.state, "ACTIVE");
});

// RT-W9-05: self-resume after safety pause refused
test("RT-W9-05: self-resume after safety pause refused", async () => {
    const { mission } = makePorts();
    await mission.create("m-05", { label: "task" });
    await mission.activate("m-05", { ownerApproval: true });
    await mission.pause("m-05", { reason: "safety" });
    await assert.rejects(
        () => mission.resume("m-05"),
        { message: /owner.*resume|self-resume/i }
    );
    const m = await mission.get("m-05");
    assert.equal(m.state, "PAUSED");
});

// RT-W9-06: mission past duration cap → BLOCKED
test("RT-W9-06: mission exceeding duration cap transitions to BLOCKED", async () => {
    const { mission } = makePorts();
    await mission.create("m-06", { label: "timed", durationCapMs: 1 });
    await mission.activate("m-06", { ownerApproval: true });
    await new Promise(r => setTimeout(r, 5));
    await mission.checkDuration("m-06");
    const m = await mission.get("m-06");
    assert.equal(m.state, "BLOCKED");
});

// RT-W9-07: report suppression blocks mission
test("RT-W9-07: suppressing required report blocked", async () => {
    const { mission } = makePorts();
    await mission.create("m-07", { label: "task", requiresReport: true });
    await mission.activate("m-07", { ownerApproval: true });
    await assert.rejects(
        () => mission.suppressReport("m-07"),
        { message: /report.*suppress|reporting.*obligat/i }
    );
});

// RT-W9-08: revoked capability → mission BLOCKED
test("RT-W9-08: mission with revoked capability transitions to BLOCKED", async () => {
    const { mission } = makePorts();
    await mission.create("m-08", { label: "task", capabilities: ["send-email"] });
    await mission.activate("m-08", { ownerApproval: true });
    await mission.revokeCapability("m-08", "send-email");
    const m = await mission.get("m-08");
    assert.equal(m.state, "BLOCKED");
});

// RT-W9-09: cross-mission privilege borrowing refused
test("RT-W9-09: cross-mission privilege borrowing refused", async () => {
    const { mission } = makePorts();
    await mission.create("m-09a", { label: "task-a", capabilities: ["admin"] });
    await mission.activate("m-09a", { ownerApproval: true });
    await mission.create("m-09b", { label: "task-b", capabilities: ["read"] });
    await mission.activate("m-09b", { ownerApproval: true });
    await assert.rejects(
        () => mission.borrowCapability("m-09b", "admin", { fromMission: "m-09a" }),
        { message: /cross-mission|borrow.*refused|per-intent/i }
    );
});

// RT-W9-10: delegation TRANSFER mode refused
test("RT-W9-10: delegation TRANSFER mode refused — request-only", async () => {
    const { delegation } = makePorts();
    await assert.rejects(
        () => delegation.create("m-10", { mode: "TRANSFER", to: "agent-x" }),
        { message: /TRANSFER.*mode|delegation.*transfer.*refused/i }
    );
    const d = await delegation.create("m-10", { mode: "REQUEST", to: "agent-x" });
    assert.equal(d.mode, "REQUEST");
});
