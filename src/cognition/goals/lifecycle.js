"use strict";

/**
 * W7-L3 GOALS — mesin status (spec §4 persis) + transisi Commitment/Task.
 * G-7: setiap transisi Goal tercatat { at, from, to, reason, actorKind,
 * evidenceRef } — tidak ada transisi anonim. G-8: status terminal itu final.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

const ACTOR_KINDS = new Set(["OWNER", "SELF", "SYSTEM", "MISSION"]);
const TERMINAL_GOAL_STATES = new Set(["SATISFIED", "ABANDONED", "SUPERSEDED"]);

const GOAL_TRANSITIONS = Object.freeze({
    approve: { from: ["PROPOSED"], to: "ACCEPTED" },
    activate: { from: ["ACCEPTED"], to: "ACTIVE" },
    pause: { from: ["ACTIVE"], to: "PAUSED" },
    resume: { from: ["PAUSED"], to: "ACTIVE" },
    block: { from: ["ACTIVE"], to: "BLOCKED" },
    unblock: { from: ["BLOCKED"], to: "ACTIVE" },
    succeed: { from: ["ACTIVE"], to: "SATISFIED" },
    abandon: { from: ["ACTIVE", "BLOCKED", "PAUSED"], to: "ABANDONED" },
    supersede: { from: ["PROPOSED", "ACCEPTED", "ACTIVE", "PAUSED", "BLOCKED"], to: "SUPERSEDED" }
});

function appendTransitionLog(log, entry) {
    const next = [...log, entry];
    if (next.length <= BOUNDS.MAX_TRANSITION_LOG_PER_GOAL) return { log: next, truncated: false };
    // §4: "keep first and last, flag truncated".
    return { log: [next[0], ...next.slice(-(BOUNDS.MAX_TRANSITION_LOG_PER_GOAL - 1))], truncated: true };
}

/**
 * `evidence` diperlukan hanya untuk `succeed` (G-6: WAJIB T1) — parameter
 * lain (`actorKind`, `reason`, `evidenceRef`) wajib untuk SEMUA transisi (G-7).
 */
function transitionGoal(goal, action, { actorKind, reason, evidenceRef = null, evidenceTier = null, nowIso }) {
    // Bug review independen (audit putaran-25, AUD25-P2-1): `action`
    // mentah dipakai sebagai kunci properti (`GOAL_TRANSITIONS[action]`)
    // DAN diinterpolasi ke pesan error -- objek hostile dengan
    // toString/Symbol.toPrimitive tereksekusi di KEDUA jalur (ToPropertyKey
    // saat indexing, lalu lagi di template literal), dan Symbol murni
    // meledakkan TypeError mentah di interpolasi sebelum fail() sempat
    // menolaknya dengan domain error. Dinormalisasi ke kunci aman sekali,
    // dipakai untuk indexing MAUPUN pesan.
    const actionKey = typeof action === "string" ? action : "";
    if (!ACTOR_KINDS.has(actorKind)) {
        fail(REASONS.INVALID_TRANSITION, `actorKind '${typeof actorKind === "string" ? actorKind : typeof actorKind}' tidak dikenal`);
    }
    // Bug review independen (audit putaran-13, AUD13-P2-3): reason/
    // evidenceRef diteruskan mentah ke entry log transisi -- BigInt di
    // salah satunya meledakkan JSON.stringify saat persist(), dan ikut
    // merusak catatan log transisi G-7 yang seharusnya bisa diaudit.
    if (typeof reason !== "string" || !reason) fail(REASONS.INVALID_TRANSITION, "reason wajib string (G-7)");
    if (evidenceRef !== null && (typeof evidenceRef !== "string" || !evidenceRef)) {
        fail(REASONS.INVALID_TRANSITION, "evidenceRef, jika ada, wajib string");
    }
    if (TERMINAL_GOAL_STATES.has(goal.state)) {
        fail(REASONS.INVALID_TRANSITION, `status terminal '${goal.state}' bersifat final (G-8)`);
    }
    const rule = GOAL_TRANSITIONS[actionKey];
    if (!rule) fail(REASONS.INVALID_TRANSITION, `aksi '${actionKey}' tidak dikenal`);
    if (!rule.from.includes(goal.state)) {
        fail(REASONS.INVALID_TRANSITION, `tidak bisa '${actionKey}' dari status '${goal.state}'`);
    }

    if (actionKey === "succeed" && evidenceTier !== "T1") {
        // G-6: T2 (hasil eksekusi) tidak cukup untuk SATISFIED.
        fail(REASONS.SATISFACTION_REQUIRES_T1, "SATISFIED wajib bukti T1, T2 tidak cukup");
    }
    if (actionKey === "activate" && goal.ownerApproval.state === "REQUIRED") {
        fail(REASONS.APPROVAL_REQUIRED, "goal belum disetujui pemilik");
    }

    const entry = Object.freeze({ at: nowIso, from: goal.state, to: rule.to, reason, actorKind, evidenceRef });
    const { log, truncated } = appendTransitionLog(goal.transitions, entry);

    return Object.freeze({
        ...goal, state: rule.to, lastTransitionAt: nowIso,
        transitions: Object.freeze(log), transitionsTruncated: truncated
    });
}

const COMMITMENT_TRANSITIONS = Object.freeze({
    met: { from: ["OPEN"], to: "MET" },
    miss: { from: ["OPEN"], to: "MISSED" },
    release: { from: ["OPEN"], to: "RELEASED" },
    renegotiate: { from: ["OPEN", "MISSED"], to: "RENEGOTIATED" }
});

function transitionCommitment(commitment, action, { evidenceRef = null } = {}) {
    // Bug review independen (audit putaran-25, AUD25-P2-1): sama seperti
    // transitionGoal -- `action` mentah dipakai sebagai kunci properti
    // DAN diinterpolasi.
    const actionKey = typeof action === "string" ? action : "";
    const rule = COMMITMENT_TRANSITIONS[actionKey];
    if (!rule) fail(REASONS.INVALID_TRANSITION, `aksi commitment '${actionKey}' tidak dikenal`);
    if (!rule.from.includes(commitment.state)) {
        fail(REASONS.INVALID_TRANSITION, `tidak bisa '${actionKey}' dari status '${commitment.state}'`);
    }
    // Bug review independen (audit putaran-13, AUD13-P2-3): evidenceRef
    // diteruskan mentah -- BigInt meledakkan JSON.stringify saat persist().
    if (evidenceRef !== null && (typeof evidenceRef !== "string" || !evidenceRef)) {
        fail(REASONS.INVALID_TRANSITION, "evidenceRef, jika ada, wajib string");
    }
    return Object.freeze({ ...commitment, state: rule.to, evidenceRef: evidenceRef ?? commitment.evidenceRef });
}

const TASK_TRANSITIONS = Object.freeze({
    ready: { from: ["PENDING"], to: "READY" },
    formIntent: { from: ["READY"], to: "INTENT_FORMED" },
    awaitAuthority: { from: ["INTENT_FORMED"], to: "AWAITING_AUTHORITY" },
    execute: { from: ["AWAITING_AUTHORITY"], to: "EXECUTING" },
    verify: { from: ["EXECUTING"], to: "VERIFYING" },
    done: { from: ["VERIFYING"], to: "DONE" },
    fail: { from: ["EXECUTING", "VERIFYING", "AWAITING_AUTHORITY", "READY", "INTENT_FORMED"], to: "FAILED" },
    skip: { from: ["PENDING", "READY"], to: "SKIPPED" },
    // P-3: percobaan ulang membentuk intent BARU dan dievaluasi ulang oleh
    // Authority — bukan melanjutkan eksekusi lama.
    retry: { from: ["FAILED"], to: "AWAITING_AUTHORITY" },
    // Restart: EXECUTING tidak pernah dilanjutkan — kembali ke PENDING (freeze criterion #3).
    resetAfterRestart: { from: ["EXECUTING", "AWAITING_AUTHORITY", "INTENT_FORMED"], to: "PENDING" }
});

function transitionTask(task, action) {
    // Bug review independen (audit putaran-25, AUD25-P2-1): sama seperti
    // transitionGoal/transitionCommitment.
    const actionKey = typeof action === "string" ? action : "";
    const rule = TASK_TRANSITIONS[actionKey];
    if (!rule) fail(REASONS.INVALID_TRANSITION, `aksi task '${actionKey}' tidak dikenal`);
    if (!rule.from.includes(task.state)) {
        fail(REASONS.INVALID_TRANSITION, `tidak bisa '${actionKey}' dari status '${task.state}'`);
    }
    let attempts = task.attempts;
    if (actionKey === "execute") {
        attempts += 1;
        if (attempts > task.maxAttempts) {
            fail(REASONS.ATTEMPTS_EXCEEDED, `melebihi maxAttempts (${task.maxAttempts})`);
        }
    }
    return Object.freeze({ ...task, state: rule.to, attempts });
}

module.exports = {
    ACTOR_KINDS, TERMINAL_GOAL_STATES, GOAL_TRANSITIONS, COMMITMENT_TRANSITIONS, TASK_TRANSITIONS,
    transitionGoal, transitionCommitment, transitionTask
};
