"use strict";

/**
 * W8-IW1 — DESKTOP CONTROL CAPABILITY (Manager-owned execution ownership).
 *
 * desktopControlService is INGRESS, NEVER AUTHORITY. This module is the only
 * place that starts PowerShell for desktop control. Every action is a
 * capability request and must pass authority first.
 *
 * The PowerShell is a fixed script per operation. Caller values are passed as
 * data through an environment variable, never interpolated into the command, so
 * a quote or a semicolon in a window title cannot become code.
 *
 * Deny-until-ratified: with no owner grant, no PowerShell starts.
 */

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const pexec = promisify(execFile);

const CAPABILITY_ID = "desktop.control";
const OPERATIONS = Object.freeze(["openApp", "typeText", "pressKey", "listWindows", "moveMouse", "click"]);

/** Applications the owner can ratify opening. A request names one of these,
 *  never an executable path. */
const APPS = Object.freeze({
    notepad: "notepad.exe",
    calculator: "calc.exe",
    browser: "msedge.exe",
    explorer: "explorer.exe",
    terminal: "wt.exe"
});

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

const runtimeGate = new WeakSet();

/** Read every caller field once. Numbers are checked here; strings are only
 *  bounded, because they travel as data and never enter the script text. */
function readParameters(operation, parameters) {
    const p = parameters && typeof parameters === "object" ? parameters : {};
    const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
    switch (operation) {
        case "openApp": {
            const app = str(p.app, 40);
            if (!Object.hasOwn(APPS, app)) return "APP_UNKNOWN";
            return { app };
        }
        case "typeText": {
            const text = str(p.text, 2000);
            if (!text) return "TEXT_EMPTY";
            return { text };
        }
        case "pressKey": {
            const key = str(p.key, 40).trim();
            if (!/^[\w^+%{}()[\]]+$/.test(key)) return "KEY_MALFORMED";
            return { key };
        }
        case "listWindows":
            return {};
        case "moveMouse":
        case "click": {
            const x = Number(p.x), y = Number(p.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return "COORDINATE_MALFORMED";
            return { x: Math.round(x), y: Math.round(y), button: ["left", "right", "middle"].includes(p.button) ? p.button : "left" };
        }
        default:
            return "OPERATION_UNBOUND";
    }
}

/** One fixed script per operation. It reads its input from the environment, so
 *  the script text never contains a caller value. */
const SCRIPTS = Object.freeze({
    openApp: "Start-Process $env:DAMAR_DESKTOP_EXE; 'ok'",
    typeText: "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:DAMAR_DESKTOP_TEXT); 'ok'",
    pressKey: "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:DAMAR_DESKTOP_KEY); 'ok'",
    listWindows: "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 25 ProcessName,MainWindowTitle | ConvertTo-Json -Compress",
    moveMouse: "$s='[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y);'; $m=Add-Type -MemberDefinition $s -Name Mv -Namespace Win -PassThru; [Win.Mv]::SetCursorPos([int]$env:DAMAR_DESKTOP_X,[int]$env:DAMAR_DESKTOP_Y) | Out-Null; 'ok'",
    click: "$s='[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);'; $m=Add-Type -MemberDefinition $s -Name Mc -Namespace Win -PassThru; [Win.Mc]::SetCursorPos([int]$env:DAMAR_DESKTOP_X,[int]$env:DAMAR_DESKTOP_Y) | Out-Null; [Win.Mc]::mouse_event([uint]$env:DAMAR_DESKTOP_DOWN,0,0,0,0); [Win.Mc]::mouse_event([uint]$env:DAMAR_DESKTOP_UP,0,0,0,0); 'ok'"
});

const CLICK = Object.freeze({ left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] });

function envFor(operation, parameters) {
    const env = { ...process.env };
    if (operation === "openApp") env.DAMAR_DESKTOP_EXE = APPS[parameters.app];
    if (operation === "typeText") env.DAMAR_DESKTOP_TEXT = parameters.text;
    if (operation === "pressKey") env.DAMAR_DESKTOP_KEY = parameters.key;
    if (operation === "moveMouse" || operation === "click") { env.DAMAR_DESKTOP_X = String(parameters.x); env.DAMAR_DESKTOP_Y = String(parameters.y); }
    if (operation === "click") { const [down, up] = CLICK[parameters.button]; env.DAMAR_DESKTOP_DOWN = String(down); env.DAMAR_DESKTOP_UP = String(up); }
    return env;
}

function realDrivers(execFileImpl) {
    const exec = execFileImpl || pexec;
    const run = operation => async ({ parameters }) => {
        const { stdout } = await exec("powershell",
            ["-NoProfile", "-NonInteractive", "-Command", SCRIPTS[operation]],
            { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, env: envFor(operation, parameters) });
        const output = String(stdout ?? "").trim();
        return operation === "listWindows" ? { ok: true, windows: output } : { ok: output === "ok" };
    };
    return Object.fromEntries(OPERATIONS.map(operation => [operation, run(operation)]));
}

function createDesktopCapabilityRuntime({
    authorityStore = null, acknowledge = null, driverOverrides = null,
    replayStore = null, execFileImpl = null
} = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore });
    const drivers = realDrivers(execFileImpl);
    const invocations = new Map();
    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    const capabilityId = canonicalCapabilityId(CAPABILITY_ID);
    for (const operation of OPERATIONS) {
        const override = driverOverrides?.[operation];
        const driver = typeof override === "function" ? override : drivers[operation];
        bridge.registerCapability({
            capabilityId, operation, consequential: true, driverId: `desktop.control.${operation}`,
            driver: async ctx => { invocations.set(operation, (invocations.get(operation) ?? 0) + 1); return driver(ctx); }
        });
    }
    bridge.registerVerifier(capabilityId, async (_p, result) => ({
        checks: [
            { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
            { name: "driver-reported-no-failure", passed: !(result && result.ok === false) }
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
        async execute({ operation, parameters = {}, requestId, identity = {}, scope = [], nowMs = Date.now(), signal = null } = {}) {
            if (!OPERATIONS.includes(operation)) return { outcome: OUTCOME.REFUSED, reason: "OPERATION_UNBOUND", capabilityId, operation };
            const snap = readParameters(operation, parameters);
            if (typeof snap === "string") return { outcome: OUTCOME.REFUSED, reason: snap, capabilityId, operation };
            const auth = await authorize({ identity, scope, nowMs });
            if (!auth.allowed) return { ok: false, denied: true, outcome: OUTCOME.DENIED, state: auth.state, capabilityId, operation, reason: auth.reason };
            return bridge.execute({ capabilityId, operation, parameters: snap, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount(operation) { return operation ? (invocations.get(operation) ?? 0) : [...invocations.values()].reduce((n, c) => n + c, 0); },
        ratificationProposal() {
            const body = { capabilityId, operations: [...OPERATIONS], status: "UNSIGNED_NOT_ACTIVE" };
            return Object.freeze({ ...body, proposalDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") });
        }
    };
    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;
function installDesktopCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("desktop capability runtime was not created by this module");
    if (installed !== null) throw new Error("desktop capability runtime already installed");
    installed = runtime;
    return true;
}
function desktopRuntime() {
    if (installed === null) installed = createDesktopCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}

module.exports = { CAPABILITY_ID, OPERATIONS, STATE, createDesktopCapabilityRuntime, installDesktopCapabilityRuntime, desktopRuntime };
