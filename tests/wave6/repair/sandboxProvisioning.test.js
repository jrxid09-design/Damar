"use strict";

/**
 * W6-R4-02 — AppContainer PROVISIONING (ensureSandboxRuntimeReady).
 *
 * Composition-owned provisioning:
 *   - idempotent (derive-first; repeated calls share single-flight probe)
 *   - bounded (timeout kills a hung helper, fails closed)
 *   - fail-closed (non-Windows / missing helper / bad exit → reject)
 *   - tamper-detecting (binary digest mismatch → reject)
 *   - zero-capability guarantee surfaced through the native `--ensure` mode.
 *
 * These assertions are platform-gated: on Windows with the shipping helper
 * they exercise the real native provisioning; on other platforms they assert
 * the fail-closed rejection (never a non-isolating fallback).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
    APPCONTAINER_NAME,
    HOST_EXE,
    SANDBOX_HOST_DIGEST,
    ensureSandboxRuntimeReady,
    sandboxProvisioningStatus
} = require("../../../src/federation/appContainerSandbox");

const WINDOWS = process.platform === "win32";
const HOST_PRESENT = fs.existsSync(HOST_EXE);

test("R4-02: provisioning API shape — loads from the inert module, no launch surface", () => {
    assert.equal(APPCONTAINER_NAME, "DamarGovExternalSandbox");
    assert.match(HOST_EXE, /native[\/\\]sandbox-host[\/\\]sandbox-host\.exe$/);
    assert.equal(typeof ensureSandboxRuntimeReady, "function");
    assert.equal(typeof sandboxProvisioningStatus, "function");
    // No launch primitive escapes the module (R3-03 remains true through R4-02).
    const modKeys = Object.keys(require("../../../src/federation/appContainerSandbox"));
    assert.equal(modKeys.some((k) => /launch|spawn|runSandbox/.test(k)), false);
    assert.match(SANDBOX_HOST_DIGEST, /^[0-9a-f]{64}$/, "frozen helper digest is a real SHA-256 hex");
});

test("R4-02: helper binary digest is immutable/recorded (tamper baseline)", () => {
    if (!HOST_PRESENT) {
        // On a platform without the helper, the digest constant is still a
        // non-null recorded value; nothing more to assert here.
        assert.equal(SANDBOX_HOST_DIGEST.length, 64);
        return;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(HOST_EXE)).digest("hex");
    // The frozen manifest must match the real helper byte-for-byte; if an
    // engineer rebuilds the helper they must re-record SANDBOX_HOST_DIGEST.
    assert.equal(actual, SANDBOX_HOST_DIGEST,
        "helper binary must match the recorded digest (re-record after a legit rebuild)");
});

test("R4-02: ensureSandboxRuntimeReady resolves on Windows+helper present (idempotent)", { skip: !WINDOWS || !HOST_PRESENT }, async () => {
    const a = await ensureSandboxRuntimeReady();
    const b = await ensureSandboxRuntimeReady();
    assert.equal(a.ready, true);
    assert.equal(a.mechanism, "AppContainer");
    assert.equal(a.sandboxId, APPCONTAINER_NAME);
    assert.ok(a.provisionedAtMs > 0);
    // Idempotent: second call shares the same single-flight probe; the
    // result is identical after Provisioning without re-spawning twice.
    assert.equal(b.ready, true);
    const status = sandboxProvisioningStatus();
    assert.equal(status.ready, true);
    assert.equal(sandboxProvisioningStatus().cached, true);
});

test("R4-02: concurrent provisioners coalesce (single-flight, bounded)", { skip: !WINDOWS || !HOST_PRESENT }, async () => {
    const results = await Promise.all(
        Array.from({ length: 8 }, () => ensureSandboxRuntimeReady())
    );
    for (const r of results) assert.equal(r.ready, true);
});

test("R4-02: fail-closed on non-Windows (no non-isolating fallback)", { skip: WINDOWS }, async () => {
    await assert.rejects(() => ensureSandboxRuntimeReady(), (e) => {
        return /SANDBOX_UNSUPPORTED_PLATFORM/.test(e.message);
    });
    assert.equal(sandboxProvisioningStatus().ready, false);
});

test("R4-02: fail-closed on missing helper (no silent disable)", async () => {
    const missing = path.join(path.dirname(HOST_EXE), "does-not-exist.exe");
    await assert.rejects(
        () => ensureSandboxRuntimeReady({ helperPath: missing }),
        (e) => /SANDBOX_PROVISION_MISSING_HELPER/.test(e.message)
    );
});

test("R4-02: tamper detection — modified helper binary is rejected (fail-closed)", async () => {
    if (!HOST_PRESENT) return; // nothing to tamper without the real helper
    // Copy the helper, flip a byte, and confirm provisioning rejects.
    const base = path.dirname(HOST_EXE);
    const tampered = path.join(base, "sandbox-host-TAMPERED.exe");
    const buf = fs.readFileSync(HOST_EXE);
    buf[0] = buf[0] ^ 0xff; // flip first byte
    fs.writeFileSync(tampered, buf);
    try {
        await assert.rejects(
            () => ensureSandboxRuntimeReady({ helperPath: tampered }),
            (e) => /SANDBOX_PROVISION_TAMPER/.test(e.message),
            "modified helper must fail provisioning (tamper rejection)"
        );
    } finally {
        try { fs.unlinkSync(tampered); } catch { /* best-effort */ }
    }
});

test("R4-02: busy/hung helper is bounded (timeout) — fixture is terminated and retry works", async () => {
    if (!WINDOWS) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-hung-helper-"));
    const fixtureSource = path.join(dir, "hung-helper.cs");
    const fixture = path.join(dir, "hung-helper.exe");
    // Compile a throwaway executable outside production artifacts. It ignores
    // all arguments, never writes a success result, and remains alive until
    // the watchdog fires.
    fs.writeFileSync(fixtureSource, "using System; public static class HungHelper { public static void Main() { System.Threading.Thread.Sleep(60000); } }", "utf8");
    const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const build = spawnSync(csc, ["/nologo", "/target:exe", "/out:" + fixture, fixtureSource], { encoding: "utf8", timeout: 10000 });
    assert.equal(build.status, 0, "hung-helper fixture must compile: " + (build.stderr || build.stdout || ""));
    const started = Date.now();
    try {
        const waiters = Array.from({ length: 3 }, () => ensureSandboxRuntimeReady({ helperPath: fixture, timeoutMs: 250, skipDigest: true }));
        const results = await Promise.all(waiters.map((p) => p.then(() => null, (e) => e)));
        assert.ok(results.every((e) => e && e.code === "SANDBOX_PROVISION_TIMEOUT"),
            "all coalesced waiters must receive the bounded timeout: " + JSON.stringify(results.map((e) => e && { code: e.code, message: e.message })));
        assert.ok(Date.now() - started < 5000, "watchdog must fire within bounded tolerance");
        const lingering = spawnSync("tasklist", ["/FI", "IMAGENAME eq ping.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5000 });
        assert.equal(String(lingering.stdout || "").toLowerCase().includes("ping.exe"), false,
            "hung-helper fixture must not leave a ping descendant alive");
    } finally {
        try { fs.unlinkSync(fixtureSource); } catch { /* fixture cleanup */ }
        try { fs.unlinkSync(fixture); } catch { /* fixture cleanup */ }
        try { fs.rmdirSync(dir); } catch { /* fixture cleanup */ }
    }
    const retry = await ensureSandboxRuntimeReady();
    assert.equal(retry.ready, true, "subsequent provisioning must retry after timeout");
});
