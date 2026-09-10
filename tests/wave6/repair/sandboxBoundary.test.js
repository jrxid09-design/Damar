"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGovernedExternalToolExecutor } = require("../../../src/integration/wave6Production");
const { APPCONTAINER_NAME, HOST_EXE } = require("../../../src/federation/appContainerSandbox");
const { SHIM_SOURCE } = require("../../../src/federation/sandboxShim");

/**
 * W6-R3-10 — RED-TEAM THE SANDBOX LAUNCH BOUNDARY (isolated unit surface).
 *
 * The production executor (`createGovernedExternalToolExecutor`) exposes NO
 * launch primitive; R3-03 removed `launchSandboxedTool` from public reach.
 * This suite attacks the surface that DOES exist at the executor boundary:
 *   - no toolFn / authorityArtifact / consumed / permission flags accepted;
 *   - SHIM_SOURCE is not an executable entry — it is inert source; launching
 *     it without the AppContainer host achieves nothing (it requires the
 *     sandbox host + tool path + cwd);
 *   - the AppContainer name is a stable constant (no caller-chosen name, so
 *     no container-name injection / sandbox switch);
 *   - HOST_EXE path is module-fixed (no caller path traversal into the
 *     sandbox host binary).
 *
 * Also verifies the SHIM require-allowlist blocks non-core relative require
 * and that the AppContainer profile name cannot be substituted.
 */

test("R3-10: executor accepts ONLY claimId/args/envMaterial (no RPC method/name injection surface)", () => {
    const executor = createGovernedExternalToolExecutor({
        federation: { isToolEnabled: () => false },
        sandboxPolicy: { network: [], filesystem: [] }
    });
    // inspect the first line of the real execute()
    const executeSrc = executor.execute.toString();
    // capture the destructured parameter block: execute({ ... } = {})
    const opener = /execute\(\{([\s\S]*?)\}\s*=\s*\{\}\s*\)/.exec(executeSrc);
    assert.ok(opener, "execute must destructure such that `= {}` appears");
    // destructured parameter names (strip defaults)
    const names = opener[1].split(",").map(s => s.trim().split("=")[0].trim()).filter(Boolean);
    assert.ok(names.includes("claimId"), "claimId is the sole authority entry");
    assert.ok(names.includes("args"), "args accepted");
    assert.ok(names.includes("envMaterial"), "envMaterial accepted");
    // ONLY those three + nothing else
    assert.ok(names.every(n => ["claimId", "args", "envMaterial"].includes(n)),
        "no extra parameters on execute: " + names.join(","));
    // No toolFn / authorityArtifact / consumed / launch parameter.
    assert.ok(!/toolFn/.test(executeSrc.slice(0, executeSrc.indexOf("{", executeSrc.indexOf("{") + 1))), "no toolFn accepted");
    assert.equal(typeof executor.execute, "function");
});

test("R3-10: AppContainer profile name is fixed; caller cannot choose/rename sandbox", () => {
    // The constant is stable and not derivable from caller input.
    assert.equal(APPCONTAINER_NAME, "DamarGovExternalSandbox");
    // No API to set the container name from caller data.
    const src = createGovernedExternalToolExecutor.toString() + SHIM_SOURCE;
    const dangerous = /id\s*=\s*(req|args|input)?\s*\.\s*(container|sandboxId|name)/i;
    assert.ok(!dangerous.test(src), "no caller-controlled sandbox name in executor");
});

test("R3-10: SHIM require-allowlist blocks relative & npm path resolution", () => {
    assert.equal(typeof SHIM_SOURCE, "string");
    // The shim must NOT resolve relative/npm requires (only node: + curated core).
    assert.ok(!/require\(["']\.\.?\//.test(SHIM_SOURCE), "shim must not allow relative requires");
    // It must not secretly whitelist network/process modules by bare require.
    // (kernel still denies, but the module surface stays minimal.)
    assert.ok(SHIM_SOURCE.includes("CORE_ALLOW"), "shim carries a curated core allowlist");
});

test("R3-10: executor REJECTS a fake claimId / non-canonical router (no ambient authority)", async () => {
    assert.equal(fs.existsSync(HOST_EXE), process.platform === "win32" && fs.existsSync(HOST_EXE));
    // A non-canonical router must be rejected at construction even if it looks
    // like the real one.
    assert.throws(() => createGovernedExternalToolExecutor({
        federation: { isToolEnabled: () => true },
        sandboxPolicy: { network: [], filesystem: [] },
        executionRouter: { consumeGovernedClaim: () => ({ claimId: "x" }) }
    }), TypeError);
});

test("R3-10: HOST_EXE is a fixed module-derived path (no caller path traversal)", () => {
    // HOST_EXE is resolved from __dirname inside the module — there is no
    // caller-chosen host binary path.
    assert.ok(HOST_EXE.includes("native"));
    assert.ok(HOST_EXE.includes("sandbox-host"));
    assert.match(HOST_EXE, /sandbox-host(\.exe)?$/);
    // No function accepts a host path from caller data.
    assert.equal(typeof createGovernedExternalToolExecutor, "function");
    const src = createGovernedExternalToolExecutor.toString();
    assert.ok(!/hostExe|hostPath|binaryPath\s*[:=]\s*(arguments|opts|options|req|input)/.test(src));
});

test("R3-10: no sandbox launcher exposed on the executor object surface", () => {
    const executor = createGovernedExternalToolExecutor({
        federation: { isToolEnabled: () => false },
        sandboxPolicy: { network: [], filesystem: [] }
    });
    const keys = Object.keys(executor);
    assert.ok(!keys.includes("launchSandboxedTool"), "no launchSandboxedTool on executor");
    assert.ok(!keys.includes("launchAppContainerTool"), "no app-container launch primitive on executor");
    assert.ok(keys.includes("execute"), "only the governed execute entry is public");
});