"use strict";

const { createRollbackResistantLedger } = require("../helpers/rollbackSubstrate");

/** W8-IW1: consequential execution requires a rollback-resistant replay substrate. */
function codingWithSubstrate(opts = {}) {
    return createCodingCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

/**
 * W8-IW1 Phase 3B — the AUTHORIZED side of the CodingBrain family.
 *
 * Separate process from tests/safety/seniorEngineer.test.js on purpose: a
 * coding capability runtime carrying a real authority store is installed once
 * per process at composition time (never per call, never mid-flight). Here the
 * fixture is a legitimate owner-ratified grant in a canonical authority store —
 * the same rehydratable shape the production store persists — and never a
 * manually branded authority evaluation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
    createCodingCapabilityRuntime,
    installCodingCapabilityRuntime
} = require("../../src/manager/internal/codingCapabilities.js");

/** Canonical authority store fixture with an ACTIVE owner grant. */
function grantStore(entries) {
    const caps = new Map(entries.map((e) => [e.capabilityId, e]));
    return {
        async getCapability(id) {
            const e = caps.get(id);
            if (!e) return null;
            return {
                capabilityId: id,
                status: "ACTIVE",
                generation: 0,
                payload: {
                    subject: "owner",
                    capabilityId: id,
                    kind: "root",
                    actions: ["execute"],
                    scope: [],
                    allowedPurposes: [],
                    restrictions: { kind: "unrestricted" },
                    maxExecutions: null,
                    identityBinding: null,
                    notBefore: null,
                    expiresAt: null,
                    issuedAt: new Date().toISOString()
                }
            };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

// Composition time: ratify exactly ONE capability (git read). Everything else in
// the family stays unratified, which is what the third test below proves.
installCodingCapabilityRuntime(codingWithSubstrate({
    authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
    acknowledge: () => ({ ok: true, receipt: "ratified-fixture-ack" })
}));

const { codingTools } = require("../../src/coding/tools");

const tool = (name) => codingTools().find((t) => t.name === name);

test("code_diff melaporkan status + diff dan memangkas keluaran panjang", async () => {

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "damar-ratified-repo-"));
    const git = args => execFileSync("git", args, { cwd: repo, windowsHide: true });

    git(["init", "-q"]);
    git(["config", "user.email", "test@damar.local"]);
    git(["config", "user.name", "Damar Test"]);

    fs.writeFileSync(path.join(repo, "a.txt"), "baris awal\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "awal"]);

    fs.writeFileSync(path.join(repo, "a.txt"), "x".repeat(5000) + "\n");

    const hasil = await tool("code_diff").execute({ project: repo, maxChars: 200 });

    assert.equal(hasil.ok, true, JSON.stringify(hasil).slice(0, 200));
    assert.match(hasil.status, /a\.txt/);
    assert.equal(hasil.truncated, true);
    assert.equal(hasil.diff.length, 200);

});

test("code_diff pada folder yang bukan repo git tetap melaporkan bukan-repo", async () => {

    const kosong = fs.mkdtempSync(path.join(os.tmpdir(), "damar-ratified-nonrepo-"));

    const hasil = await tool("code_diff").execute({ project: kosong });

    assert.equal(hasil.ok, false);

});

test("capability lain dalam keluarga yang sama tetap DENY (granularitas per operasi)", async () => {

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "damar-ratified-write-"));
    const git = args => execFileSync("git", args, { cwd: repo, windowsHide: true });
    git(["init", "-q"]);
    git(["config", "user.email", "test@damar.local"]);
    git(["config", "user.name", "Damar Test"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");

    const commit = await tool("code_commit").execute({ message: "harusnya ditolak", project: repo });
    assert.equal(commit.ok, false);
    assert.equal(commit.denied, true);
    assert.equal(commit.capabilityId, "coding.git.write");

    const branch = await tool("code_branch").execute({ name: "damar/should-not-exist", project: repo });
    assert.equal(branch.ok, false);
    assert.equal(branch.denied, true);

    // Zero repository mutation: no branch was created.
    const branches = execFileSync("git", ["branch", "--list", "damar/should-not-exist"], { cwd: repo, windowsHide: true }).toString();
    assert.equal(branches.trim(), "");

});
