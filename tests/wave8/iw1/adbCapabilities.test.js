"use strict";

/**
 * W8-IW1 — ADB capability family, adversarial.
 *
 * Android tools are INGRESS, NEVER AUTHORITY. The physical ADB process is the
 * `execFileImpl` double below: if it is entered, a device was driven. Every
 * assertion below checks that double's call count, so removing the authority
 * gate, the digest binding or the replay reservation makes a test fail.
 */

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    createAdbCapabilityRuntime, STATE
} = require("../../../src/manager/internal/adbCapabilities.js");

function withSubstrate(opts = {}) {
    return createAdbCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

const ack = () => ({ ok: true, receipt: "adb-ack" });

function grantStore(grants) {
    const caps = new Map(grants.map(g => [g.capabilityId, g]));
    return {
        async getCapability(id) {
            const g = caps.get(id);
            if (!g) return null;
            return {
                capabilityId: id, status: g.status ?? "ACTIVE", generation: 0,
                payload: {
                    subject: "owner", capabilityId: id, kind: "root", actions: ["execute"],
                    scope: g.scope ?? [], allowedPurposes: [], restrictions: { kind: "unrestricted" },
                    maxExecutions: null, identityBinding: g.identityBinding ?? null,
                    notBefore: null, expiresAt: g.expiresAt ?? null, issuedAt: new Date().toISOString()
                }
            };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

/** The physical effect. `calls` grows only when a real ADB invocation happens. */
function execDouble(stdout = "ok\n") {
    const calls = [];
    const exec = async (bin, args) => { calls.push({ bin, args: [...args] }); return { stdout, stderr: "" }; };
    return { calls, exec };
}

const GRANT = [{ capabilityId: "android.adb" }];
const shell = (extra = {}) => ({ operation: "shell", parameters: { command: "input tap 1 1", serial: "DEV1" }, ...extra });

test("adb/structural: src/android holds no process spawn", () => {
    for (const file of ["adb.js", "tools.js"]) {
        const code = fs.readFileSync(path.join(__dirname, "../../../src/android", file), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        assert.equal(/child_process/.test(code), false, `${file} requires child_process`);
        assert.equal(/\b(execFile|spawn|exec|fork)\s*\(/.test(code), false, `${file} spawns`);
    }
});

test("adb/authority: no authority store starts zero ADB processes", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({ acknowledge: ack, execFileImpl: fx.exec });
    for (const operation of ["devices", "shell", "tap", "connect", "screenshot"]) {
        const result = await runtime.execute({ operation, parameters: { command: "id", address: "1.2.3.4:5555", x: 1, y: 1 } });
        assert.equal(result.denied, true, operation);
        assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
        assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    }
    assert.equal(fx.calls.length, 0);
    assert.equal(runtime.invocationCount(), 0);
});

test("adb/authority: a store without the grant denies and starts nothing", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({ authorityStore: grantStore([]), acknowledge: ack, execFileImpl: fx.exec });
    const result = await runtime.execute(shell());
    assert.equal(result.denied, true);
    assert.equal(result.reason, "CAP_NOT_FOUND");
    assert.equal(fx.calls.length, 0);
});

test("adb/authority: a ratified grant reaches adb exactly once, argv-array, bound to the device", async () => {
    const fx = execDouble("tapped\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const result = await runtime.execute(shell());
    assert.equal(result.outcome, "EXECUTED_VERIFIED", JSON.stringify(result));
    assert.equal(result.receipt, "adb-ack");
    assert.equal(fx.calls.length, 1);
    assert.deepEqual(fx.calls[0].args.slice(0, 3), ["-s", "DEV1", "shell"]);
    assert.equal(fx.calls[0].args[3], "input tap 1 1");
});

test("adb/authority: a forged result cannot be published as EXECUTED", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec,
        driverOverrides: { shell: async () => new (class FakeResult { ok = true; })() }
    });
    const result = await runtime.execute(shell());
    assert.equal(result.outcome, "UNVERIFIED");
    assert.match(result.reason, /MALFORMED_RESULT/);
    assert.equal(fx.calls.length, 0, "the override replaced the driver; the forged shape still is not success");
});

test("adb/authority: an unknown result shape fails closed", async () => {
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { shell: async () => Symbol("nope") }
    });
    const result = await runtime.execute(shell());
    assert.equal(result.outcome, "UNVERIFIED");
    assert.match(result.reason, /MALFORMED_RESULT/);
});

test("adb/binding: operation mismatch never starts a process", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const result = await runtime.execute({ operation: "format-disk", parameters: { command: "rm -rf /" } });
    assert.equal(result.outcome, "REFUSED");
    assert.equal(result.reason, "OPERATION_UNBOUND");
    assert.equal(fx.calls.length, 0);
});

test("adb/binding: a changed command is a different request, and a replay is not", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const first = await runtime.execute(shell());
    const replay = await runtime.execute(shell());
    assert.equal(first.outcome, "EXECUTED_VERIFIED");
    assert.equal(replay.outcome, "REFUSED");
    assert.equal(replay.reason, "REPLAY");
    assert.equal(fx.calls.length, 1, "replay duplicated the physical effect");

    const changed = await runtime.execute({ operation: "shell", parameters: { command: "input tap 9 9", serial: "DEV1" } });
    assert.equal(changed.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 2);
    assert.equal(fx.calls[1].args[3], "input tap 9 9");
});

test("adb/binding: principal and scope mismatch start nothing", async () => {
    const fx = execDouble();
    const bound = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", identityBinding: { principals: ["owner"] } }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    const intruder = await bound.execute({ ...shell(), identity: { principal: "intruder" } });
    assert.equal(intruder.denied, true);
    assert.equal(intruder.reason, "CAP_IDENTITY_MISMATCH");

    const scoped = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    // A caller-declared scope that contradicts the device it names is a mismatch,
    // whichever of the two the grant happens to allow.
    const contradicted = await scoped.execute({ ...shell(), scope: ["device:SOMEWHERE-ELSE"] });
    assert.equal(contradicted.outcome, "REFUSED");
    assert.equal(contradicted.reason, "DEVICE_CONTRADICTED");
    assert.equal(fx.calls.length, 0);
});

test("adb/binding: omitting the serial cannot widen a scoped grant", async () => {
    const fx = execDouble("ok\n");
    const one = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    // No serial and no declared scope: the grant names exactly one device, so the
    // request is bound to it and no device discovery is consulted.
    const implied = await one.execute({ operation: "shell", parameters: { command: "id" } });
    assert.equal(implied.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls[0].args[1], "DEV1");

    const many = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1", "device:DEV2"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    const vague = await many.execute({ operation: "shell", parameters: { command: "id" } });
    assert.equal(vague.denied, true);
    assert.equal(vague.reason, "CAP_SCOPE_MISMATCH");
    assert.equal(fx.calls.length, 1, "the ambiguous grant started nothing");
});

test("adb/binding: a grant for both devices still rejects a request that declares one and drives the other", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1", "device:DEV2"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    const contradicted = await runtime.execute({
        operation: "shell", parameters: { command: "id", serial: "DEV2" }, scope: ["device:DEV1"]
    });
    assert.equal(contradicted.outcome, "REFUSED");
    assert.equal(contradicted.reason, "DEVICE_CONTRADICTED");
    assert.equal(fx.calls.length, 0);

    const honest = await runtime.execute({
        operation: "shell", parameters: { command: "id", serial: "DEV2" }, scope: ["device:DEV2"]
    });
    assert.equal(honest.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].args[1], "DEV2");
});

test("adb/binding: mutating the request during authorization cannot retarget the device", async () => {
    const fx = execDouble("ok\n");
    const parameters = { command: "id", serial: "DEV1" };
    const store = grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1"] }]);
    const real = store.getCapability.bind(store);
    store.getCapability = async (id) => { parameters.serial = "DEV2"; return real(id); };
    const runtime = withSubstrate({ authorityStore: store, acknowledge: ack, execFileImpl: fx.exec });
    const result = await runtime.execute({ operation: "shell", parameters, scope: ["device:DEV1"] });
    assert.equal(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.at(-1).args[1], "DEV1", "the device authorized is the device driven");
});

test("adb/binding: a device token with no serial is not a device", async () => {
    const fx = execDouble("List of devices attached\nDEV2 device\n");
    const runtime = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    const result = await runtime.execute({ operation: "shell", parameters: { command: "id" }, scope: ["device:"] });
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 0, "an empty device token must not fall through to discovery");
});

test("adb/binding: an omitted serial plus a declared device is a contradiction, not a discovery", async () => {
    const fx = execDouble("List of devices attached\nDEV2 device\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    // The only plugged-in device is DEV2. Declaring DEV1 and naming no serial must
    // not fall through to discovery and drive DEV2, even under an unscoped grant.
    const result = await runtime.execute({
        operation: "shell", parameters: { command: "id" }, scope: ["device:DEV1"]
    });
    assert.equal(result.outcome, "REFUSED");
    assert.equal(result.reason, "DEVICE_CONTRADICTED");
    assert.equal(fx.calls.length, 0);
});

test("adb/binding: an unscoped grant still cannot drive a device the caller did not declare", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const contradicted = await runtime.execute({
        operation: "shell", parameters: { command: "id", serial: "DEV2" }, scope: ["device:DEV1"]
    });
    assert.equal(contradicted.outcome, "REFUSED");
    assert.equal(contradicted.reason, "DEVICE_CONTRADICTED");
    assert.equal(fx.calls.length, 0, "a contradiction is refused before any process, grant or not");
});

test("adb/binding: a grant for one device cannot drive another", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "android.adb", scope: ["device:DEV1"] }]),
        acknowledge: ack, execFileImpl: fx.exec
    });
    // The caller asserts the scope its grant satisfies while naming a different device.
    const stolen = await runtime.execute({
        operation: "shell", parameters: { command: "id", serial: "DEV2" }, scope: ["device:DEV1"]
    });
    assert.equal(stolen.outcome, "REFUSED");
    assert.equal(stolen.reason, "DEVICE_CONTRADICTED");

    const own = await runtime.execute({
        operation: "shell", parameters: { command: "id", serial: "DEV1" }, scope: ["device:DEV1"]
    });
    assert.equal(own.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].args[1], "DEV1");
});

test("adb/binding: device identity is part of the request, so a second device is not a replay", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    await runtime.execute(shell());
    const other = await runtime.execute({ operation: "shell", parameters: { command: "input tap 1 1", serial: "DEV2" } });
    assert.equal(other.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 2);
    assert.deepEqual(fx.calls.map(c => c.args[1]), ["DEV1", "DEV2"]);
});

test("adb/binding: a device selector cannot smuggle shell metacharacters", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    for (const serial of ["DEV1; rm -rf /", "DEV1 && id", "DEV1\nid", "DEV1|cat"]) {
        const result = await runtime.execute({ operation: "shell", parameters: { command: "id", serial } });
        assert.equal(result.outcome, "REFUSED", serial);
        assert.equal(result.reason, "SERIAL_MALFORMED");
    }
    assert.equal(fx.calls.length, 0);
});

test("adb/cancel: abort before invocation starts nothing", async () => {
    const fx = execDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const signal = { aborted: true };
    const result = await runtime.execute({ ...shell(), signal });
    assert.equal(result.outcome, "CANCELLED_BEFORE_EFFECT");
    assert.equal(result.effectInvoked, false);
    assert.equal(fx.calls.length, 0);
});

test("adb/cancel: abort after invocation stays ambiguous and is not success", async () => {
    let signal;
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: {
            shell: async () => { signal.aborted = true; return { ok: true, serial: "DEV1", output: "done" }; }
        }
    });
    signal = { aborted: false };
    const result = await runtime.execute({ ...shell(), signal });
    assert.equal(result.outcome, "AMBIGUOUS_AFTER_INVOCATION");
    assert.equal(result.effectInvoked, true);
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
});

test("adb/deadman: a driver that exceeds its deadline cannot become success", async () => {
    const fx = {
        calls: [],
        exec: async (bin, args) => {
            fx.calls.push({ bin, args });
            const e = new Error("timed out"); e.killed = true; throw e;
        }
    };
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, execFileImpl: fx.exec });
    const result = await runtime.execute({ operation: "shell", parameters: { command: "input tap 1 1", serial: "DEV1", timeout: 1 } });
    assert.equal(fx.calls.length, 1, "the process was started");
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(result.effectInvoked, true, "a killed process is an invoked effect, not a verified one");
    assert.equal(result.outcome, "FAILED");
});

test("adb/verify: a driver-reported failure cannot become success", async () => {
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { shell: async () => ({ ok: false, error: "device offline" }) }
    });
    const result = await runtime.execute(shell());
    assert.equal(result.outcome, "UNVERIFIED");
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
});

test("adb/audit: acknowledgement failure cannot become success", async () => {
    const fx = execDouble("ok\n");
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: () => ({ ok: false }), execFileImpl: fx.exec });
    const result = await runtime.execute(shell());
    assert.equal(result.outcome, "UNVERIFIED");
    assert.equal(result.reason, "AUDIT_NOT_ACKNOWLEDGED");
    assert.equal(fx.calls.length, 1, "the effect happened; success is still withheld");
});

test("adb/legacy: the production adapter cannot bypass the capability runtime", async () => {
    const adb = require("../../../src/android/adb.js");
    const result = await adb.shell("id", { serial: "DEV1" });
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(result.denied, true);
});
