"use strict";

/**
 * W6-R5-04 — REGRESSION TESTS FOR THE THREE PROVEN NATIVE-HOST ROOT CAUSES.
 *
 * These lock in the defects that blocked governed AppContainer execution. Each
 * one reproduced deterministically before the fix and is asserted here so it
 * cannot silently return.
 *
 * RC1 — PROFILE EXISTENCE VALIDATION DEFECT.
 *   EnsureSid derived before creating. DeriveAppContainerSidFromAppContainerName
 *   hashes the NAME ALONE and succeeds for names that were never registered, so
 *   `--ensure` reported "ready" for a profile with no package registration and
 *   CreateProcess then failed with ERROR_FILE_NOT_FOUND (2).
 *   Regression: after `--ensure` on a FRESH name the package folder must exist.
 *
 * RC2 — ANCESTOR ACL PROPAGATION DEFECT + FILESYSTEM SANDBOX ESCAPE.
 *   grantReadTree applied an INHERITABLE (OI)(CI) ReadAndExecute ACE to every
 *   ancestor directory. Windows propagated it across the whole ancestor tree
 *   (minutes of CPU per launch) AND granted the sandbox SID read over every
 *   sibling — the source repo included.
 *   Regression: a governed execution must not leave an inheritable ACE on the
 *   artifact's ancestor directories, and sandboxed code must not read the repo.
 *
 * RC3 — USER32 DESKTOP / WINDOW-STATION INITIALIZATION INCOMPATIBILITY.
 *   USER32's DllMain attaches the process to a window station and desktop. The
 *   zero-capability AppContainer cannot reach WinSta0\Default, so every binary
 *   importing USER32 — node.exe included — died at STATUS_DLL_INIT_FAILED
 *   (0xC0000142) before running any of its own code. The host now creates a
 *   PRIVATE, EMPTY window station + desktop for the child.
 *   Regression: a real governed node execution must return a result, and the
 *   private station must not leak across runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { APPCONTAINER_NAME, HOST_EXE } = require("../../../src/federation/appContainerSandbox");
const { SHIM_SOURCE } = require("../../../src/federation/sandboxShim");

const WINDOWS = process.platform === "win32";
const HOST_PRESENT = fs.existsSync(HOST_EXE);
const NATIVE = WINDOWS && HOST_PRESENT;

const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const packagesRoot = () => path.join(process.env.LOCALAPPDATA || "", "Packages");

/** Run one real governed execution of `artifactPath` and return the parsed receipt. */
function runGoverned(artifactPath, { timeoutMs = 60000, args = {} } = {}) {
    const executionId = "test-r504-" + crypto.randomBytes(8).toString("hex");
    const r = spawnSync(HOST_EXE, [
        "--governed",
        "--app-container", APPCONTAINER_NAME,
        "--execution-id", executionId,
        "--node-source", process.execPath,
        "--node-digest", sha256File(process.execPath),
        "--artifact-source", artifactPath,
        "--artifact-digest", sha256File(artifactPath),
        "--timeout-ms", String(timeoutMs),
        "--",
        SHIM_SOURCE,
        JSON.stringify(args),
        JSON.stringify({})
    ], { encoding: "utf8", timeout: timeoutMs + 60000, maxBuffer: 8 * 1024 * 1024 });

    const stdout = r.stdout || "";
    const begin = stdout.indexOf("SANDBOXHOST_RESULT_BEGIN ");
    const end = stdout.indexOf("SANDBOXHOST_RESULT_END");
    let receipt = null;
    if (begin >= 0 && end > begin) {
        const body = stdout.slice(stdout.indexOf("\n", begin) + 1, end).trim();
        if (body.length > 0) { try { receipt = JSON.parse(body); } catch { receipt = null; } }
    }
    return { executionId, status: r.status, stdout, stderr: r.stderr || "", receipt };
}

/** Write a throwaway tool artifact into its own temp directory. */
function stageArtifact(source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r504-rc-"));
    const file = path.join(dir, "tool.js");
    fs.writeFileSync(file, source, "utf8");
    return { dir, file };
}

// ---------------------------------------------------------------- RC1 -------

test("R5-04 RC1: --ensure REGISTERS the profile (derive-only reported a phantom SID)", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const fresh = "DamarR504RC1" + crypto.randomBytes(6).toString("hex");
    const pkgDir = path.join(packagesRoot(), fresh);
    assert.equal(fs.existsSync(pkgDir), false, "precondition: fresh container must not exist");

    const r = spawnSync(HOST_EXE, ["--app-container", fresh, "--ensure"], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, "ensure must succeed for a fresh container: " + (r.stderr || ""));

    // THE REGRESSION: a "ready" report is only truthful if the profile is really
    // registered. Derive-first returned a valid-looking SID with no package
    // folder, and the subsequent CreateProcess failed with ERROR_FILE_NOT_FOUND.
    assert.equal(fs.existsSync(pkgDir), true,
        "ensure reported ready but no package folder exists — profile was never registered (RC1)");
});

test("R5-04 RC1: a freshly ensured profile can actually launch a child", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const { file } = stageArtifact("module.exports = async () => ({ rc1: true });");
    const out = runGoverned(file, { timeoutMs: 45000 });
    assert.notEqual(out.receipt, null, "no receipt frame — launch failed: " + out.stderr.slice(-300));
    assert.equal(out.receipt.ok, true, "governed execution failed: " + JSON.stringify(out.receipt).slice(0, 300));
    assert.deepEqual(out.receipt.output, { rc1: true });
});

// ---------------------------------------------------------------- RC2 -------

test("R5-04 RC2: a governed execution ADDS no inheritable ACE to artifact ancestors", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const { dir, file } = stageArtifact("module.exports = async () => ({ rc2: true });");
    const ancestors = [dir, path.dirname(dir)];

    // Attribute CAUSALLY. The machine may still carry historical ACEs written by
    // the pre-fix helper on shared ancestors such as %LOCALAPPDATA%\Temp; those
    // are an environment-cleanup matter, not a defect in the current build.
    // Snapshotting before/after isolates exactly what THIS run wrote.
    const aces = (p) => new Set(
        (spawnSync("icacls", [p], { encoding: "utf8", timeout: 30000 }).stdout || "")
            .split(/\r?\n/).filter((l) => /S-1-15-2-/.test(l)).map((l) => l.trim())
    );
    const before = new Map(ancestors.map((p) => [p, aces(p)]));

    const out = runGoverned(file, { timeoutMs: 45000 });
    assert.equal(out.receipt && out.receipt.ok, true, "setup: governed execution must succeed");

    // An AppContainer needs TRAVERSE on ancestors, never inheritable read. An
    // (OI)/(CI) ACE is the defect: Windows propagates it across the entire tree
    // (the multi-minute launch stall) and it exposes every sibling directory to
    // the sandbox — the source repo included.
    for (const ancestor of ancestors) {
        const added = [...aces(ancestor)].filter((a) => !before.get(ancestor).has(a));
        for (const ace of added) {
            assert.equal(/\(OI\)|\(CI\)/.test(ace), false,
                `this run wrote an INHERITABLE AppContainer ACE on ${ancestor} (RC2): ${ace}`);
        }
    }
});

test("R5-04 RC2: sandboxed tool code CANNOT read the source repository", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const repoFile = path.resolve(__dirname, "..", "..", "..", "package.json").replace(/\\/g, "/");
    const repoDir = path.resolve(__dirname, "..", "..", "..").replace(/\\/g, "/");
    const { file } = stageArtifact(`
module.exports = async () => {
  const fs = require("node:fs");
  const probe = (fn) => { try { return { ok: true, v: String(fn()).slice(0, 40) }; } catch (e) { return { ok: false, e: e.code || String(e.message).slice(0, 40) }; } };
  return {
    readRepoFile: probe(() => fs.readFileSync(${JSON.stringify(repoFile)}, "utf8")),
    listRepoDir: probe(() => fs.readdirSync(${JSON.stringify(repoDir)}).length),
    listVolumeRoot: probe(() => fs.readdirSync("C:/").length)
  };
};`);
    const out = runGoverned(file, { timeoutMs: 45000 });
    assert.equal(out.receipt && out.receipt.ok, true, "setup: governed execution must succeed");

    const o = out.receipt.output;
    assert.equal(o.readRepoFile.ok, false, "SANDBOX ESCAPE: tool code read repo source (RC2)");
    assert.equal(o.listRepoDir.ok, false, "SANDBOX ESCAPE: tool code listed the repo (RC2)");
    assert.equal(o.listVolumeRoot.ok, false, "SANDBOX ESCAPE: tool code listed the volume root (RC2)");
});

test("R5-04 RC2: production container cannot read host credentials or config", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    // This is the escape that RC2 actually produced in the field: the PRODUCTION
    // container (not a clean throwaway) held inherited RX over the user profile
    // and read C:\Users\<user>\.claude\settings.json. Test the real identity.
    const home = String(process.env.USERPROFILE).replace(/\\/g, "/");
    const { file } = stageArtifact(`
module.exports = async () => {
  const fs = require("node:fs");
  const probe = (fn) => { try { return { ok: true, v: String(fn()).slice(0, 30) }; } catch (e) { return { ok: false, e: e.code || String(e.message).slice(0, 40) }; } };
  return {
    listHome: probe(() => fs.readdirSync(${JSON.stringify(home)}).length),
    readClaudeSettings: probe(() => fs.readFileSync(${JSON.stringify(home + "/.claude/settings.json")}, "utf8")),
    listAppDataLocal: probe(() => fs.readdirSync(${JSON.stringify(home + "/AppData/Local")}).length),
    listPackagesRoot: probe(() => fs.readdirSync(${JSON.stringify(home + "/AppData/Local/Packages")}).length)
  };
};`);
    const out = runGoverned(file, { timeoutMs: 45000 });
    assert.equal(out.receipt && out.receipt.ok, true, "setup: governed execution must succeed");

    const o = out.receipt.output;
    assert.equal(o.listHome.ok, false, "SANDBOX ESCAPE: production container listed the user profile (RC2)");
    assert.equal(o.readClaudeSettings.ok, false, "SANDBOX ESCAPE: production container read host credentials/config (RC2)");
    assert.equal(o.listAppDataLocal.ok, false, "SANDBOX ESCAPE: production container listed %LOCALAPPDATA% (RC2)");
    assert.equal(o.listPackagesRoot.ok, false, "SANDBOX ESCAPE: production container listed the Packages root — it can see other sandboxes (RC2)");
});

test("R5-04 RC2: no inheritable AppContainer ACE on any shared security root", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    // The pre-fix ancestor walk propagated (OI)(CI)(RX) onto every shared root it
    // passed through, which is how the production sandbox came to read the user
    // profile and C:\Users\jrxid\.claude\settings.json. No Damar container may
    // hold an inheritable grant on any of these again.
    //
    // %LOCALAPPDATA%\Packages is included deliberately: Windows does NOT create a
    // per-container ACE on that root (containers created after the fix have zero
    // there and still stage and execute), so any (OI)(CI) ACE on it is residue
    // that would let one sandbox read every other sandbox's data.
    const home = process.env.USERPROFILE;
    const local = process.env.LOCALAPPDATA;
    const roots = [
        home,
        path.join(home, "AppData"),
        local,
        path.join(local, "Temp"),
        path.join(local, "Packages"),
        "C:\\Workspace"
    ].filter((p) => p && fs.existsSync(p));

    // Resolve each SID to its AppContainer moniker. Only containers this
    // codebase creates are ours to assert on: a foreign AppContainer's ACE is
    // another product's business and is reported, not failed. Unattributable
    // (unmapped) SIDs are likewise reported only — the behavioural guard below
    // ("production container cannot read host credentials") is what actually
    // proves the escape is closed, whoever else holds an ACE.
    const monikerOf = (sid) => {
        const q = spawnSync("reg", ["query",
            `HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\${sid}`,
            "/v", "Moniker"], { encoding: "utf8", timeout: 20000 });
        const m = String(q.stdout || "").match(/Moniker\s+REG_SZ\s+(\S+)/);
        return m ? m[1] : null;
    };

    const ours = [];
    const foreign = [];
    for (const root of roots) {
        const acl = spawnSync("icacls", [root], { encoding: "utf8", timeout: 60000 }).stdout || "";
        for (const line of acl.split(/\r?\n/)) {
            const m = line.match(/(S-1-15-2-[\d-]+):\(([^)]*)\)/);
            if (!m || !/\(OI\)|\(CI\)/.test(line)) continue;
            const moniker = monikerOf(m[1]);
            const entry = `${root} :: ${moniker || "<unmapped>"} ${m[1]}:(${m[2]})`;
            if (moniker && /damar/i.test(moniker)) ours.push(entry); else foreign.push(entry);
        }
    }

    assert.deepEqual(ours, [],
        "a Damar AppContainer holds an inheritable grant on a shared security root (RC2 regression):\n  "
        + ours.join("\n  ")
        + (foreign.length ? `\n[informational — not Damar-created, not asserted]\n  ${foreign.join("\n  ")}` : ""));
});

test("R5-04 RC2: repeated governed executions stay bounded (no DACL re-propagation stall)", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const { file } = stageArtifact("module.exports = async () => ({ n: 1 });");
    runGoverned(file, { timeoutMs: 45000 }); // warm: first run may create the profile
    const started = Date.now();
    for (let i = 0; i < 3; i += 1) {
        const out = runGoverned(file, { timeoutMs: 45000 });
        assert.equal(out.receipt && out.receipt.ok, true, "run " + i + " failed");
    }
    // Pre-fix, an ancestor under a large tree re-propagated inheritance on EVERY
    // launch and took minutes. ACL application is now idempotent and O(1).
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 90000, `3 governed runs took ${elapsed}ms — DACL propagation stall is back (RC2)`);
});

// ---------------------------------------------------------------- RC3 -------

test("R5-04 RC3: node.exe (a USER32 importer) starts inside the AppContainer", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const { file } = stageArtifact("module.exports = async () => ({ rc3: true, pid: process.pid });");
    const out = runGoverned(file, { timeoutMs: 45000 });

    // STATUS_DLL_INIT_FAILED surfaces as the child exit code 0xC0000142.
    assert.notEqual(out.status, -1073741502,
        "child died with STATUS_DLL_INIT_FAILED (0xC0000142) — USER32 window-station regression (RC3)");
    assert.notEqual(out.receipt, null, "no receipt frame: " + out.stderr.slice(-300));
    assert.equal(out.receipt.ok, true, JSON.stringify(out.receipt).slice(0, 300));
    assert.equal(out.receipt.output.rc3, true);
    assert.ok(Number(out.receipt.output.pid) > 0, "child must report a real PID");
});

test("R5-04 RC3: private window station does not leak across repeated executions", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const listStations = () => {
        const ps = spawnSync("powershell", ["-NoProfile", "-Command", `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class WS {
  [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet=CharSet.Unicode)]
  public delegate bool Cb([MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="EnumWindowStationsW")]
  public static extern bool Enum(Cb cb, IntPtr p);
  public static List<string> L(){ var l=new List<string>(); Cb c=(n,p)=>{ l.Add(n); return true; }; Enum(c, IntPtr.Zero); GC.KeepAlive(c); return l; }
}
'@
[WS]::L() -join ','`], { encoding: "utf8", timeout: 60000 });
        return String(ps.stdout || "").trim().split(",").filter(Boolean);
    };

    const before = listStations();
    assert.ok(before.length > 0, "precondition: window station enumeration must work");

    const { file } = stageArtifact("module.exports = async () => ({ ok: 1 });");
    for (let i = 0; i < 2; i += 1) {
        const out = runGoverned(file, { timeoutMs: 45000 });
        assert.equal(out.receipt && out.receipt.ok, true, "run " + i + " failed");
    }

    const after = listStations();
    const leaked = after.filter((s) => /^DamarSbx/i.test(s));
    assert.deepEqual(leaked, [], "private window station leaked after execution (RC3): " + leaked.join(","));
    assert.equal(after.length, before.length,
        `window station count changed ${before.length} -> ${after.length} (RC3 lifecycle leak)`);
});

test("R5-04 RC3: the sandbox child cannot shell out from its private station", { skip: !NATIVE && "requires Windows + native helper" }, () => {
    const { file } = stageArtifact(`
module.exports = async () => {
  // A child on the interactive desktop could reach the user's windows and
  // clipboard. Ours is on a private, empty station, so there is nothing of the
  // user's to reach — and a shell-out must not succeed either.
  const cp = require("node:child_process");
  let spawnResult = "not-attempted";
  try {
    const r = cp.spawnSync("C:/Windows/System32/cmd.exe", ["/c", "echo x"], { encoding: "utf8", timeout: 3000 });
    spawnResult = "spawn-status:" + r.status + ":" + (r.error && r.error.code);
  } catch (e) { spawnResult = "throw:" + (e.code || "?"); }
  return { spawnResult };
};`);
    const out = runGoverned(file, { timeoutMs: 30000 });
    // Process containment is BOUNDED, not OS-denied: the spawn blocks and the
    // host kills the child at its timeout (exit 124). Either outcome is
    // acceptable; a clean successful shell-out is NOT.
    if (out.receipt && out.receipt.ok) {
        assert.equal(/spawn-status:0:/.test(String(out.receipt.output.spawnResult)), false,
            "sandboxed code shelled out successfully — process containment regression");
    } else {
        assert.equal(out.status, 124,
            "expected host-bounded timeout (124) for a blocked spawn, got host exit " + out.status);
    }
});
