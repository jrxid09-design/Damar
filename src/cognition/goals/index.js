"use strict";

/**
 * W7-L3 GOALS, COMMITMENTS AND LONG-HORIZON PLANNING.
 *
 * ACC subdomain `src/cognition/goals/**`, replacing legacy
 * `src/autonomy/GoalEngine.js` (`W7_GOAL_COMMITMENT_SEMANTICS.md`).
 *
 * GOAL != AUTHORITY. This module never constructs an ActionIntent, never
 * calls Authority directly, never holds a grant — `ownerApproval.approvalRef`
 * is an opaque reference an injected `authorityPort` may check, nothing more.
 * `PLAN != EXECUTION`: `formIntent`/`awaitAuthority`/`execute` only move a
 * Task through its own state machine here; the actual intent object and its
 * evaluation belong to the existing Wave4 Action Intent / Authority owners.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { makeGoal, makeCommitment, makePlan, makeTask } = require("./records");
const { transitionGoal, transitionCommitment, transitionTask } = require("./lifecycle");
const { loadSnapshot, saveSnapshot } = require("./store");

async function createGoalEngine({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS, authorityPort = null } = {}) {

    const snapshot = await loadSnapshot(store);
    const goals = snapshot.goals;
    const commitments = snapshot.commitments;
    const plans = snapshot.plans;
    const tasks = snapshot.tasks;
    const childCounts = new Map();
    const creationTimestampsByOrigin = new Map();

    for (const g of goals.values()) {
        if (g.parentGoalId) childCounts.set(g.parentGoalId, (childCounts.get(g.parentGoalId) ?? 0) + 1);
    }

    // Restart rule (freeze criterion #3): no task resumes in EXECUTING.
    for (const [taskId, task] of tasks) {
        if (["EXECUTING", "AWAITING_AUTHORITY", "INTENT_FORMED"].includes(task.state)) {
            tasks.set(taskId, transitionTask(task, "resetAfterRestart"));
        }
    }

    function now() { return clock.nowMs(); }
    function nowIso() { return new Date(now()).toISOString(); }

    function activeGoalCount() {
        let n = 0;
        for (const g of goals.values()) if (g.state === "ACTIVE") n++;
        return n;
    }

    function enforceCreationRate(originKind) {
        const windowMs = 60_000;
        const list = (creationTimestampsByOrigin.get(originKind) ?? []).filter(t => now() - t < windowMs);
        if (list.length >= bounds.MAX_GOAL_CREATION_RATE_PER_MINUTE) {
            fail(REASONS.CREATION_RATE_EXCEEDED, `laju pembuatan goal untuk origin '${originKind}' melebihi batas`);
        }
        list.push(now());
        creationTimestampsByOrigin.set(originKind, list);
    }

    function proposeGoal(spec) {
        enforceCreationRate(spec.origin?.kind);

        // Bug diketemukan review independen (Codex, putaran ke-4): depth
        // lama dipercaya langsung dari pemanggil (`spec.depth`), jadi
        // pemanggil bisa memberi depth:0 pada setiap anak dan melewati
        // MAX_GOAL_DEPTH sepenuhnya. depth sekarang SELALU diturunkan dari
        // induk yang benar-benar tersimpan; nilai `spec.depth` diabaikan.
        let depth = 0;
        if (spec.parentGoalId) {
            const parent = goals.get(spec.parentGoalId);
            if (!parent) fail(REASONS.INVALID_RECORD, `parentGoalId '${spec.parentGoalId}' tidak ditemukan`);
            depth = parent.depth + 1;

            const siblingCount = childCounts.get(spec.parentGoalId) ?? 0;
            if (siblingCount >= bounds.MAX_CHILDREN_PER_GOAL) {
                fail(REASONS.CHILDREN_LIMIT_EXCEEDED, `induk '${spec.parentGoalId}' melebihi batas anak`);
            }
        }
        if (depth > bounds.MAX_GOAL_DEPTH) {
            fail(REASONS.GOAL_DEPTH_EXCEEDED, `depth melebihi batas (${bounds.MAX_GOAL_DEPTH})`);
        }

        const goal = makeGoal({ ...spec, depth, goalId: spec.goalId ?? crypto.randomUUID(), nowIso: nowIso() });
        goals.set(goal.goalId, goal);
        if (goal.parentGoalId) childCounts.set(goal.parentGoalId, (childCounts.get(goal.parentGoalId) ?? 0) + 1);

        if (goals.size > bounds.MAX_TOTAL_GOALS_RETAINED) {
            const terminal = [...goals.values()]
                .filter(g => ["SATISFIED", "ABANDONED", "SUPERSEDED"].includes(g.state))
                .sort((a, b) => Date.parse(a.lastTransitionAt) - Date.parse(b.lastTransitionAt));
            if (terminal[0]) goals.delete(terminal[0].goalId);
        }

        return goal;
    }

    /** GL-A2: `ownerApproval` hanya bisa dinaikkan lewat panggilan eksplisit ini, tidak lewat propose. */
    function grantApproval(goalId, { approvalRef, scope = null }) {
        const goal = goals.get(goalId);
        if (!goal) fail(REASONS.UNKNOWN_GOAL, `goal '${goalId}' tidak ditemukan`);
        const next = Object.freeze({
            ...goal,
            ownerApproval: Object.freeze({ state: "GRANTED", approvalRef, grantedAt: nowIso(), scope })
        });
        goals.set(goalId, next);
        return next;
    }

    function transition(goalId, action, meta) {
        const goal = goals.get(goalId);
        if (!goal) fail(REASONS.UNKNOWN_GOAL, `goal '${goalId}' tidak ditemukan`);

        if (action === "activate" && activeGoalCount() >= bounds.MAX_ACTIVE_GOALS) {
            fail(REASONS.ACTIVE_GOAL_LIMIT_EXCEEDED, "jumlah goal aktif melebihi batas");
        }

        // Standing-approval expiry gate (spec §7): authorityPort dipanggil
        // HANYA untuk memeriksa validitas referensi — tidak pernah mengonstruksi grant.
        if (action === "activate" && goal.ownerApproval.state === "GRANTED" && authorityPort) {
            const check = authorityPort.checkApproval(goal.ownerApproval.approvalRef);
            if (!check || !check.valid) {
                fail(REASONS.APPROVAL_EXPIRED, "standing approval sudah kedaluwarsa, aktivasi ditolak");
            }
        }

        const next = transitionGoal(goal, action, { ...meta, nowIso: nowIso() });
        goals.set(goalId, next);
        return next;
    }

    function createCommitment(spec) {
        let openCount = 0;
        for (const c of commitments.values()) if (c.state === "OPEN") openCount++;
        if (openCount >= bounds.MAX_OPEN_COMMITMENTS) {
            fail(REASONS.OPEN_COMMITMENT_LIMIT_EXCEEDED, "jumlah komitmen terbuka melebihi batas");
        }
        const c = makeCommitment({ ...spec, commitmentId: spec.commitmentId ?? crypto.randomUUID() });
        commitments.set(c.commitmentId, c);
        return c;
    }

    function transitionCommitmentAction(commitmentId, action, meta) {
        const c = commitments.get(commitmentId);
        if (!c) fail(REASONS.UNKNOWN_GOAL, `commitment '${commitmentId}' tidak ditemukan`);
        const next = transitionCommitment(c, action, meta);
        commitments.set(commitmentId, next);
        return next;
    }

    function createPlan(spec) {
        if ((spec.steps ?? []).length > bounds.MAX_STEPS_PER_PLAN) {
            fail(REASONS.PLAN_STEP_LIMIT_EXCEEDED, "jumlah langkah rencana melebihi batas");
        }
        const p = makePlan({ ...spec, planId: spec.planId ?? crypto.randomUUID() });
        plans.set(p.planId, p);

        // Bug diketemukan review independen (Codex): MAX_PLAN_VERSIONS_RETAINED
        // dideklarasikan tapi tidak pernah ditegakkan — plans per goal bisa
        // tumbuh tak terbatas lewat re-planning berulang. §8: kompaksi tertua.
        const sameGoal = [...plans.values()]
            .filter(x => x.goalRef === p.goalRef)
            .sort((a, b) => a.version - b.version);
        if (sameGoal.length > bounds.MAX_PLAN_VERSIONS_RETAINED) {
            const overflow = sameGoal.length - bounds.MAX_PLAN_VERSIONS_RETAINED;
            for (let i = 0; i < overflow; i++) plans.delete(sameGoal[i].planId);
        }
        return p;
    }

    /** P-1: assumption yang superseded/contested membatalkan rencana — dipanggil eksplisit oleh caller (pull, bukan subscription). */
    function invalidatePlanIfAssumptionBroken(planId, brokenBeliefRef) {
        const plan = plans.get(planId);
        if (!plan) fail(REASONS.UNKNOWN_GOAL, `plan '${planId}' tidak ditemukan`);
        const next = Object.freeze({
            ...plan, state: "INVALIDATED",
            invalidatedBy: Object.freeze([...plan.invalidatedBy, brokenBeliefRef])
        });
        plans.set(planId, next);
        return next;
    }

    function createTask(spec) {
        const t = makeTask({ ...spec, taskId: spec.taskId ?? crypto.randomUUID(), maxAttempts: Math.min(spec.maxAttempts ?? 5, bounds.MAX_ATTEMPTS_PER_TASK) });
        tasks.set(t.taskId, t);
        return t;
    }

    function transitionTaskAction(taskId, action) {
        const t = tasks.get(taskId);
        if (!t) fail(REASONS.UNKNOWN_TASK, `task '${taskId}' tidak ditemukan`);
        const next = transitionTask(t, action);
        tasks.set(taskId, next);
        return next;
    }

    function getGoal(goalId) { return goals.get(goalId) ?? null; }
    function getTask(taskId) { return tasks.get(taskId) ?? null; }
    function getPlan(planId) { return plans.get(planId) ?? null; }

    async function persist() { return saveSnapshot(store, { goals, commitments, plans, tasks }); }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        proposeGoal, grantApproval, transition, getGoal,
        createCommitment, transitionCommitment: transitionCommitmentAction,
        createPlan, invalidatePlanIfAssumptionBroken, getPlan,
        createTask, transitionTask: transitionTaskAction, getTask,
        persist, laws, bounds
    });
}

module.exports = { createGoalEngine, laws, BOUNDS };
