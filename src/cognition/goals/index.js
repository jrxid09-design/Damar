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
        // Bug review independen (audit putaran-10, AUD10-P1-2): goalId
        // pemanggil (spec.goalId) dulu langsung di-set tanpa cek tabrakan --
        // pengiriman ulang goalId yang sudah ada (replay lintas-node)
        // menimpa goal terminal (ABANDONED/SATISFIED/SUPERSEDED) kembali ke
        // PROPOSED, melewati G-8 (finalitas state terminal).
        if (spec.goalId && goals.has(spec.goalId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `goalId '${spec.goalId}' sudah ada`);
        }

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

        // Bug review independen (audit putaran-14, AUD14-P1-2/AUD14-P2-3):
        // enforceCreationRate (efek samping, menaikkan kuota) dan kompaksi
        // retensi (efek samping, MENGHAPUS goal valid lain) dulu berjalan
        // SEBELUM makeGoal memvalidasi spec -- proposal yang ditolak (mis.
        // successCondition cacat) tetap menagih kuota origin.kind DAN
        // mengevict satu goal terminal yang VALID sebelum error dilempar,
        // kehilangan data permanen. makeGoal (satu-satunya tempat spec
        // benar-benar divalidasi) sekarang dipanggil DULU; efek samping
        // hanya terjadi setelah record yang akan disimpan terbukti valid.
        const goal = makeGoal({ ...spec, depth, goalId: spec.goalId ?? crypto.randomUUID(), nowIso: nowIso() });

        // Bug review independen (Codex putaran-6): cek retensi lama berjalan
        // SETELAH goal baru sudah dimasukkan, dan hanya mengevict kalau ada
        // goal terminal -- kalau semua goal yang tersimpan masih non-terminal,
        // proposal baru tetap diterima tanpa batas, melampaui
        // MAX_TOTAL_GOALS_RETAINED selamanya. Sekarang cek berjalan SEBELUM
        // insersi dan gagal tertutup kalau tidak ada goal terminal untuk dievict.
        // Bug review independen (audit putaran-16, AUD16-P1-1): perbaikan
        // putaran-15 memindahkan enforceCreationRate ke SETELAH blok retensi
        // ini, tapi blok ini sendiri MENGHAPUS goal terminal yang valid
        // SEBELUM enforceCreationRate sempat menolak panggilan karena
        // CREATION_RATE_EXCEEDED -- proposal yang ditolak rate limit tetap
        // mengevict goal valid secara permanen. Korban sekarang hanya
        // DIPILIH (tanpa dihapus) di sini; penghapusan+pembersihan
        // sesungguhnya dipindah ke SETELAH enforceCreationRate lolos.
        let evicted = null;
        if (goals.size >= bounds.MAX_TOTAL_GOALS_RETAINED) {
            const terminal = [...goals.values()]
                .filter(g => ["SATISFIED", "ABANDONED", "SUPERSEDED"].includes(g.state))
                .sort((a, b) => Date.parse(a.lastTransitionAt) - Date.parse(b.lastTransitionAt));
            if (terminal[0]) {
                evicted = terminal[0];
            } else {
                fail(REASONS.GOAL_RETENTION_LIMIT_EXCEEDED,
                    `retensi goal melebihi batas (${bounds.MAX_TOTAL_GOALS_RETAINED}) dan tidak ada goal terminal untuk dievict`);
            }
        }

        enforceCreationRate(spec.origin.kind);

        if (evicted) {
            goals.delete(evicted.goalId);
            // Bug review independen (Codex putaran-8): saat retensi
            // mengevict anak terminal, entri induknya di childCounts
            // dibiarkan -- dengan MAX_CHILDREN_PER_GOAL kecil, proposal
            // anak baru di bawah induk itu ditolak "penuh" padahal anak
            // yang tersisa sudah tidak ada lagi.
            // Bug review independen (audit putaran-11, AUD11-P2-5): nilai
            // hanya diturunkan ke 0, kuncinya sendiri tidak pernah
            // dihapus -- pola yang sama yang sudah diperbaiki di
            // worldmodel's decrementSourceCount (W7R4-P2-3) dan
            // prospective's releaseArmedCapacity, tapi tidak pernah
            // dimigrasikan ke goals' childCounts. Growth tak terbatas
            // sebanding dengan churn goal jangka panjang.
            if (evicted.parentGoalId) {
                const nextCount = Math.max(0, (childCounts.get(evicted.parentGoalId) ?? 1) - 1);
                if (nextCount === 0) childCounts.delete(evicted.parentGoalId);
                else childCounts.set(evicted.parentGoalId, nextCount);
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
        }

        goals.set(goal.goalId, goal);
        if (goal.parentGoalId) childCounts.set(goal.parentGoalId, (childCounts.get(goal.parentGoalId) ?? 0) + 1);

        return goal;
    }

    /** GL-A2: `ownerApproval` hanya bisa dinaikkan lewat panggilan eksplisit ini, tidak lewat propose. */
    function grantApproval(goalId, { approvalRef, scope = null }) {
        const goal = goals.get(goalId);
        if (!goal) fail(REASONS.UNKNOWN_GOAL, `goal '${goalId}' tidak ditemukan`);
        // Bug review independen (audit putaran-13, AUD13-P2-3): approvalRef/
        // scope diteruskan mentah -- BigInt meledakkan JSON.stringify saat
        // persist(). approvalRef tetap opaque (bukan grant), hanya wajib
        // berupa referensi string yang bisa diserialisasi.
        if (typeof approvalRef !== "string" || !approvalRef) fail(REASONS.INVALID_RECORD, "approvalRef wajib string");
        if (scope !== null && (typeof scope !== "string" || !scope)) fail(REASONS.INVALID_RECORD, "scope, jika ada, wajib string");
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
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // commitmentId yang sudah ada (mis. sudah MET) menimpanya kembali ke
        // OPEN, melewati finalitas state terminal.
        if (spec.commitmentId && commitments.has(spec.commitmentId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `commitmentId '${spec.commitmentId}' sudah ada`);
        }
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
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // planId yang sudah ada menimpanya kembali ke state DRAFT, membuang
        // invalidatedBy yang sudah tercatat.
        if (spec.planId && plans.has(spec.planId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `planId '${spec.planId}' sudah ada`);
        }
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
        // Bug review independen (audit putaran-13, AUD13-P2-3): brokenBeliefRef
        // diteruskan mentah ke invalidatedBy -- BigInt meledakkan
        // JSON.stringify saat persist().
        if (typeof brokenBeliefRef !== "string" || !brokenBeliefRef) {
            fail(REASONS.INVALID_RECORD, "brokenBeliefRef wajib string");
        }
        const next = Object.freeze({
            ...plan, state: "INVALIDATED",
            invalidatedBy: Object.freeze([...plan.invalidatedBy, brokenBeliefRef])
        });
        plans.set(planId, next);
        return next;
    }

    function createTask(spec) {
        // Bug review independen (audit putaran-10, AUD10-P1-2): replay dari
        // taskId yang sudah ada mengganti task (termasuk yang sudah
        // ATTEMPTS_EXCEEDED/DONE) dengan attempts:0/state:PENDING baru,
        // melewati batas percobaan dan finalitas state terminal.
        if (spec.taskId && tasks.has(spec.taskId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `taskId '${spec.taskId}' sudah ada`);
        }
        // Bug review independen (audit putaran-6, W7R6-P2-2): validasi/bangun
        // record DULU (sama seperti createCommitment), baru kompaksi+simpan.
        // Bug review independen (audit putaran-9, AUD9-P2-4): `Math.min(spec.
        // maxAttempts ?? 5, MAX)` tidak menyaring NaN/string -- `??` hanya
        // menangkap null/undefined, jadi maxAttempts: NaN atau "abc" lolos ke
        // Math.min dan menghasilkan NaN. `attempts > NaN` selalu false, jadi
        // ATTEMPTS_EXCEEDED tidak pernah tercapai (retry tanpa batas).
        const safeMaxAttempts = Number.isInteger(spec.maxAttempts) && spec.maxAttempts > 0
            ? Math.min(spec.maxAttempts, bounds.MAX_ATTEMPTS_PER_TASK)
            : 5;
        const t = makeTask({ ...spec, taskId: spec.taskId ?? crypto.randomUUID(), maxAttempts: safeMaxAttempts });
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
