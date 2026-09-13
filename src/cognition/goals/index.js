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
const { makeGoal, makeCommitment, makePlan, makeTask, ORIGIN_KINDS } = require("./records");
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
        // Bug review independen (audit putaran-4, W7R4-P2-3): enforceCreationRate
        // dulu berjalan SEBELUM makeGoal memvalidasi origin.kind -- setiap
        // origin.kind sampah (string acak pemanggil) tetap membuat kunci baru
        // di creationTimestampsByOrigin sebelum proposal ditolak, dan kunci
        // itu tidak pernah dihapus. Divalidasi dulu di sini.
        if (!spec.origin || !ORIGIN_KINDS.has(spec.origin.kind)) {
            fail(REASONS.INVALID_RECORD, "origin.kind tidak dikenal");
        }
        enforceCreationRate(spec.origin.kind);

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

        // Bug review independen (Codex putaran-6): cek retensi lama berjalan
        // SETELAH goal baru sudah dimasukkan, dan hanya mengevict kalau ada
        // goal terminal -- kalau semua goal yang tersimpan masih non-terminal,
        // proposal baru tetap diterima tanpa batas, melampaui
        // MAX_TOTAL_GOALS_RETAINED selamanya. Sekarang cek berjalan SEBELUM
        // insersi dan gagal tertutup kalau tidak ada goal terminal untuk dievict.
        if (goals.size >= bounds.MAX_TOTAL_GOALS_RETAINED) {
            const terminal = [...goals.values()]
                .filter(g => ["SATISFIED", "ABANDONED", "SUPERSEDED"].includes(g.state))
                .sort((a, b) => Date.parse(a.lastTransitionAt) - Date.parse(b.lastTransitionAt));
            if (terminal[0]) {
                const evicted = terminal[0];
                goals.delete(evicted.goalId);
                // Bug review independen (Codex putaran-8): saat retensi
                // mengevict anak terminal, entri induknya di childCounts
                // dibiarkan -- dengan MAX_CHILDREN_PER_GOAL kecil, proposal
                // anak baru di bawah induk itu ditolak "penuh" padahal anak
                // yang tersisa sudah tidak ada lagi.
                if (evicted.parentGoalId) {
                    childCounts.set(evicted.parentGoalId, Math.max(0, (childCounts.get(evicted.parentGoalId) ?? 1) - 1));
                }
                // Bug review independen (audit putaran-3, AUD3-P2-2): entri
                // MILIK goal yang dievict sendiri di childCounts (dipakai
                // sebagai induk untuk anak-anaknya) tidak pernah dihapus --
                // hanya nilainya yang berubah lewat proposeGoal berikutnya
                // (childCounts.get(evicted.goalId) ?? 0) + 1, jadi kunci UUID
                // basi menumpuk selamanya walau goal-nya sudah tidak ada.
                childCounts.delete(evicted.goalId);
                // Bug review independen (audit putaran-5, W7R5-P2-3): plan
                // milik goal yang dievict ditinggalkan -- MAX_PLAN_VERSIONS_RETAINED
                // hanya membatasi PER goal, jadi churn goal jangka panjang
                // menumpuk plan tak terbatas secara total.
                for (const p of [...plans.values()]) {
                    if (p.goalRef === evicted.goalId) plans.delete(p.planId);
                }
            } else {
                fail(REASONS.GOAL_RETENTION_LIMIT_EXCEEDED,
                    `retensi goal melebihi batas (${bounds.MAX_TOTAL_GOALS_RETAINED}) dan tidak ada goal terminal untuk dievict`);
            }
        }

        const goal = makeGoal({ ...spec, depth, goalId: spec.goalId ?? crypto.randomUUID(), nowIso: nowIso() });
        goals.set(goal.goalId, goal);
        if (goal.parentGoalId) childCounts.set(goal.parentGoalId, (childCounts.get(goal.parentGoalId) ?? 0) + 1);

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
        // Bug review independen (audit putaran-6, W7R6-P2-2): kompaksi dulu
        // berjalan SEBELUM makeCommitment memvalidasi spec -- spec yang
        // ditolak (mis. dueCondition cacat) tetap menghapus satu komitmen
        // terminal yang VALID sebelum error dilempar. Validasi/bangun record
        // dulu, baru kompaksi+simpan.
        const c = makeCommitment({ ...spec, commitmentId: spec.commitmentId ?? crypto.randomUUID() });
        // Bug review independen (audit putaran-5, W7R5-P2-3, dieskalasi dari
        // advisory putaran-4): MAX_OPEN_COMMITMENTS hanya membatasi yang OPEN
        // -- komitmen terminal (MET/MISSED/RELEASED/RENEGOTIATED) menumpuk
        // selamanya, tak terbatas. Kompaksi tertua saat retensi total penuh,
        // pola yang sama dengan goals sendiri (MAX_TOTAL_GOALS_RETAINED).
        // Selalu menemukan korban di sini karena OPEN dibatasi independen
        // jauh di bawah MAX_TOTAL_COMMITMENTS_RETAINED (lihat cek di atas).
        if (commitments.size >= bounds.MAX_TOTAL_COMMITMENTS_RETAINED) {
            const terminal = [...commitments.values()].filter(x => x.state !== "OPEN")[0];
            if (terminal) commitments.delete(terminal.commitmentId);
        }
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
        // Bug review independen (audit putaran-7, W7R7-P2-1): versi lama
        // memasukkan plan yang BARU DIBUAT (p) sendiri ke kumpulan kandidat
        // korban -- jika versinya kebetulan paling kecil (mis. dibuat di luar
        // urutan: v3,v2,v1, lalu v0), createPlan() mengembalikan record yang
        // barusan dihapusnya sendiri. p sekarang SELALU dikecualikan dari
        // kandidat korban di kedua kompaksi (per-goal dan global).
        const otherSameGoal = [...plans.values()]
            .filter(x => x.goalRef === p.goalRef && x.planId !== p.planId)
            .sort((a, b) => a.version - b.version);
        const totalForGoal = otherSameGoal.length + 1; // +1 untuk p sendiri
        if (totalForGoal > bounds.MAX_PLAN_VERSIONS_RETAINED) {
            const overflow = totalForGoal - bounds.MAX_PLAN_VERSIONS_RETAINED;
            for (let i = 0; i < overflow; i++) plans.delete(otherSameGoal[i].planId);
        }
        // Bug review independen (audit putaran-6, W7R6-P2-1): MAX_PLAN_VERSIONS_RETAINED
        // hanya membatasi PER goalRef -- createPlan tidak pernah memvalidasi
        // goalRef benar-benar ada, jadi banyak goalRef berbeda (termasuk yang
        // palsu/tidak ada) bisa menumpuk plan tanpa batas TOTAL. Kompaksi
        // global tertua (lintas semua goalRef) saat retensi total penuh --
        // selalu ada korban karena tidak ada kelas plan yang "dilindungi"
        // (selain p sendiri, yang dikecualikan di sini juga).
        if (plans.size > bounds.MAX_TOTAL_PLANS_RETAINED) {
            for (const k of plans.keys()) {
                if (k !== p.planId) { plans.delete(k); break; }
            }
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
        // Bug review independen (audit putaran-6, W7R6-P2-2): validasi/bangun
        // record DULU (sama seperti createCommitment), baru kompaksi+simpan.
        const t = makeTask({ ...spec, taskId: spec.taskId ?? crypto.randomUUID(), maxAttempts: Math.min(spec.maxAttempts ?? 5, bounds.MAX_ATTEMPTS_PER_TASK) });
        // Bug review independen (audit putaran-5, W7R5-P2-3): tasks tidak
        // punya batas total sama sekali. Kompaksi task terminal (DONE/SKIPPED)
        // tertua saat retensi penuh; task FAILED/lainnya dipertahankan karena
        // masih bisa "retry". Bug review independen (audit putaran-6,
        // W7R6-P1-1): TIDAK SEPERTI commitments, tasks tidak punya batas
        // independen pada kelas yang tidak bisa dievict (PENDING/READY/
        // EXECUTING/VERIFYING/FAILED) -- populasi murni non-terminal bisa
        // tumbuh tak terbatas karena tidak pernah ada korban DONE/SKIPPED.
        // Gagal tertutup di sini, sama seperti proposeGoal's retention check.
        if (tasks.size >= bounds.MAX_TOTAL_TASKS_RETAINED) {
            const terminal = [...tasks.values()].filter(x => x.state === "DONE" || x.state === "SKIPPED")[0];
            if (terminal) {
                tasks.delete(terminal.taskId);
            } else {
                fail(REASONS.TASK_RETENTION_LIMIT_EXCEEDED,
                    `retensi task melebihi batas (${bounds.MAX_TOTAL_TASKS_RETAINED}) dan tidak ada task DONE/SKIPPED untuk dievict`);
            }
        }
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
    function childCountsSize() { return childCounts.size; }
    function creationTimestampsSize() { return creationTimestampsByOrigin.size; }
    function commitmentsSize() { return commitments.size; }
    function tasksSize() { return tasks.size; }
    function plansSize() { return plans.size; }

    async function persist() { return saveSnapshot(store, { goals, commitments, plans, tasks }); }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        proposeGoal, grantApproval, transition, getGoal,
        createCommitment, transitionCommitment: transitionCommitmentAction,
        createPlan, invalidatePlanIfAssumptionBroken, getPlan,
        createTask, transitionTask: transitionTaskAction, getTask,
        childCountsSize, creationTimestampsSize, commitmentsSize, tasksSize, plansSize,
        persist, laws, bounds
    });
}

module.exports = { createGoalEngine, laws, BOUNDS };
