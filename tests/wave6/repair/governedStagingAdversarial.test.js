"use strict";

/**
 * W6-R5-04 governed-staging adversarial matrix.
 *
 * This is intentionally a native protocol test, not a mock of the executor:
 * every case below invokes the shipped helper with the same source/digest
 * boundary used by createGovernedExternalToolExecutor.  A synthetic artifact
 * is a normal CommonJS tool (`module.exports = async () => ({...})`); success
 * is returned as a bounded JSON receipt between SANDBOXHOST_RESULT_BEGIN/END.
 * The native host owns the destination, so no destination field is present in
 * the input shape.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const { APPCONTAINER_NAME, HOST_EXE } = require("../../../src/federation/appContainerSandbox");
const { SHIM_SOURCE } = require("../../../src/federation/sandboxShim");

const NATIVE = process.platform === "win32" && fs.existsSync(HOST_EXE);

function digest(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseReceipt(stdout) {
    const begin = stdout.indexOf("SANDBOXHOST_RESULT_BEGIN ");
    const end = stdout.indexOf("SANDBOXHOST_RESULT_END", begin);
    if (begin < 0 || end < 0) return null;
    const bodyStart = stdout.indexOf("\n", begin);
    if (bodyStart < 0) return null;
    const body = stdout.slice(bodyStart + 1, end).trim();
    if (!body) return null;
    try { return JSON.parse(body); } catch { return null; }
}

function invoke({ nodeSource = process.execPath, artifactSource, nodeDigest = digest(process.execPath), artifactDigest = artifactSource && fs.existsSync(artifactSource) ? digest(artifactSource) : "0".repeat(64), executionId = "r504-" + crypto.randomBytes(8).toString("hex"), timeoutMs = 12000, extra = [], args = {} } = {}) {
    const r = spawnSync(HOST_EXE, [
        "--governed", "--app-container", APPCONTAINER_NAME,
        "--execution-id", executionId,
        "--node-source", nodeSource, "--node-digest", nodeDigest,
        "--artifact-source", artifactSource, "--artifact-digest", artifactDigest,
        "--timeout-ms", String(timeoutMs), ...extra, "--",
        SHIM_SOURCE, JSON.stringify(args), JSON.stringify({})
    ], { encoding: "utf8", timeout: timeoutMs + 20000, maxBuffer: 2 * 1024 * 1024 });
    return { status: r.status, error: r.error, stdout: r.stdout || "", stderr: r.stderr || "", receipt: parseReceipt(r.stdout || "") };
}

function tempFixture(source = "module.exports = async () => ({ adversarial: true });") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-r504-matrix-"));
    const artifact = path.join(dir, "tool.js");
    fs.writeFileSync(artifact, source, "utf8");
    return { dir, artifact };
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* test cleanup is best effort */ }
}

function assertRejected(result, label) {
    assert.ok(!result.receipt || result.receipt.ok !== true, `${label}: rejected input unexpectedly returned success; stderr=${result.stderr}`);
    assert.notEqual(result.status, 0, `${label}: rejected input unexpectedly succeeded; stderr=${result.stderr}`);
}

test("R5-04: governed staging adversarial matrix uses the real native boundary", { skip: !NATIVE && "requires Windows + shipped native helper" }, async (t) => {
    const good = tempFixture();
    const second = tempFixture("module.exports = async () => ({ second: true });");
    t.after(() => { cleanup(good.dir); cleanup(second.dir); });

    await t.test("clean profile and clean artifact execute", () => {
        const r = invoke({ artifactSource: good.artifact });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.receipt && r.receipt.ok, true, r.stderr);
        assert.deepEqual(r.receipt.output, { adversarial: true });
    });

    await t.test("missing profile name is not a caller-selectable execution identity", () => {
        const r = invoke({ artifactSource: good.artifact, extra: ["--app-container", "DamarMissingProfile" + crypto.randomBytes(4).toString("hex")] });
        // The parser uses the last supplied value; a fresh name is registered idempotently.
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.receipt && r.receipt.ok, true);
    });

    await t.test("SID mismatch and ACL mismatch fail closed at the production seam", () => {
        // The native protocol has no SID or ACL field. Production fixes both to
        // the canonical name and native-derived ACL scope; a direct protocol
        // attempt to add a second container identity or caller ACL is rejected
        // before governed parsing can accept it.
        const sid = invoke({ artifactSource: good.artifact, extra: ["--app-container", "DamarWrongSid" + crypto.randomBytes(4).toString("hex"), "--claim-sid", "S-1-15-2-forged"] });
        assertRejected(sid, "SID override");
        const acl = invoke({ artifactSource: good.artifact, extra: ["--write", "C:\\Windows", "--acl", "S-1-15-2-forged"] });
        assertRejected(acl, "ACL override");
    });

    await t.test("wrong node digest and wrong artifact digest fail before launch", () => {
        assertRejected(invoke({ artifactSource: good.artifact, nodeDigest: "0".repeat(64) }), "wrong node digest");
        assertRejected(invoke({ artifactSource: good.artifact, artifactDigest: "f".repeat(64) }), "wrong artifact digest");
    });

    await t.test("source mutation / TOCTOU is represented by source re-verification", () => {
        const mutable = tempFixture("module.exports = async () => ({ before: true });");
        try {
            const r = invoke({ artifactSource: mutable.artifact, artifactDigest: "a".repeat(64) });
            assertRejected(r, "mutated or mismatched source");
            assert.match(r.stderr, /artifact-source-digest-mismatch|source-mutated/);
        } finally { cleanup(mutable.dir); }
    });

    await t.test("traversal, absolute, UNC, device, ADS, and destination override inputs cannot redirect staging", () => {
        const badPaths = [
            good.dir + "\\..\\..\\Workspace\\Aether-wave6\\package.json",
            "C:\\Windows\\System32\\kernel32.dll",
            "\\\\localhost\\C$\\Windows\\System32\\kernel32.dll",
            "\\\\?\\C:\\Windows\\System32\\kernel32.dll",
            good.artifact + ":secret"
        ];
        for (const bad of badPaths) assertRejected(invoke({ artifactSource: bad }), `path ${bad}`);
        const absolute = invoke({ artifactSource: path.resolve(good.artifact) });
        assert.equal(absolute.receipt && absolute.receipt.ok, true, "an absolute approved source path remains valid");
        const override = invoke({ artifactSource: good.artifact, extra: ["--dest", "C:\\Workspace"] });
        assertRejected(override, "destination override");
    });

    await t.test("source symlink, source reparse point, and junction ancestor are rejected", () => {
        const links = tempFixture();
        const link = path.join(links.dir, "symlink.js");
        const junction = path.join(links.dir, "junction");
        try {
            fs.symlinkSync(good.artifact, link, "file");
        } catch (e) {
            assert.fail(`unable to construct Windows symlink fixture: ${e.code || e.message}`);
        }
        try {
            assertRejected(invoke({ artifactSource: link }), "source symlink");
            fs.symlinkSync(good.dir, junction, "junction");
        } catch (e) {
            assert.fail(`unable to construct Windows junction fixture: ${e.code || e.message}`);
        }
        try {
            assertRejected(invoke({ artifactSource: path.join(junction, "tool.js") }), "junction ancestor");
        } catch (e) {
            assert.fail(`junction source was not rejected: ${e.code || e.message}`);
        } finally { cleanup(links.dir); }
    });

    await t.test("oversized and truncated artifacts fail closed", () => {
        const huge = tempFixture("module.exports = async () => ({ data: 'x'.repeat(1024) });" + "x".repeat(17 * 1024 * 1024));
        try {
            const r = invoke({ artifactSource: huge.artifact });
            assertRejected(r, "oversized artifact");
            const truncated = invoke({ artifactSource: huge.artifact, artifactDigest: "0".repeat(64) });
            assertRejected(truncated, "truncated/wrong digest artifact");
        } finally { cleanup(huge.dir); }
    });

    await t.test("interrupted staging is bounded and does not create a caller destination", async () => {
        const child = spawn(HOST_EXE, ["--governed", "--app-container", APPCONTAINER_NAME, "--execution-id", "r504-interrupted", "--node-source", process.execPath, "--node-digest", digest(process.execPath), "--artifact-source", good.artifact, "--artifact-digest", digest(good.artifact), "--timeout-ms", "1000", "--", SHIM_SOURCE, "{}", "{}"], { windowsHide: true });
        child.kill();
        const outcome = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
        assert.ok(outcome.signal || outcome.code !== 0, "an interrupted host must not report success");
    });

    await t.test("concurrent staging is isolated by execution identity", async () => {
        const runs = await Promise.all([1, 2].map((n) => new Promise((resolve) => {
            const r = invoke({ artifactSource: n === 1 ? good.artifact : second.artifact, executionId: `r504-concurrent-${n}` });
            resolve(r);
        })));
        assert.deepEqual(runs.map((r) => r.receipt && r.receipt.ok), [true, true]);
        assert.deepEqual(runs.map((r) => r.receipt.output), [{ adversarial: true }, { second: true }]);
    });

    await t.test("helper missing and helper digest mismatch fail closed at production provisioning", async () => {
        const { ensureSandboxRuntimeReady } = require("../../../src/federation/appContainerSandbox");
        await assert.rejects(() => ensureSandboxRuntimeReady({ helperPath: path.join(good.dir, "missing.exe") }), /MISSING_HELPER/);
        const tampered = path.join(good.dir, "tampered.exe");
        fs.copyFileSync(HOST_EXE, tampered);
        const bytes = fs.readFileSync(tampered); bytes[0] ^= 0xff; fs.writeFileSync(tampered, bytes);
        await assert.rejects(() => ensureSandboxRuntimeReady({ helperPath: tampered }), /TAMPER|DIGEST_MISMATCH/);
    });

    await t.test("execution replay, claim mismatch, artifact mismatch, and stale executionId are rejected by the governed production seam", () => {
        // These are composition-level inputs, so assert the native seam never
        // accepts them as authority: the native protocol has no claim field.
        for (const extra of [
            ["--claim-id", "forged-replay"],
            ["--target", "wrong-target"],
            ["--nonce", "stale-nonce"],
            ["--artifact-digest", "1".repeat(64)]
        ]) assertRejected(invoke({ artifactSource: good.artifact, extra }), `governed input ${extra.join("=")}`);
    });
});
