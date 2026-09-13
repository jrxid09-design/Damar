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
