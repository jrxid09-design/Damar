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

        const loose = path.join(store, "refs", "heads", "main");
        fs.writeFileSync(loose, "GARBAGE\n");
        assert.equal(readGitCommit(worktree), null, "corrupt loose ref, as git failing would");

        fs.writeFileSync(loose, FAKE + "a\n");
        assert.equal(readGitCommit(worktree), null, "41 hex digits is not an object name");

        fs.writeFileSync(path.join(store, "HEAD"), FAKE + "a\n");
        assert.equal(readGitCommit(worktree), null, "41-hex detached HEAD");

        fs.writeFileSync(path.join(store, "HEAD"), "ref: refs/heads/main\n");
        fs.rmSync(loose);
        fs.writeFileSync(path.join(store, "packed-refs"),
            `# pack-refs with: peeled fully-peeled sorted\n${FAKE} refs/heads/main\n`);
        assert.equal(readGitCommit(worktree), FAKE, "packed ref in the same git dir");

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

test("lab: a linked worktree resolves its ref through the common git dir", () => {
    // `git worktree add` keeps HEAD in the per-worktree dir but the ref itself in
    // the common dir named by `commondir`. A hand-built pointer fixture does not
    // reproduce that layout, so this one uses git to build it.
    const dir = tmp("w8-lab-wt-");
    const wt = `${dir}-linked`;
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");

        git(dir, "worktree", "add", "-q", "-b", "wtbranch", wt);
        const expected = git(wt, "rev-parse", "HEAD");
        assert.match(expected, /^[0-9a-f]{40}$/);
        assert.equal(readGitCommit(wt), expected, "linked worktree, loose ref in the common dir");

        git(dir, "pack-refs", "--all");
        assert.equal(readGitCommit(wt), expected, "linked worktree, packed ref in the common dir");

        git(dir, "worktree", "remove", "--force", wt);
    }
    finally {
        fs.rmSync(wt, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lab: a stray loose ref in the private worktree dir cannot win over the common ref", () => {
    // git never resolves refs/heads/* inside the per-worktree private dir, and it
    // creates that directory on every `worktree add`. A leftover file in it must
    // not become a confidently wrong commit label.
    const dir = tmp("w8-lab-stray-");
    const wt = `${dir}-linked`;
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");

        git(dir, "worktree", "add", "-q", "-b", "wtbranch", wt);
        const expected = git(wt, "rev-parse", "HEAD");
        const branch = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
        git(dir, "pack-refs", "--all");

        const privateDir = path.join(dir, ".git", "worktrees", fs.readdirSync(path.join(dir, ".git", "worktrees"))[0]);
        const stray = path.join(privateDir, "refs", "heads", branch);
        fs.mkdirSync(path.dirname(stray), { recursive: true });
        fs.writeFileSync(stray, FAKE + "\n");

        assert.equal(git(wt, "rev-parse", "HEAD"), expected, "git ignores the stray file");
        assert.equal(readGitCommit(wt), expected, "so must the read");
        git(dir, "worktree", "remove", "--force", wt);
    }
    finally {
        fs.rmSync(wt, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lab: a worktree-private ref is read the way git reads it, and a private packed-refs is ignored", () => {
    // Diukur dengan git 2.55: pada linked worktree, ref privat
    // (refs/bisect|worktree|rewritten/*) hanya dibaca longgar di direktori
    // privat worktree itu; yang hanya ada di common dir TIDAK diselesaikan git.
    // `git pack-refs --all` juga tidak pernah memindahkan ref privat ke
    // packed-refs, jadi berkas packed-refs di direktori privat tidak boleh
    // dipercaya — sementara di repo biasa (git dir == common dir) git
    // menghormati entri packed untuk ref privat.
    const dir = tmp("w8-lab-privateref-");
    const wt = `${dir}-linked`;
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");
        const first = git(dir, "rev-parse", "HEAD");

        git(dir, "worktree", "add", "-q", "-b", "wtbranch", wt);
        fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
        git(wt, "add", "b.txt");
        git(wt, ...commitEnvArgs(), "commit", "-q", "-m", "second");
        const second = git(wt, "rev-parse", "HEAD");
        assert.notEqual(first, second);

        const privateDir = path.join(
            dir, ".git", "worktrees", fs.readdirSync(path.join(dir, ".git", "worktrees"))[0]
        );
        const privateLoose = path.join(privateDir, "refs", "bisect", "bad");
        fs.mkdirSync(path.dirname(privateLoose), { recursive: true });
        fs.writeFileSync(privateLoose, `${second}\n`);
        git(wt, "symbolic-ref", "HEAD", "refs/bisect/bad");

        assert.equal(git(wt, "rev-parse", "HEAD"), second, "git reads the private loose ref");
        assert.equal(readGitCommit(wt), second, "so must the read");

        fs.rmSync(privateLoose);
        fs.writeFileSync(path.join(privateDir, "packed-refs"), `${FAKE} refs/bisect/bad\n`);
        assert.throws(() => git(wt, "rev-parse", "HEAD"), "git ignores a private packed-refs");
        assert.equal(readGitCommit(wt), null, "so must the read");

        fs.rmSync(path.join(privateDir, "packed-refs"));
        git(dir, "update-ref", "refs/bisect/bad", first);
        assert.throws(() => git(wt, "rev-parse", "HEAD"), "git does not fall back to the common dir");
        assert.equal(readGitCommit(wt), null, "so must the read");

        fs.rmSync(path.join(dir, ".git", "refs", "bisect", "bad"));
        fs.writeFileSync(path.join(dir, ".git", "packed-refs"),
            `# pack-refs with: peeled fully-peeled sorted\n${first} refs/bisect/bad\n`);
        git(dir, "symbolic-ref", "HEAD", "refs/bisect/bad");
        assert.equal(git(dir, "rev-parse", "HEAD"), first, "git honours it where git dir == common dir");
        assert.equal(readGitCommit(dir), first, "and so must the read");

        git(wt, "symbolic-ref", "HEAD", "refs/heads/wtbranch");
        git(dir, "worktree", "remove", "--force", wt);
    }
    finally {
        fs.rmSync(wt, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lab: the symbolic ref depth bound is git's own limit, not one hop past it", () => {
    // Rantai yang git tolak harus menghasilkan null di sini juga: hash yang
    // "lebih benar daripada git" tetap hash yang tidak pernah git laporkan.
    const dir = tmp("w8-lab-depth-");
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");
        const real = git(dir, "rev-parse", "--abbrev-ref", "HEAD");

        for (let hops = 1; hops <= 4; hops++) {
            for (let i = hops; i >= 1; i--) {
                const target = i === 1 ? `refs/heads/${real}` : `refs/heads/chain-${i - 1}`;
                git(dir, "symbolic-ref", `refs/heads/chain-${i}`, target);
            }
            git(dir, "symbolic-ref", "HEAD", `refs/heads/chain-${hops}`);

            if (hops <= 3) {
                assert.equal(readGitCommit(dir), git(dir, "rev-parse", "HEAD"), `${hops} symbolic hops`);
            }
            else {
                assert.throws(() => git(dir, "rev-parse", "HEAD"), "git refuses this depth");
                assert.equal(readGitCommit(dir), null, `${hops} symbolic hops: git fails, so does the read`);
            }
        }
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lab: a damaged packed-refs is not repaired on git's behalf", () => {
    // CRLF di packed-refs ditolak git seluruhnya; merapikan tiap baris di sini
    // berarti melaporkan commit yang git sendiri tidak mau selesaikan.
    const dir = tmp("w8-lab-packed-crlf-");
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");
        git(dir, "pack-refs", "--all");

        const packed = path.join(dir, ".git", "packed-refs");
        fs.writeFileSync(packed, fs.readFileSync(packed, "utf8").split("\n").join("\r\n"));

        assert.throws(() => git(dir, "rev-parse", "HEAD"), "git rejects the whole file");
        assert.equal(readGitCommit(dir), null, "so must the read");
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("lab: a chained symbolic ref resolves like git", () => {
    const dir = tmp("w8-lab-symref-");
    try {
        git(dir, "init", "-q");
        fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
        git(dir, "add", "a.txt");
        git(dir, ...commitEnvArgs(), "commit", "-q", "-m", "first");

        const real = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
        git(dir, "symbolic-ref", "refs/heads/alias-branch", `refs/heads/${real}`);
        git(dir, "symbolic-ref", "HEAD", "refs/heads/alias-branch");

        const expected = git(dir, "rev-parse", "HEAD");
        assert.match(expected, /^[0-9a-f]{40}$/);
        assert.equal(readGitCommit(dir), expected, "HEAD -> alias -> real branch");
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
