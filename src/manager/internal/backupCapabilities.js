"use strict";

/**
 * W8-IW1 — BACKUP CAPABILITY (Manager-owned execution ownership).
 *
 * backupService is INGRESS, NEVER AUTHORITY. This module is the only place
 * that runs robocopy or rsync. A copy is a capability request and must pass
 * authority first. The command and its flags are fixed; the only caller input
 * is the two paths, and each must be an absolute path with no newline, so a
 * path cannot smuggle an extra argument.
 *
 * Deny-until-ratified: with no owner grant, nothing is copied.
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const CAPABILITY_ID = "backup.copy";
const OPERATION = "copy";

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

const runtimeGate = new WeakSet();

function readParameters(parameters) {
    const p = parameters && typeof parameters === "object" ? parameters : {};
    const source = typeof p.source === "string" ? p.source : "";
    const dest = typeof p.dest === "string" ? p.dest : "";
    // A drive or a UNC share only. path.isAbsolute("/MIR") is true on
    // Windows, and robocopy would read that argument as a switch.
    const ok = v => path.isAbsolute(v) && !/[\r\n]/.test(v)
        && (process.platform === "win32"
            ? /^[A-Za-z]:[\\/]/.test(v) || /^\\\\[^\\]/.test(v)
            : v.startsWith("/") && !v.includes("\0"));
    if (!ok(source) || !ok(dest)) return "PATH_MALFORMED";
    return { source, dest };
}

function realDriver(spawnImpl) {
    const spawnFn = spawnImpl || spawn;
    return async ({ parameters }) => {
        const win = process.platform === "win32";
        const cmd = win ? "robocopy" : "rsync";
        const args = win
            ? [parameters.source, parameters.dest, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP"]
            : ["-a", parameters.source, parameters.dest];
        const code = await new Promise((resolve, reject) => {
            const child = spawnFn(cmd, args, { windowsHide: true });
            child.on("error", reject);
            child.on("close", resolve);
        });
        const ok = win ? code < 8 : code === 0;
        return { ok, code };
    };
}

function createBackupCapabilityRuntime({
    authorityStore = null, acknowledge = null, driverOverrides = null,
    replayStore = null, spawnImpl = null
} = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore });
    const invocations = { n: 0 };
    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    const capabilityId = canonicalCapabilityId(CAPABILITY_ID);
    const driver = typeof driverOverrides === "function" ? driverOverrides : realDriver(spawnImpl);
    bridge.registerCapability({
        capabilityId, operation: OPERATION, consequential: true, driverId: "backup.copy",
        driver: async ctx => { invocations.n += 1; return driver(ctx); }
    });
    bridge.registerVerifier(capabilityId, async (_p, result) => ({
        checks: [
            { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
            { name: "copy-succeeded", passed: result?.ok === true }
        ]
    }));

    async function authorize({ identity = {}, scope = [], nowMs = Date.now() } = {}) {
        if (!authorityStore) return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_UNAVAILABLE" };
        try {
            const evaluation = await loadAndEvaluateAuthority(authorityStore, { capabilityId, action: "execute", scope, identity, nowMs });
            return evaluation?.allowed === true
                ? { allowed: true, state: STATE.AUTHORIZED, evaluation }
                : { allowed: false, state: STATE.AVAILABLE_BUT_NOT_AUTHORIZED, reason: evaluation?.reasonCode ?? "DENIED" };
        } catch (error) {
            return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_ERROR", detail: error.message };
        }
    }

    const runtime = {
        async execute({ operation = OPERATION, parameters = {}, requestId, identity = {}, scope = [], nowMs = Date.now(), signal = null } = {}) {
            if (operation !== OPERATION) return { outcome: OUTCOME.REFUSED, reason: "OPERATION_UNBOUND", capabilityId, operation };
            const snap = readParameters(parameters);
            if (typeof snap === "string") return { outcome: OUTCOME.REFUSED, reason: snap, capabilityId, operation };
            const auth = await authorize({ identity, scope, nowMs });
            if (!auth.allowed) return { ok: false, denied: true, outcome: OUTCOME.DENIED, state: auth.state, capabilityId, operation, reason: auth.reason };
            return bridge.execute({ capabilityId, operation, parameters: snap, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount() { return invocations.n; },
        ratificationProposal() {
            const body = { capabilityId, operation: OPERATION, status: "UNSIGNED_NOT_ACTIVE" };
            return Object.freeze({ ...body, proposalDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") });
        }
    };
    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;
function installBackupCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("backup capability runtime was not created by this module");
    if (installed !== null) throw new Error("backup capability runtime already installed");
    installed = runtime;
    return true;
}
function backupRuntime() {
    if (installed === null) installed = createBackupCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}

module.exports = { CAPABILITY_ID, OPERATION, STATE, createBackupCapabilityRuntime, installBackupCapabilityRuntime, backupRuntime };
