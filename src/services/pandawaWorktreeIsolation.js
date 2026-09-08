"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const STATES = Object.freeze(["CREATED", "ACTIVE", "PAUSED", "REVIEW", "VERIFIED", "FAILED", "ABANDONED", "MERGE_READY"]);
const MAX_WORKTREES = 32;
// F-02: creation-bound identity fields are IMMUTABLE. transition() accepts
// only stateful/lifecycle fields (allowlist, fail-closed on anything else).
const TRANSITION_ALLOWED = Object.freeze(["artifacts", "reviewStatus", "verificationStatus", "resultRefs", "notes"]);
function id() { return `pwt_${crypto.randomUUID().replaceAll("-", "")}`; }
function entity(value) { const identity = require("./pandawaIdentity"); return identity.assertPandawaId(value); }
function safePath(root, candidate) { const base = path.resolve(root); const full = path.resolve(candidate); if (full !== base && !full.startsWith(base + path.sep)) throw new Error("WORKTREE_PATH_ESCAPE"); return full; }
class PandawaWorktreeIsolation {
    constructor({ root, maxWorktrees = MAX_WORKTREES, git = null } = {}) { if (!root) throw new TypeError("WORKTREE_ROOT_REQUIRED"); this.root = path.resolve(root); this.maxWorktrees = maxWorktrees; this.git = git; this.records = new Map(); }
    create({ taskId, ownerEntity, baseCommit, worktreePath } = {}) { if (this.records.size >= this.maxWorktrees) throw new RangeError("WORKTREE_BOUND_EXCEEDED"); const p = safePath(this.root, worktreePath); if ([...this.records.values()].some(r => r.worktreePath === p)) throw new Error("WORKTREE_PATH_CONFLICT"); const record = Object.freeze({ worktreeId: id(), taskId: String(taskId || "").slice(0, 128), ownerEntity: entity(ownerEntity), worktreePath: p, baseCommit: String(baseCommit || "").slice(0, 128), state: "CREATED", artifacts: [], reviewStatus: "PENDING", verificationStatus: "PENDING", resultRefs: [], notes: null, authority: null }); this.records.set(record.worktreeId, record); return record; }
    get(worktreeId) { return this.records.get(worktreeId) ?? null; }
    transition(worktreeId, state, patch = {}) {
        if (!STATES.includes(state)) throw new TypeError("WORKTREE_STATE_INVALID");
        const prior = this.records.get(worktreeId); if (!prior) throw new Error("WORKTREE_NOT_FOUND");
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("WORKTREE_PATCH_INVALID");
        for (const key of Object.keys(patch)) {
            if (!TRANSITION_ALLOWED.includes(key)) throw new TypeError(`WORKTREE_IDENTITY_IMMUTABLE:${key}`);
        }
        const bounded = {};
        if (patch.artifacts !== undefined) { if (!Array.isArray(patch.artifacts) || patch.artifacts.length > 128 || !patch.artifacts.every(x => typeof x === "string" && x.length <= 256)) throw new TypeError("WORKTREE_ARTIFACTS_INVALID"); bounded.artifacts = Object.freeze([...patch.artifacts]); }
        if (patch.resultRefs !== undefined) { if (!Array.isArray(patch.resultRefs) || patch.resultRefs.length > 128 || !patch.resultRefs.every(x => typeof x === "string" && x.length <= 256)) throw new TypeError("WORKTREE_RESULT_REFS_INVALID"); bounded.resultRefs = Object.freeze([...patch.resultRefs]); }
        if (patch.reviewStatus !== undefined) { if (typeof patch.reviewStatus !== "string" || patch.reviewStatus.length > 32) throw new TypeError("WORKTREE_REVIEW_STATUS_INVALID"); bounded.reviewStatus = patch.reviewStatus; }
        if (patch.verificationStatus !== undefined) { if (typeof patch.verificationStatus !== "string" || patch.verificationStatus.length > 32) throw new TypeError("WORKTREE_VERIFICATION_STATUS_INVALID"); bounded.verificationStatus = patch.verificationStatus; }
        if (patch.notes !== undefined) { if (patch.notes !== null && (typeof patch.notes !== "string" || patch.notes.length > 2048)) throw new TypeError("WORKTREE_NOTES_INVALID"); bounded.notes = patch.notes; }
        // ownerEntity / worktreePath / baseCommit / taskId / worktreeId are
        // carried from `prior` only — spread of `patch` is never applied.
        const next = Object.freeze({ ...prior, ...bounded, state, authority: null });
        this.records.set(worktreeId, next); return next;
    }
    conflicts(paths = []) { const normalized = paths.map(p => safePath(this.root, p)); return normalized.filter(p => [...this.records.values()].some(r => r.worktreePath === p)); }
    async materialize(record) { if (!this.git?.createWorktree) return Object.freeze({ ok: false, reason: "GIT_PORT_UNAVAILABLE", worktreeId: record.worktreeId }); await this.git.createWorktree({ path: record.worktreePath, commit: record.baseCommit }); return this.transition(record.worktreeId, "ACTIVE"); }
}
module.exports = Object.freeze({ STATES, TRANSITION_ALLOWED, PandawaWorktreeIsolation, safePath });
