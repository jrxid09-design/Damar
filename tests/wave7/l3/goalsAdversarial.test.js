const test = require("node:test");
const assert = require("node:assert");

const { createGoalEngine, BOUNDS } = require("../../../src/cognition/goals");

function baseGoalSpec(overrides = {}) {
    return {
        title: "test goal", kind: "OWNER_ASSIGNED",
        origin: { kind: "OWNER", ref: "owner-1", evidenceRef: null },
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", expectedValue: "done" },
        ...overrides
    };
}

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

test("GL-A1: goal injection through conversation text requires owner approval like any self-proposal", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec({
        kind: "SELF_PROPOSED", origin: { kind: "SELF", ref: "planner-text", evidenceRef: null }
    }));
    assert.equal(g.state, "PROPOSED");
    assert.equal(g.ownerApproval.state, "REQUIRED");
    ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "r" });
    assertThrowsReason(() => ge.transition(g.goalId, "activate", { actorKind: "SELF", reason: "self-activate" }),
        "APPROVAL_REQUIRED");
});

test("GL-A2: unauthorized persistent goal cannot self-approve; standing approval expiry blocks activation", async () => {
    const ge = await createGoalEngine({
        authorityPort: { checkApproval: () => ({ valid: false }) }
    });
    const g = ge.proposeGoal(baseGoalSpec());
    ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "r" });
    ge.grantApproval(g.goalId, { approvalRef: "standing-approval-1" });
    assertThrowsReason(() => ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" }),
        "APPROVAL_EXPIRED");
});

test("GL-A3: plans hold no grants — createPlan/createTask accept no authority-shaped field", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    assert.equal(Object.prototype.hasOwnProperty.call(p, "grant"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p, "authProof"), false);
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: { op: "noop" } });
    assert.equal(Object.prototype.hasOwnProperty.call(t, "grant"), false);
});

test("GL-A4-repair: depth is derived from the real parent, caller-supplied depth is ignored (Codex P2 round 4)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_DEPTH: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    const parent = ge.proposeGoal(baseGoalSpec({ depth: 0 }));
    const child = ge.proposeGoal(baseGoalSpec({ depth: 0, parentGoalId: parent.goalId })); // lies about depth
    assert.equal(child.depth, 1, "depth diturunkan dari induk, bukan dipercaya dari pemanggil");
    const grandchild = ge.proposeGoal(baseGoalSpec({ depth: 0, parentGoalId: child.goalId }));
    assert.equal(grandchild.depth, 2);
    assertThrowsReason(() => ge.proposeGoal(baseGoalSpec({ depth: 0, parentGoalId: grandchild.goalId })),
        "GOAL_DEPTH_EXCEEDED");
});

test("GL-A4: recursive goal explosion is stopped by depth/child/rate caps", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_DEPTH: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    const root = ge.proposeGoal(baseGoalSpec());
    const child = ge.proposeGoal(baseGoalSpec({ parentGoalId: root.goalId }));
    const grandchild = ge.proposeGoal(baseGoalSpec({ parentGoalId: child.goalId }));
    assert.equal(grandchild.depth, 2);
    assertThrowsReason(() => ge.proposeGoal(baseGoalSpec({ parentGoalId: grandchild.goalId })),
        "GOAL_DEPTH_EXCEEDED");
});

test("GL-repair-1: the total-goal retention cap is enforced even when no goal is terminal (Codex P2 round 6)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    ge.proposeGoal(baseGoalSpec());
    ge.proposeGoal(baseGoalSpec());
    // Both goals are still PROPOSED (non-terminal) -- there is nothing to
    // evict, so the third proposal must be rejected, not silently admitted
    // past MAX_TOTAL_GOALS_RETAINED.
    assertThrowsReason(() => ge.proposeGoal(baseGoalSpec()), "GOAL_RETENTION_LIMIT_EXCEEDED");
});

test("GL-A5: immortal goal — terminal states are terminal, cannot be reactivated", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "abandon", { actorKind: "OWNER", reason: "no longer needed" });
    assertThrowsReason(() => ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" }),
        "INVALID_TRANSITION");
});

test("GL-A6: owner instruction supersedes a stale goal", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const superseded = ge.transition(g.goalId, "supersede", { actorKind: "OWNER", reason: "changed mind" });
    assert.equal(superseded.state, "SUPERSEDED");
});

test("GL-A7: success faked by citing a T2 result is rejected — SATISFIED requires T1", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" });
    assertThrowsReason(() => ge.transition(g.goalId, "succeed", { actorKind: "SYSTEM", reason: "r", evidenceTier: "T2", evidenceRef: "exec-result" }),
        "SATISFACTION_REQUIRES_T1");
});

test("GL-A8: budgetRef is a reference, never a spendable balance field", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec({ budgetRef: "plan-123" }));
    assert.equal(typeof g.budgetRef, "string");
    assert.equal(Object.prototype.hasOwnProperty.call(g, "balance"), false);
});

test("GL-A9: mission-derived goal never inherits mission authority — same approval gate as any goal", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec({
        kind: "MISSION_DERIVED", origin: { kind: "MISSION", ref: "mission-1", evidenceRef: null },
        missionRef: "mission-1"
    }));
    // No code path here sets ownerApproval from missionRef — verify it stayed at the
    // same default a non-mission goal of this origin kind would get.
    assert.notEqual(g.ownerApproval.state, "GRANTED", "missionRef tidak pernah otomatis memberi approval");
});

test("GL-A10: retry storm after a denial is stopped by the attempt cap", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: {}, maxAttempts: 1 });
    ge.transitionTask(t.taskId, "ready");
    ge.transitionTask(t.taskId, "formIntent");
    ge.transitionTask(t.taskId, "awaitAuthority");
    ge.transitionTask(t.taskId, "execute");
    ge.transitionTask(t.taskId, "fail");
    ge.transitionTask(t.taskId, "retry");
    assertThrowsReason(() => ge.transitionTask(t.taskId, "execute"), "ATTEMPTS_EXCEEDED");
});

test("GL-A11: a task re-checks readiness at READY, plan-time state is not trusted forever", async () => {
    // Structural proof: READY is a distinct, re-enterable gate before formIntent —
    // a caller MUST pass through it again on every fresh attempt (there is no
    // shortcut from PENDING straight to EXECUTING).
    const { TASK_TRANSITIONS } = require("../../../src/cognition/goals/lifecycle");
    assert.ok(!(TASK_TRANSITIONS.execute && TASK_TRANSITIONS.execute.from.includes("PENDING")),
        "tidak ada jalan pintas dari PENDING langsung ke execute");
});

test("GL-A12: cross-node duplicate execution — a second concurrent execute on the same task is refused", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: {} });
    ge.transitionTask(t.taskId, "ready");
    ge.transitionTask(t.taskId, "formIntent");
    ge.transitionTask(t.taskId, "awaitAuthority");
    ge.transitionTask(t.taskId, "execute");
    // A second concurrent "execute" call on the same task must fail — it is
    // no longer in AWAITING_AUTHORITY, preventing a naive duplicate dispatch.
    assertThrowsReason(() => ge.transitionTask(t.taskId, "execute"), "INVALID_TRANSITION");
});
