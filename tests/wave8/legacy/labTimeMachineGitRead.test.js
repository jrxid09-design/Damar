"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { readGitCommit } = require("../../../src/lab/TimeMachine");
const census = require("../../../scripts/wave8-census.js");

const FAKE = "0123456789abcdef0123456789abcdef01234567";

function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(dir, ...args) {
    return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function commitEnvArgs() {
    return ["-c", "user.name=w8", "-c", "user.email=w8@local"];
}

test("lab: the snapshot commit is read from git metadata and agrees with git itself", () => {
    const dir = tmp("w8-lab-git-");
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");

        const expected = git(dir, "rev-parse", "HEAD");
        assert.match(expected, /^[0-9a-f]{40}$/);
        assert.equal(readGitCommit(dir), expected, "loose ref");

        git(dir, "pack-refs", "--all");
        assert.equal(readGitCommit(dir), expected, "packed ref");

        git(dir, "checkout", "-q", expected);
        assert.equal(readGitCommit(dir), expected, "detached HEAD");
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lab: a gitdir pointer file is followed and a plain folder yields null", () => {
    const outer = tmp("w8-lab-ptr-");
    try {
        const store = path.join(outer, "store");
        fs.mkdirSync(path.join(store, "refs", "heads"), { recursive: true });
        fs.writeFileSync(path.join(store, "HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(store, "refs", "heads", "main"), FAKE + "\n");

        const worktree = path.join(outer, "wt");
        fs.mkdirSync(worktree);
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, store)}\n`);
        assert.equal(readGitCommit(worktree), FAKE, "worktree/submodule pointer");

        const unborn = path.join(outer, "unborn");
        fs.mkdirSync(path.join(unborn, ".git"), { recursive: true });
        fs.writeFileSync(path.join(unborn, ".git", "HEAD"), "ref: refs/heads/main\n");
        assert.equal(readGitCommit(unborn), null, "unborn HEAD");

        const plain = path.join(outer, "plain");
        fs.mkdirSync(plain);
        assert.equal(readGitCommit(plain), null, "not a git folder");
    }
    finally {
        fs.rmSync(outer, { recursive: true, force: true });
    }
});

test("lab: a bare repository is read the way git reads it", () => {
    const dir = tmp("w8-lab-bare-");
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");

        const bare = path.join(dir, "mirror.git");
        git(dir, "clone", "-q", "--bare", dir, bare);
        const expected = git(bare, "rev-parse", "HEAD");
        assert.match(expected, /^[0-9a-f]{40}$/);
        assert.equal(readGitCommit(bare), expected, "bare repo, no .git of its own");
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lab: reading the commit leaves no process-execution surface behind", () => {
    // The migration claim the census rests on: this module no longer spawns
    // anything, so it cannot be a legacy shell route. Asked of the census
    // oracle itself rather than of a hand-rolled regex, so the assertion is
    // about the rule that actually gates the exit condition.
    const source = fs.readFileSync(path.join(__dirname, "../../../src/lab/TimeMachine.js"), "utf8");
    const rows = census.detectSinksDetailed(source, [], []).rows;
    assert.deepEqual(rows.map((r) => `${r.kind}@${r.line}`), [], "no sink rows");
});
