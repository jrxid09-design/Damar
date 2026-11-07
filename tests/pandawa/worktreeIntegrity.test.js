"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PandawaWorktreeIsolation, safePath } = require("../../src/services/pandawaWorktreeIsolation");

/**
 * F-02 tests: creation-bound identity is immutable through transition().
 * Forgery attempts fail closed; legitimate state transitions still work.
 */

function isolation() {
    return new PandawaWorktreeIsolation({ root: "C:/Workspace/isolated" });
}

test("F-02: transition cannot forge ownerEntity, worktreePath, or baseCommit", () => {
    const iso = isolation();
    const record = iso.create({ taskId: "task-1", ownerEntity: "Janaka", baseCommit: "aaa111", worktreePath: "C:/Workspace/isolated/task-1" });

    for (const forged of [
        { ownerEntity: "pandawa:werkudara" },
        { worktreePath: "C:/Workspace/isolated/hijacked" },
        { baseCommit: "fff999" },
        { taskId: "someone-elses-task" },
        { worktreeId: "pwt_forged" }
    ]) {
        assert.throws(
            () => iso.transition(record.worktreeId, "ACTIVE", forged),
            /WORKTREE_IDENTITY_IMMUTABLE/,
            `forged field ${Object.keys(forged)[0]} must be rejected`
        );
    }

    const current = iso.get(record.worktreeId);
    assert.equal(current.ownerEntity, "pandawa:janaka");
    assert.equal(current.worktreePath, require("node:path").resolve("C:/Workspace/isolated/task-1"));
    assert.equal(current.baseCommit, "aaa111");
    assert.equal(current.taskId, "task-1");
});

test("F-02: spread/prototype mutation tricks cannot rewrite identity", () => {
    const iso = isolation();
    const record = iso.create({ taskId: "task-2", ownerEntity: "Bima", baseCommit: "bbb222", worktreePath: "C:/Workspace/isolated/task-2" });

    // Spread of an existing record into a patch: identity keys are still rejected.
    assert.throws(() => iso.transition(record.worktreeId, "REVIEW", { ...record }), /WORKTREE_IDENTITY_IMMUTABLE/);
    // Nested/odd shapes are rejected as invalid patches, never merged.
    assert.throws(() => iso.transition(record.worktreeId, "REVIEW", null), /WORKTREE_PATCH_INVALID/);
    assert.throws(() => iso.transition(record.worktreeId, "REVIEW", ["ownerEntity"]), /WORKTREE_PATCH_INVALID/);
    assert.throws(() => iso.transition(record.worktreeId, "REVIEW", "ownerEntity"), /WORKTREE_PATCH_INVALID/);

    const current = iso.get(record.worktreeId);
    assert.equal(current.ownerEntity, "pandawa:werkudara");
    assert.equal(current.baseCommit, "bbb222");
});

test("F-02: legitimate stateful transition still succeeds", () => {
    const iso = isolation();
    const record = iso.create({ taskId: "task-3", ownerEntity: "Sadewa", baseCommit: "ccc333", worktreePath: "C:/Workspace/isolated/task-3" });
    const next = iso.transition(record.worktreeId, "REVIEW", {
        artifacts: ["diff:1"],
        reviewStatus: "APPROVED",
        verificationStatus: "PENDING",
        resultRefs: ["res:1"],
        notes: "awaiting verification"
    });
    assert.equal(next.state, "REVIEW");
    assert.equal(next.reviewStatus, "APPROVED");
    assert.deepEqual(next.resultRefs, ["res:1"]);
    assert.equal(next.authority, null);
    // Identity untouched by the legitimate transition.
    assert.equal(next.ownerEntity, "pandawa:sadewa");
    assert.equal(next.worktreePath, require("node:path").resolve("C:/Workspace/isolated/task-3"));
    assert.equal(next.baseCommit, "ccc333");
    // Bounded field values.
    assert.throws(() => iso.transition(record.worktreeId, "VERIFIED", { artifacts: Array(129).fill("x") }), /ARTIFACTS_INVALID/);
    assert.throws(() => iso.transition(record.worktreeId, "VERIFIED", { notes: "x".repeat(2049) }), /NOTES_INVALID/);
});
