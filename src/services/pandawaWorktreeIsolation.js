"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const STATES = Object.freeze(["CREATED", "ACTIVE", "PAUSED", "REVIEW", "VERIFIED", "FAILED", "ABANDONED", "MERGE_READY"]);
const MAX_WORKTREES = 32;
function id() { return `pwt_${crypto.randomUUID().replaceAll("-", "")}`; }
function entity(value) { const identity = require("./pandawaIdentity"); return identity.assertPandawaId(value); }
function safePath(root, candidate) { const base = path.resolve(root); const full = path.resolve(candidate); if (full !== base && !full.startsWith(base + path.sep)) throw new Error("WORKTREE_PATH_ESCAPE"); return full; }
class PandawaWorktreeIsolation {
    constructor({ root, maxWorktrees = MAX_WORKTREES, git = null } = {}) { if (!root) throw new TypeError("WORKTREE_ROOT_REQUIRED"); this.root = path.resolve(root); this.maxWorktrees = maxWorktrees; this.git = git; this.records = new Map(); }
    create({ taskId, ownerEntity, baseCommit, worktreePath } = {}) { if (this.records.size >= this.maxWorktrees) throw new RangeError("WORKTREE_BOUND_EXCEEDED"); const p = safePath(this.root, worktreePath); if ([...this.records.values()].some(r => r.worktreePath === p)) throw new Error("WORKTREE_PATH_CONFLICT"); const record = Object.freeze({ worktreeId: id(), taskId: String(taskId || "").slice(0, 128), ownerEntity: entity(ownerEntity), worktreePath: p, baseCommit: String(baseCommit || "").slice(0, 128), state: "CREATED", artifacts: [], reviewStatus: "PENDING", verificationStatus: "PENDING", authority: null }); this.records.set(record.worktreeId, record); return record; }
    get(worktreeId) { return this.records.get(worktreeId) ?? null; }
    transition(worktreeId, state, patch = {}) { if (!STATES.includes(state)) throw new TypeError("WORKTREE_STATE_INVALID"); const prior = this.records.get(worktreeId); if (!prior) throw new Error("WORKTREE_NOT_FOUND"); const next = Object.freeze({ ...prior, ...patch, state, authority: null }); this.records.set(worktreeId, next); return next; }
    conflicts(paths = []) { const normalized = paths.map(p => safePath(this.root, p)); return normalized.filter(p => [...this.records.values()].some(r => r.worktreePath === p)); }
    async materialize(record) { if (!this.git?.createWorktree) return Object.freeze({ ok: false, reason: "GIT_PORT_UNAVAILABLE", worktreeId: record.worktreeId }); await this.git.createWorktree({ path: record.worktreePath, commit: record.baseCommit }); return this.transition(record.worktreeId, "ACTIVE"); }
}
module.exports = Object.freeze({ STATES, PandawaWorktreeIsolation, safePath });
