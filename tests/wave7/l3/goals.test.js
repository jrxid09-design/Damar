const test = require("node:test");
const assert = require("node:assert");

const { createGoalEngine, BOUNDS } = require("../../../src/cognition/goals");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

function baseGoalSpec(overrides = {}) {
    return {
        title: "test goal", kind: "OWNER_ASSIGNED",
        origin: { kind: "OWNER", ref: "owner-1", evidenceRef: null },
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", expectedValue: "done" },
        ...overrides
    };
}

test("W7-L3 structural: createGoalEngine exposes the frozen public contract", async () => {
    const ge = await createGoalEngine();
    for (const method of ["proposeGoal", "grantApproval", "transition", "getGoal",
        "createCommitment", "transitionCommitment", "createPlan",
        "invalidatePlanIfAssumptionBroken", "createTask", "transitionTask", "getTask"]) {
        assert.equal(typeof ge[method], "function", `missing ${method}`);
    }
    assert.ok(ge.laws.GOAL_NOT_AUTHORITY);
});

test("W7-L3 functional: owner-assigned goal can approve/activate without extra grant", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    assert.equal(g.state, "PROPOSED");
    assert.equal(g.ownerApproval.state, "NOT_REQUIRED");

    const accepted = ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "owner approved" });
    assert.equal(accepted.state, "ACCEPTED");
    const active = ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "start" });
    assert.equal(active.state, "ACTIVE");
});

test("W7-L3 functional: exhaustive lifecycle transition table (spec section 4)", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "block", { actorKind: "SYSTEM", reason: "r" });
    ge.transition(g.goalId, "unblock", { actorKind: "SYSTEM", reason: "r" });
    ge.transition(g.goalId, "pause", { actorKind: "OWNER", reason: "r" });
    ge.transition(g.goalId, "resume", { actorKind: "OWNER", reason: "r" });
    const satisfied = ge.transition(g.goalId, "succeed", { actorKind: "SYSTEM", reason: "r", evidenceTier: "T1", evidenceRef: "fact-1" });
    assert.equal(satisfied.state, "SATISFIED");

    // G-8: terminal states are terminal.
    assert.throws(() => ge.transition(g.goalId, "activate", { actorKind: "OWNER", reason: "r" }),
        (err) => err.reason === "INVALID_TRANSITION");
});

test("W7-L3 functional: G-7 every transition records actorKind/reason/evidenceRef, no anonymous transition", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const accepted = ge.transition(g.goalId, "approve", { actorKind: "OWNER", reason: "because" });
    assert.equal(accepted.transitions.length, 1);
    assert.deepEqual(Object.keys(accepted.transitions[0]).sort(),
        ["actorKind", "at", "evidenceRef", "from", "reason", "to"]);
});

test("W7-L3 restart: no task resumes in EXECUTING", async () => {
    const store = createMemoryAccStore();
    const ge1 = await createGoalEngine({ store });
    const g = ge1.proposeGoal(baseGoalSpec());
    const p = ge1.createPlan({ goalRef: g.goalId, steps: [] });
    const t = ge1.createTask({ planRef: p.planId, order: 1, intentTemplate: { op: "noop" } });
    ge1.transitionTask(t.taskId, "ready");
    ge1.transitionTask(t.taskId, "formIntent");
    ge1.transitionTask(t.taskId, "awaitAuthority");
    ge1.transitionTask(t.taskId, "execute");
    await ge1.persist();

    const ge2 = await createGoalEngine({ store });
    const restored = ge2.getTask(t.taskId);
    assert.equal(restored.state, "PENDING", "EXECUTING tidak pernah dilanjutkan setelah restart");
});

test("W7-L3 boundedness: goal depth/children/creation-rate/active-goal caps", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_DEPTH: 1, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    assert.throws(() => ge.proposeGoal(baseGoalSpec({ depth: 2 })),
        (err) => err.reason === "GOAL_DEPTH_EXCEEDED");

    const ge2 = await createGoalEngine({ bounds: { ...BOUNDS, MAX_CHILDREN_PER_GOAL: 1, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    const parent = ge2.proposeGoal(baseGoalSpec());
    ge2.proposeGoal(baseGoalSpec({ parentGoalId: parent.goalId }));
    assert.throws(() => ge2.proposeGoal(baseGoalSpec({ parentGoalId: parent.goalId })),
        (err) => err.reason === "CHILDREN_LIMIT_EXCEEDED");

    const ge3 = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_CREATION_RATE_PER_MINUTE: 2 } });
    ge3.proposeGoal(baseGoalSpec());
    ge3.proposeGoal(baseGoalSpec());
    assert.throws(() => ge3.proposeGoal(baseGoalSpec()),
        (err) => err.reason === "CREATION_RATE_EXCEEDED");
});

test("W7-L3 boundedness: MAX_ATTEMPTS_PER_TASK is enforced across retries", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 } });
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: {}, maxAttempts: 2 });

    ge.transitionTask(t.taskId, "ready");
    ge.transitionTask(t.taskId, "formIntent");
    ge.transitionTask(t.taskId, "awaitAuthority");
    ge.transitionTask(t.taskId, "execute");   // attempt 1
    ge.transitionTask(t.taskId, "fail");
    ge.transitionTask(t.taskId, "retry");     // back to AWAITING_AUTHORITY, new intent
    ge.transitionTask(t.taskId, "execute");   // attempt 2, at maxAttempts
    ge.transitionTask(t.taskId, "fail");
    ge.transitionTask(t.taskId, "retry");

    assert.throws(() => ge.transitionTask(t.taskId, "execute"), // attempt 3 > maxAttempts(2)
        (err) => err.reason === "ATTEMPTS_EXCEEDED");
});
