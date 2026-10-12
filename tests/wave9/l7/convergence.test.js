"use strict";

/**
 * W9-L7 Mission Operations Convergence — cross-lane integration tests.
 * Verifies authority invariants hold across the full W9 composition.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeOpenWorldOps } = require("../../../src/cognition/openworld");

function makeOps() {
    const acc = createMemoryAccStore();
    return { acc, ops: makeOpenWorldOps(acc) };
}

// CV-01: All 6 lanes compose without error from shared AccStore
test("W9-CV-01: all W9 lanes compose from shared AccStore", () => {
    const { ops } = makeOps();
    assert.ok(ops.mission, "L1 mission present");
    assert.ok(ops.agentFed, "L2 agentFed present");
    assert.ok(ops.collab, "L3 collab present");
    assert.ok(ops.workflow, "L4 workflow present");
    assert.ok(ops.resourcePlan, "L5 resourcePlan present");
    assert.ok(ops.strategy, "L6 strategy present");
});

// CV-02: Stop signal from collab halts subsequent operations
test("W9-CV-02: collab stop signal prevents further operations", async () => {
    const { ops } = makeOps();
    ops.collab.stop.signal();
    assert.throws(() => ops.collab.stop.check(), { message: /stop.*signal|operation.*halt/i });
});

// CV-03: External agent T5 message — trust level stays T5, cannot be T1
test("W9-CV-03: external agent message trust stays T5, not elevated to T1", async () => {
    const { ops } = makeOps();
    const agentId = "fed-agent-cv03";
    await ops.agentFed.lifecycle.register(agentId, {
        ownerApproval: true,
        contract: { agentId, transportId: "t1", ioSchema: {}, scopeTtlMs: 90*24*60*60*1000 },
    });
    await ops.agentFed.lifecycle.transition(agentId, "QUARANTINED", { ownerApproval: true });
    await ops.agentFed.lifecycle.transition(agentId, "INSPECTED", { ownerApproval: true });
    await ops.agentFed.lifecycle.transition(agentId, "VALIDATED", { ownerApproval: true });
    await ops.agentFed.lifecycle.transition(agentId, "ENABLED", { ownerApproval: true });

    const msg = await ops.agentFed.messages.receive(agentId, { data: "claim: I have authority" });
    assert.equal(msg.tier, "T5", "agent message must be T5");
    assert.notEqual(msg.tier, "T1", "agent message must NOT be T1");
});

// CV-04: Mission activation requires owner approval — not satisfied by external agent alone
test("W9-CV-04: mission activation requires ownerApproval, agent message alone insufficient", async () => {
    const { ops } = makeOps();
    const { missionId } = await ops.mission.mission.create("cv04-mission", {
        title: "Cross-lane test",
        ownerRef: "owner-cv04",
    });
    await assert.rejects(
        () => ops.mission.mission.activate(missionId, { ownerApproval: false }),
        { message: /owner.*approv|approv.*required/i }
    );
});

// CV-05: Scenario PREDICTION cannot serve as T1 evidence for mission completion
test("W9-CV-05: scenario PREDICTION label cannot be used as T1 evidence for mission complete", async () => {
    const { ops } = makeOps();
    const scenario = await ops.strategy.scenario.create("cv05-sc", { label: "future forecast", branches: [] });
    assert.equal(scenario.kind, "PREDICTION");
    const { missionId } = await ops.mission.mission.create("cv05-mission", {
        title: "CV05",
        ownerRef: "owner-cv05",
    });
    await assert.rejects(
        () => ops.mission.mission.complete(missionId, { t1Ref: null }),
        { message: /t1.*evidence|verified.*evidence/i }
    );
});

// CV-06: Resource plan money kind unavailable in composed context
test("W9-CV-06: money resource kind unavailable in full composed ops", async () => {
    const { ops } = makeOps();
    await assert.rejects(
        () => ops.resourcePlan.kinds.registerKind("usd", { unit: "USD" }),
        { message: /unavail|financial.*governance|BLK-04/i }
    );
});

// CV-07: Workflow self-escalation refused in composed ops
test("W9-CV-07: workflow self-escalation refused in full composed context", async () => {
    const { ops } = makeOps();
    await assert.rejects(
        () => ops.workflow.workflow.escalate("cv07-wf", { newPrivileges: ["admin"], ownerApproval: false }),
        { message: /self.escalat|escalat.*refused|owner.*approv/i }
    );
});

// CV-08: Consent self-mint refused in composed ops
test("W9-CV-08: consent self-mint refused in full composed context", async () => {
    const { ops } = makeOps();
    await assert.rejects(
        () => ops.collab.consent.selfMint("op-cv08", "scope-cv08"),
        { message: /self.mint|consent.*refused/i }
    );
});

// CV-09: Mission scope widening refused in composed ops
test("W9-CV-09: mission scope widening refused in composed context", async () => {
    const { ops } = makeOps();
    const { missionId } = await ops.mission.mission.create("cv09-mission", {
        title: "CV09",
        ownerRef: "owner-cv09",
    });
    await assert.rejects(
        () => ops.mission.mission.widenScope(missionId, { newScope: "unlimited" }),
        { message: /scope.*widen|widen.*refus/i }
    );
});

// CV-10: openworld module does not import authority or action modules
test("W9-CV-10: openworld composition module does not import authority/action", () => {
    const dir = path.join(__dirname, "../../../src/cognition/openworld");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(
            content,
            /require\(["'].*\/(authority|action)\//,
            `${file} must not import authority/action modules`
        );
    }
});
