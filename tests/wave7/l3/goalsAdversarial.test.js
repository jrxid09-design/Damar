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

test("GL-repair-2: evicting a terminal child goal decrements its parent's child count (Codex P2 round 8)", async () => {
    let t = 0;
    const clock = { nowMs: () => t++ };
    const ge = await createGoalEngine({
        clock, bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 3, MAX_CHILDREN_PER_GOAL: 1, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 }
    });
    const parent = ge.proposeGoal(baseGoalSpec());
    const child = ge.proposeGoal(baseGoalSpec({ parentGoalId: parent.goalId }));
    ge.transition(child.goalId, "supersede", { actorKind: "OWNER", reason: "no longer needed" }); // oldest terminal
    ge.proposeGoal(baseGoalSpec()); // fillerA (unrelated), size -> 3

    // Retention cap (3) is hit here -> evicts the oldest terminal (child).
    // If childCounts for the parent isn't decremented too, MAX_CHILDREN_PER_GOAL
    // (1) wrongly still looks full even though the child is gone.
    const fillerB = ge.proposeGoal(baseGoalSpec()); // evicts `child`, size stays 3
    ge.transition(fillerB.goalId, "supersede", { actorKind: "OWNER", reason: "no longer needed" }); // new oldest terminal, feeds the next retention check

    assert.doesNotThrow(() => ge.proposeGoal(baseGoalSpec({ parentGoalId: parent.goalId })),
        "childCounts induk harus diturunkan saat anak terminalnya dievict");
});

test("GL-repair-3: intentTemplate cannot carry authority-shaped fields, at any depth (independent audit AUD-P2-4)", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    assertThrowsReason(() => ge.createTask({
        planRef: p.planId, order: 1,
        intentTemplate: { op: "x", authProof: "PROOF-1", grant: "GRANT-1", balance: 999 }
    }), "AUTHORITY_SHAPED_FIELD_REJECTED");
    assertThrowsReason(() => ge.createTask({
        planRef: p.planId, order: 1,
        intentTemplate: { op: "x", nested: { authProof: "PROOF-1" } }
    }), "AUTHORITY_SHAPED_FIELD_REJECTED");
});

test("GL-repair-4: intentTemplate accessors and post-creation mutation cannot bypass the authority guard (independent audit AUD2-P2-1)", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });

    let reads = 0;
    const it = {};
    Object.defineProperty(it, "x", {
        enumerable: true, configurable: true,
        get() { reads++; return reads === 1 ? { ok: true } : { authProof: "TOCTOU-P" }; }
    });
    assertThrowsReason(() => ge.createTask({ planRef: p.planId, order: 1, intentTemplate: it }),
        "AUTHORITY_SHAPED_FIELD_REJECTED");

    // Bug review independen (audit putaran-3, AUD3-P1-2): makeTask sekarang
    // membangun SALINAN baru dari nilai yang tervalidasi (bukan membekukan
    // objek asli pemanggil), jadi memutasi objek asli pemanggil setelahnya
    // tidak berpengaruh sama sekali pada task tersimpan -- keduanya sudah
    // menjadi struktur yang sepenuhnya independen begitu createTask kembali.
    const shared = { nested: {} };
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: shared });
    shared.nested.authProof = "PROOF-INJECTED"; // memutasi objek ASLI pemanggil, bukan salinan tersimpan
    assert.equal(JSON.stringify(t.intentTemplate).includes("authProof"), false);
});

test("GL-repair-5: a Proxy with consistent-but-lying traps cannot smuggle authProof via a hidden get trap (independent audit AUD3-P1-1)", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });

    const target = { safe: 1 };
    const proxy = new Proxy(target, {
        getPrototypeOf() { return Object.prototype; },
        ownKeys() { return ["safe"]; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true, value: 1, writable: true }; },
        get(t2, key) { if (key === "authProof") return "PROXY-INJECTED"; return t2[key]; }
    });
    const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: proxy });
    assert.deepEqual(t.intentTemplate, { safe: 1 });
    assert.equal(t.intentTemplate.authProof, undefined,
        "task.intentTemplate adalah salinan polos kita sendiri -- trap get proxy tidak pernah lagi dibaca setelah createTask");
});

test("GL-repair-6: evicting a goal removes its own childCounts entry, not just the parent's counter (independent audit AUD3-P2-2)", async () => {
    let t = 0;
    const clock = { nowMs: () => t++ };
    const ge = await createGoalEngine({
        clock, bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 }
    });
    // Every parent gets its own childCounts entry the moment a child is
    // proposed under it. Each cycle here ends with BOTH parent and child
    // terminal, so retention always has something to evict on the next
    // cycle's proposals -- if the evicted parent's OWN childCounts entry is
    // never deleted, childCountsSize() grows without bound across cycles.
    for (let i = 0; i < 20; i++) {
        const parent = ge.proposeGoal(baseGoalSpec());
        const child = ge.proposeGoal(baseGoalSpec({ parentGoalId: parent.goalId }));
        ge.transition(child.goalId, "supersede", { actorKind: "OWNER", reason: "cycle" });
        ge.transition(parent.goalId, "supersede", { actorKind: "OWNER", reason: "cycle" });
    }
    assert.ok(ge.childCountsSize() <= 4,
        "childCounts tidak boleh menumpuk kunci induk yang goal-nya sendiri sudah dievict");
});

test("GL-repair-7: intentTemplate array length is bounded (independent audit W7R4-P2-4)", async () => {
    const ge = await createGoalEngine();
    const g = ge.proposeGoal(baseGoalSpec());
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    const N = 3_000_000;
    const arrLikeProxy = new Proxy([], {
        getPrototypeOf() { return Array.prototype; },
        ownKeys() { return ["length"]; },
        getOwnPropertyDescriptor(t, k) {
            if (k === "length") return { value: N, writable: true, enumerable: false, configurable: false };
            if (/^(0|[1-9][0-9]*)$/.test(String(k))) return { value: 0, writable: true, enumerable: true, configurable: true };
            return undefined;
        },
        get(t, k) { return k === "length" ? N : undefined; }
    });
    assertThrowsReason(() => ge.createTask({ planRef: p.planId, order: 1, intentTemplate: [arrLikeProxy] }),
        "AUTHORITY_SHAPED_FIELD_REJECTED");
});

test("GL-repair-8: an unknown origin.kind is rejected before it ever touches the creation-rate map (independent audit W7R4-P2-3)", async () => {
    const ge = await createGoalEngine();
    for (let i = 0; i < 20; i++) {
        assertThrowsReason(() => ge.proposeGoal(baseGoalSpec({ origin: { kind: `BOGUS-${i}`, ref: "x" } })),
            "INVALID_RECORD");
    }
    assert.equal(ge.creationTimestampsSize(), 0,
        "origin.kind sampah tidak boleh pernah membuat kunci baru di peta laju pembuatan");
});

test("GL-repair-9: terminal commitments are retention-bounded, not just OPEN ones (independent audit W7R5-P2-3)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_COMMITMENTS_RETAINED: 5 } });
    for (let i = 0; i < 50; i++) {
        ge.createCommitment({
            commitmentId: `c${i}`, goalRef: "g", toWhom: { id: "o" }, promise: "p",
            dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" }
        });
        ge.transitionCommitment(`c${i}`, "met", {});
    }
    assert.ok(ge.commitmentsSize() <= 5,
        "komitmen terminal (MET/MISSED/RELEASED/RENEGOTIATED) harus dikompaksi, bukan menumpuk tak terbatas");
});

test("GL-repair-10: DONE/SKIPPED tasks are retention-bounded (independent audit W7R5-P2-3)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_TASKS_RETAINED: 5 } });
    for (let i = 0; i < 50; i++) {
        const t = ge.createTask({ taskId: `t${i}`, planRef: "p", order: i, intentTemplate: { x: 1 } });
        ge.transitionTask(t.taskId, "skip");
    }
    assert.ok(ge.tasksSize() <= 5, "task SKIPPED/DONE harus dikompaksi, bukan menumpuk tak terbatas");
});

test("GL-repair-11: evicting a goal removes its own plans, not just the per-goal version cap (independent audit W7R5-P2-3)", async () => {
    let t = 0;
    const clock = { nowMs: () => t++ };
    const ge = await createGoalEngine({
        clock, bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 1000 }
    });
    const g = ge.proposeGoal(baseGoalSpec());
    ge.createPlan({ goalRef: g.goalId, steps: [] });
    ge.transition(g.goalId, "supersede", { actorKind: "OWNER", reason: "cycle" }); // terminal, evictable
    ge.proposeGoal(baseGoalSpec()); // fillerA, size -> 2
    ge.proposeGoal(baseGoalSpec()); // evicts `g` -- its plan should go with it
    assert.equal(ge.plansSize(), 0, "plan milik goal yang dievict harus ikut dihapus, bukan menjadi yatim selamanya");
});

test("GL-repair-12: task retention fails closed when no DONE/SKIPPED victim exists (independent audit W7R6-P1-1)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_TASKS_RETAINED: 5 } });
    for (let i = 0; i < 5; i++) ge.createTask({ taskId: `t${i}`, planRef: "p", order: i }); // stay PENDING, never terminal
    assertThrowsReason(() => ge.createTask({ taskId: "t-overflow", planRef: "p", order: 99 }),
        "TASK_RETENTION_LIMIT_EXCEEDED");
    assert.equal(ge.tasksSize(), 5, "populasi murni non-terminal tidak boleh melampaui batas diam-diam");
});

test("GL-repair-13: plans are globally retention-bounded across distinct goalRefs, not just per-goal (independent audit W7R6-P2-1)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_PLAN_VERSIONS_RETAINED: 3, MAX_TOTAL_PLANS_RETAINED: 10 } });
    for (let g = 0; g < 50; g++) {
        for (let v = 0; v < 3; v++) ge.createPlan({ goalRef: `ghost-${g}`, version: v, steps: [] });
    }
    assert.ok(ge.plansSize() <= 10, "banyak goalRef berbeda tidak boleh menumpuk plan tanpa batas total");
});

test("GL-repair-15: createPlan never returns/evicts the plan it just created, even out-of-order versions (independent audit W7R7-P2-1)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_PLAN_VERSIONS_RETAINED: 3 } });
    ge.createPlan({ planId: "p3", goalRef: "g", version: 3, steps: [] });
    ge.createPlan({ planId: "p2", goalRef: "g", version: 2, steps: [] });
    ge.createPlan({ planId: "p1", goalRef: "g", version: 1, steps: [] });
    ge.createPlan({ planId: "p0", goalRef: "g", version: 0, steps: [] }); // lowest version, created last
    assert.ok(ge.getPlan("p0") !== null, "plan yang baru saja dibuat tidak boleh dievict oleh kompaksinya sendiri");
});

test("GL-repair-14: a rejected createCommitment/createTask never evicts an existing terminal record (independent audit W7R6-P2-2)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_COMMITMENTS_RETAINED: 3, MAX_OPEN_COMMITMENTS: 100 } });
    for (let i = 0; i < 3; i++) {
        ge.createCommitment({
            commitmentId: `c${i}`, goalRef: "g", toWhom: { id: "o" }, promise: "p",
            dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" }
        });
        ge.transitionCommitment(`c${i}`, "met", {});
    }
    assert.equal(ge.commitmentsSize(), 3);
    assert.throws(() => ge.createCommitment({
        commitmentId: "bad", goalRef: "g", toWhom: { id: "o" }, promise: "p",
        dueCondition: { kind: "k" } // missing subject/attribute -> validateConditionSpec rejects
    }));
    assert.equal(ge.commitmentsSize(), 3, "commitment valid tidak boleh dievict akibat create LAIN yang gagal validasi");
});

test("GL-repair-16: mutating the caller's successCondition.subject after proposeGoal cannot rewrite the stored condition (independent audit W7R8-P2-1)", async () => {
    const ge = await createGoalEngine({});
    const subject = { entityId: "e1" };
    const goal = ge.proposeGoal(baseGoalSpec({ successCondition: { kind: "WORLD_BELIEF", subject, attribute: "status", expectedValue: "done" } }));
    subject.entityId = "HACKED";
    const stored = ge.getGoal(goal.goalId);
    assert.equal(stored.successCondition.subject.entityId, "e1");
    assert.throws(() => { "use strict"; stored.successCondition.subject.entityId = "HACKED2"; });
});

test("GL-repair-17: a nested object inside successCondition.subject stays immutable, not just the top level (independent audit AUD9-P2-1)", async () => {
    const ge = await createGoalEngine({});
    const subject = { entityId: "e1", nested: { deep: "orig" } };
    const goal = ge.proposeGoal(baseGoalSpec({ successCondition: { kind: "WORLD_BELIEF", subject, attribute: "status", expectedValue: "done" } }));
    subject.nested.deep = "MUTATED";
    const stored = ge.getGoal(goal.goalId);
    assert.equal(stored.successCondition.subject.nested.deep, "orig");
    assert.throws(() => { "use strict"; stored.successCondition.subject.nested.deep = "MUTATED2"; });
});

test("GL-repair-18: a BigInt in successCondition.expectedValue is rejected, not accepted and left to crash persist() (independent audit AUD9-P2-3)", async () => {
    const ge = await createGoalEngine({});
    assert.throws(() => ge.proposeGoal(baseGoalSpec({
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", expectedValue: { big: 7n } }
    })));
});

test("GL-repair-19: a non-finite/invalid maxAttempts (NaN, string, 0) fails closed to the default, never disabling the retry cap (independent audit AUD9-P2-4)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({}));
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    for (const bad of [NaN, "abc", 0, -1]) {
        const t = ge.createTask({ planRef: p.planId, order: 1, intentTemplate: {}, maxAttempts: bad });
        assert.equal(t.maxAttempts, 5, `maxAttempts=${bad} must fall back to the default, not disable the cap`);
    }
});

test("GL-repair-20: successCondition.expectedValue is frozen, not just sanitized (independent audit AUD10-P1-1)", async () => {
    const ge = await createGoalEngine({});
    const goal = ge.proposeGoal(baseGoalSpec({
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", expectedValue: { nested: { deep: "orig" } } }
    }));
    const stored = ge.getGoal(goal.goalId);
    assert.equal(Object.isFrozen(stored.successCondition.expectedValue), true);
    assert.throws(() => { "use strict"; stored.successCondition.expectedValue.nested.deep = "MUTATED"; });
});

test("GL-repair-21: replaying an already-used goalId/commitmentId/taskId/planId is rejected, not resurrected to a fresh state (independent audit AUD10-P1-2)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({ goalId: "G-FIXED" }));
    ge.transition(g.goalId, "supersede", { actorKind: "OWNER", reason: "test" });
    assertThrowsReason(() => ge.proposeGoal(baseGoalSpec({ goalId: "G-FIXED" })), "DUPLICATE_RECORD_ID");
    assert.equal(ge.getGoal("G-FIXED").state, "SUPERSEDED", "replay attempt must not resurrect the terminal goal");

    const p = ge.createPlan({ planId: "P-FIXED", goalRef: g.goalId, steps: [] });
    assertThrowsReason(() => ge.createPlan({ planId: "P-FIXED", goalRef: g.goalId, steps: [] }), "DUPLICATE_RECORD_ID");

    ge.createTask({ taskId: "T-FIXED", planRef: p.planId, order: 1, intentTemplate: {}, maxAttempts: 1 });
    ge.transitionTask("T-FIXED", "ready");
    ge.transitionTask("T-FIXED", "formIntent");
    ge.transitionTask("T-FIXED", "awaitAuthority");
    ge.transitionTask("T-FIXED", "execute");
    ge.transitionTask("T-FIXED", "fail");
    ge.transitionTask("T-FIXED", "retry");
    assertThrowsReason(() => ge.transitionTask("T-FIXED", "execute"), "ATTEMPTS_EXCEEDED");
    assertThrowsReason(() => ge.createTask({ taskId: "T-FIXED", planRef: p.planId, order: 1, intentTemplate: {}, maxAttempts: 1 }), "DUPLICATE_RECORD_ID");
    assert.equal(ge.getTask("T-FIXED").attempts, 1, "replay must not reset the attempt counter");

    ge.createCommitment({ commitmentId: "C-FIXED", goalRef: g.goalId, toWhom: { id: "o" }, promise: "p", dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" } });
    const metCommitment = ge.transitionCommitment("C-FIXED", "met", {});
    assert.equal(metCommitment.state, "MET");
    assertThrowsReason(() => ge.createCommitment({ commitmentId: "C-FIXED", goalRef: g.goalId, toWhom: { id: "o" }, promise: "p", dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" } }), "DUPLICATE_RECORD_ID");
});

test("GL-repair-22: a BigInt anywhere in deadline/origin/toWhom/budgetRef/missionRef is rejected, not accepted and left to crash persist() (independent audit AUD10-P2-1)", async () => {
    const ge = await createGoalEngine({});
    assert.throws(() => ge.proposeGoal(baseGoalSpec({ deadline: 10n })));
    assert.throws(() => ge.proposeGoal(baseGoalSpec({ origin: { kind: "OWNER", ref: "owner-1", nested: 10n } })));
    const g = ge.proposeGoal(baseGoalSpec({}));
    assert.throws(() => ge.createCommitment({
        commitmentId: "C-BIG", goalRef: g.goalId, toWhom: { id: "o", nested: 10n }, promise: "p",
        dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" }
    }));
});

test("GL-repair-23: nested objects inside plan steps/assumptions stay immutable (independent audit AUD10-P2-2)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({}));
    const p = ge.createPlan({ goalRef: g.goalId, steps: [{ id: "s1", nested: { deep: "orig" } }], assumptions: [{ k: "a", nested: { deep: "orig" } }] });
    assert.equal(Object.isFrozen(p.steps[0]), true);
    assert.throws(() => { "use strict"; p.steps[0].nested.deep = "MUTATED"; });
    assert.throws(() => { "use strict"; p.assumptions[0].nested.deep = "MUTATED"; });
});

test("GL-repair-24: a BigInt anywhere else in a condition spec (not just subject/expectedValue) is rejected, and any extra field is frozen too (independent audit AUD11-P2-2)", async () => {
    const ge = await createGoalEngine({});
    assert.throws(() => ge.proposeGoal(baseGoalSpec({
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", metadata: { n: 10n } }
    })));
    const g = ge.proposeGoal(baseGoalSpec({
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", metadata: { deep: "orig" } }
    }));
    const stored = ge.getGoal(g.goalId).successCondition;
    assert.equal(Object.isFrozen(stored.metadata), true);
    assert.throws(() => { "use strict"; stored.metadata.deep = "MUTATED"; });
});

test("GL-repair-25: evicting a terminal child under retention pressure deletes its parent's childCounts key at zero, not just decrements it (independent audit AUD11-P2-5)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 2, MAX_CHILDREN_PER_GOAL: 100 } });
    const parent = ge.proposeGoal(baseGoalSpec({ goalId: "PARENT" })); // stays non-terminal
    ge.proposeGoal(baseGoalSpec({ goalId: "CHILD", parentGoalId: parent.goalId }));
    ge.transition("CHILD", "supersede", { actorKind: "OWNER", reason: "x" });
    assert.equal(ge.childCountsSize(), 1);
    ge.proposeGoal(baseGoalSpec({ goalId: "FILLER-1" })); // retention pressure evicts the terminal CHILD
    assert.equal(ge.getGoal("CHILD"), null, "CHILD must have been evicted for this test to be meaningful");
    assert.equal(ge.childCountsSize(), 0, "childCounts must not leak a stale zero-valued key once its last child is evicted");
});

test("GL-repair-26: a BigInt in plan.createdBy or task.{planRef,order,capabilityId} is rejected, not left to crash persist() (independent audit AUD12-P2-2)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({}));
    assert.throws(() => ge.createPlan({ goalRef: g.goalId, steps: [], createdBy: 10n }));
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    assert.throws(() => ge.createTask({ planRef: 10n, order: 0, intentTemplate: {} }));
    assert.throws(() => ge.createTask({ planRef: p.planId, order: 10n, intentTemplate: {} }));
    assert.throws(() => ge.createTask({ planRef: p.planId, order: 0, capabilityId: 10n, intentTemplate: {} }));
});

test("GL-repair-27: goal.deadline/budgetRef/missionRef are frozen (not just BigInt-sanitized), a toJSON on them cannot execute during persist() (independent audit AUD13-P1-1)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({ deadline: { at: "2026-01-01" }, budgetRef: { id: "b1" }, missionRef: { id: "m1" } }));
    assert.equal(Object.isFrozen(g.deadline), true);
    assert.equal(Object.isFrozen(g.budgetRef), true);
    assert.equal(Object.isFrozen(g.missionRef), true);
    assert.throws(() => { "use strict"; g.deadline.at = "MUTATED"; });
    assert.throws(() => { "use strict"; g.budgetRef.id = "MUTATED"; });
});

test("GL-repair-28: a BigInt in makePlan's goalRef/version or a step/assumption element is rejected, not left to crash persist() (independent audit AUD13-P2-2)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({}));
    assert.throws(() => ge.createPlan({ goalRef: 10n, steps: [] }));
    assert.throws(() => ge.createPlan({ goalRef: g.goalId, steps: [], version: 10n }));
    assert.throws(() => ge.createPlan({ goalRef: g.goalId, steps: [{ n: 10n }] }));
    assert.throws(() => ge.createPlan({ goalRef: g.goalId, steps: [], assumptions: [{ n: 10n }] }));
});

test("GL-repair-29: a BigInt in transition reason/evidenceRef, grantApproval's approvalRef/scope, or invalidatePlanIfAssumptionBroken's brokenBeliefRef is rejected (independent audit AUD13-P2-3)", async () => {
    const ge = await createGoalEngine({});
    const g = ge.proposeGoal(baseGoalSpec({}));
    assert.throws(() => ge.transition(g.goalId, "supersede", { actorKind: "OWNER", reason: 10n }));
    assert.throws(() => ge.grantApproval(g.goalId, { approvalRef: 10n }));
    const p = ge.createPlan({ goalRef: g.goalId, steps: [] });
    assert.throws(() => ge.invalidatePlanIfAssumptionBroken(p.planId, 10n));
    ge.createCommitment({ commitmentId: "C1", goalRef: g.goalId, toWhom: { id: "o" }, promise: "p", dueCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" } });
    assert.throws(() => ge.transitionCommitment("C1", "met", { evidenceRef: 10n }));
});

test("GL-repair-30: a shared-reference DAG (not a cycle) in a condition spec/expectedValue is rejected via a node budget, not expanded exponentially (independent audit AUD14-P1-1)", () => {
    function dag(d, f) {
        let n = { leaf: 1 };
        for (let i = 0; i < d; i++) { const o = {}; for (let k = 0; k < f; k++) o["k" + k] = n; n = o; }
        return n;
    }
    const { validateConditionSpec } = require("../../../src/cognition/goals/records");
    const t = Date.now();
    assert.throws(() => validateConditionSpec({ kind: "k", subject: { entityId: "e" }, attribute: "a", expectedValue: dag(16, 4) }, "successCondition"));
    assert.ok(Date.now() - t < 500, "shared-reference DAG must be rejected via a node budget, not expanded in full");
});

test("GL-repair-31: a rejected proposeGoal call must not evict an existing terminal goal or charge the creation-rate budget (independent audit AUD14-P1-2/AUD14-P2-3)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 1 } });
    const g = ge.proposeGoal(baseGoalSpec({ goalId: "G-KEEP" }));
    ge.transition("G-KEEP", "supersede", { actorKind: "OWNER", reason: "x" });
    const rateBefore = ge.creationTimestampsSize();
    assert.throws(() => ge.proposeGoal({ title: "t", kind: "OWNER_ASSIGNED", origin: { kind: "OWNER", ref: "o" }, successCondition: null }));
    assert.equal(ge.getGoal("G-KEEP").state, "SUPERSEDED", "a rejected proposal must not evict an existing terminal goal");
    assert.equal(ge.creationTimestampsSize(), rateBefore, "a rejected proposal must not charge the creation-rate budget");
});

test("GL-repair-32: a valid proposal rejected only by retention pressure (no terminal goal to evict) must not charge the creation-rate budget for its origin.kind (independent audit AUD15-P2-1)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 1 } });
    ge.proposeGoal(baseGoalSpec({ goalId: "G1", origin: { kind: "OWNER", ref: "owner-1" } })); // fills retention, stays non-terminal
    const before = ge.creationTimestampsSize();
    assert.throws(() => ge.proposeGoal({
        title: "t2", kind: "SELF_PROPOSED", origin: { kind: "SELF" },
        successCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" }
    }), /retensi/);
    assert.equal(ge.creationTimestampsSize(), before, "a retention-rejected (never-stored) proposal must not create/charge a new origin.kind rate key");
});

test("GL-repair-33: a rate-exceeded proposal must not evict a valid terminal goal (independent audit AUD16-P1-1)", async () => {
    const ge = await createGoalEngine({ bounds: { ...BOUNDS, MAX_TOTAL_GOALS_RETAINED: 2, MAX_GOAL_CREATION_RATE_PER_MINUTE: 2 } });
    ge.proposeGoal(baseGoalSpec({ goalId: "G1" }));
    ge.transition("G1", "supersede", { actorKind: "OWNER", reason: "r" });
    ge.proposeGoal(baseGoalSpec({ goalId: "G2" }));
    assertThrowsReason(() => ge.proposeGoal(baseGoalSpec({ goalId: "G3" })), "CREATION_RATE_EXCEEDED");
    assert.notEqual(ge.getGoal("G1"), null, "a rate-rejected proposal must not evict a valid terminal goal");
});

function jsonStore() {
    const kv = new Map();
    return {
        async getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        async putKv(k, v) { kv.set(k, JSON.stringify(v)); }
    };
}

test("GL-restart-freeze: a reloaded goal's ownerApproval cannot be forged after a JSON-round-tripping restart (independent audit W7R7-P1-1)", async () => {
    const store = jsonStore();
    const g1 = await createGoalEngine({ store });
    g1.proposeGoal({
        goalId: "SELF1", title: "t", kind: "SELF_PROPOSED", origin: { kind: "SELF", ref: "x" },
        successCondition: { kind: "k", subject: { entityId: "e" }, attribute: "a" }
    });
    g1.transition("SELF1", "approve", { actorKind: "OWNER", reason: "r" });
    await g1.persist();

    const g2 = await createGoalEngine({ store });
    const g = g2.getGoal("SELF1");
    assert.equal(Object.isFrozen(g), true);
    assert.equal(Object.isFrozen(g.ownerApproval), true);
    assert.throws(() => { "use strict"; g.ownerApproval = { state: "GRANTED" }; });
    assertThrowsReason(() => g2.transition("SELF1", "activate", { actorKind: "OWNER", reason: "r" }), "APPROVAL_REQUIRED");
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
