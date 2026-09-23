"use strict";

/**
 * W8-IW1 — ADB CAPABILITY FAMILY (Manager-owned execution ownership).
 *
 * Android tools are INGRESS, NEVER AUTHORITY. This module is the only place
 * that starts an ADB process for the android cluster: `src/android/adb.js`
 * holds no `child_process` require and no `execFile`/`spawn` call. Every ADB
 * operation is a capability and must pass authority first:
 *
 *   android tool call
 *     -> Manager-owned request                (this module)
 *     -> authority (src/authority/evaluate.js::loadAndEvaluateAuthority)
 *     -> exact capability + exact operation
 *     -> canonicalCapabilityExecution bridge
 *     -> composition-registered driver (execFile adb, argv array)
 *     -> Verification
 *     -> Audit + durable acknowledgement
 *     -> canonical completion
 *
 * Laws honoured here:
 *   TOOL != AUTHORITY
 *   MODEL-SUPPLIED COMMAND != ACTION INTENT
 *   CAPABILITY REGISTERED != AUTHORITY
 *   MIGRATION != AUTHORIZATION
 *   VALID HMAC != EXECUTION AUTHORITY
 *
 * OWNER DECISION (recorded): migrated families stay DENY-UNTIL-RATIFIED.
 * Nothing here mints, infers, bootstraps or auto-ratifies a grant. Unratified,
 * the driver is never entered and zero ADB process is started.
 *
 * Device identity, operation and parameters are bound into the request digest
 * by the canonical bridge (principal + scope + parameters), so a grant for one
 * device or one operation cannot be replayed as another.
 */

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const pexec = promisify(execFile);

const CAPABILITY_ID = "android.adb";
const ADB_BIN = process.env.DAMAR_ADB_BIN || "adb";
const OPTS = Object.freeze({ timeout: 30000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

/** One operation per physical effect. Shell text is a parameter of `shell`,
 *  never a way to reach a different capability. */
const OPERATIONS = Object.freeze([
    "devices", "connect", "shell", "tap", "swipe", "key", "text",
    "openApp", "listApps", "screenshot", "notifications", "info"
]);

const CATALOGUE = Object.freeze({
    [CAPABILITY_ID]: Object.freeze({
        family: "android",
        consequence: "process-execution+device-control",
        mutating: true,
        rationale: "Drives a physical Android device over ADB (tap, type, shell, screenshot, connect). Device identity and command are bound per request.",
        operations: OPERATIONS
    })
});

const runtimeGate = new WeakSet();

function adbArgs(serial, rest) {
    return serial ? ["-s", serial, ...rest] : rest;
}

/** Resolve the target serial WITHOUT starting a consequential command.
 *  An explicit serial is the caller's binding. With none given, the only ready
 *  device is selected and handed back so the caller can authorize THAT device
 *  before anything consequential runs. Ambiguity fails closed. */
async function resolveSerial(exec, serial) {
    if (typeof serial === "string" && serial.trim() !== "") return serial.trim();
    const { stdout } = await exec(ADB_BIN, ["devices", "-l"], OPTS);
    const ready = String(stdout || "").split(/\r?\n/).slice(1)
        .map(line => line.trim()).filter(Boolean)
        .map(line => line.match(/^(\S+)\s+(\S+)/))
        .filter(match => match && match[2] === "device")
        .map(match => match[1]);
    if (ready.length === 1) return ready[0];
    if (ready.length === 0) throw new Error("NO_DEVICE");
    throw new Error("AMBIGUOUS_DEVICE");
}

function shellCommand(operation, parameters) {
    const p = parameters || {};
    switch (operation) {
        case "shell": return String(p.command ?? "");
        case "tap": return `input tap ${Number(p.x)} ${Number(p.y)}`;
        case "swipe": return `input swipe ${+p.x1} ${+p.y1} ${+p.x2} ${+p.y2} ${+(p.ms ?? 300)}`;
        case "key": return `input keyevent ${String(p.keycode ?? "").replace(/[^A-Z0-9_]/gi, "")}`;
        case "text": {
            const safe = String(p.text ?? "").replace(/(["\\$`'()&|;<>* ])/g, m => (m === " " ? "%s" : "\\" + m));
            return `input text "${safe}"`;
        }
        case "openApp":
            return `monkey -p ${String(p.package ?? "").replace(/[^\w.]/g, "")} -c android.intent.category.LAUNCHER 1`;
        case "listApps": {
            const filter = p.filter ? ` | grep -i ${String(p.filter).replace(/[^\w.]/g, "")}` : "";
            return "pm list packages" + filter;
        }
        case "notifications":
            return "dumpsys notification --noredact | grep -E 'tickerText|android.title|android.text' | head -40";
        case "info":
            return "getprop ro.product.model; getprop ro.build.version.release; wm size; wm density";
        default: return null;
    }
}

/** Caller-input validation BEFORE authority and before any process. A
 *  malformed request is not an action to authorize. */
function parameterProblem(operation, parameters) {
    const p = parameters && typeof parameters === "object" ? parameters : {};
    const serial = p.serial;
    if (serial !== undefined && serial !== null && (typeof serial !== "string" || /[\s;|&`$<>]/.test(serial))) {
        return "SERIAL_MALFORMED";
    }
    switch (operation) {
        case "connect":
            if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(String(p.address ?? ""))) return "ADDRESS_MALFORMED";
            return null;
        case "shell":
            if (typeof p.command !== "string" || p.command.trim() === "") return "COMMAND_MALFORMED";
            return null;
        case "tap":
            if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return "COORDINATE_MALFORMED";
            return null;
        case "swipe":
            if (![p.x1, p.y1, p.x2, p.y2].every(n => Number.isFinite(Number(n)))) return "COORDINATE_MALFORMED";
            return null;
        case "key":
            if (!/^[A-Z0-9_]+$/i.test(String(p.keycode ?? ""))) return "KEYCODE_MALFORMED";
            return null;
        case "text":
            if (typeof p.text !== "string") return "TEXT_MALFORMED";
            return null;
        case "openApp":
            if (!/^[\w.]+$/.test(String(p.package ?? ""))) return "PACKAGE_MALFORMED";
            return null;
        case "screenshot":
        case "devices":
        case "listApps":
        case "notifications":
        case "info":
            return null;
        default:
            return "OPERATION_UNBOUND";
    }
}

function realDrivers(exec) {
    const run = exec || pexec;

    async function runShell(operation, parameters) {
        const serial = await resolveSerial(run, parameters.serial ?? null);
        const command = shellCommand(operation, parameters);
        const timeout = Number.isFinite(parameters.timeout) ? parameters.timeout : undefined;
        const { stdout, stderr } = await run(ADB_BIN, adbArgs(serial, ["shell", command]),
            { ...OPTS, ...(timeout ? { timeout } : {}) });
        const output = String(stdout || stderr || "");
        if (operation === "listApps") {
            const packages = output.split(/\r?\n/).map(l => l.replace(/^package:/, "").trim()).filter(Boolean);
            return { ok: true, serial, count: packages.length, packages: packages.slice(0, 200) };
        }
        return { ok: true, serial, output: output.slice(-8000) };
    }

    return {
        devices: async () => {
            const { stdout } = await run(ADB_BIN, ["devices", "-l"], OPTS);
            const devices = String(stdout || "").split(/\r?\n/).slice(1)
                .map(l => l.trim()).filter(Boolean)
                .map(l => {
                    const m = l.match(/^(\S+)\s+(\S+)(.*)$/);
                    if (!m) return null;
                    return { serial: m[1], state: m[2], model: (m[3].match(/model:(\S+)/) || [])[1] || null };
                })
                .filter(Boolean);
            return { ok: true, devices, count: devices.length };
        },
        connect: async ({ parameters }) => {
            const address = String(parameters.address).replace(/[^\d.:]/g, "");
            const { stdout, stderr } = await run(ADB_BIN, ["connect", address], OPTS);
            const output = String(stdout || stderr || "").trim();
            return { ok: /connected|already/i.test(output), output };
        },
        screenshot: async ({ parameters }) => {
            const serial = await resolveSerial(run, parameters.serial ?? null);
            const file = parameters.out || path.join(process.env.TEMP || ".", `android-${Date.now()}.png`);
            const { stdout } = await run(ADB_BIN, adbArgs(serial, ["exec-out", "screencap", "-p"]),
                { ...OPTS, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
            require("node:fs").writeFileSync(file, stdout);
            return { ok: true, serial, file };
        },
        shell: ({ parameters }) => runShell("shell", parameters),
        tap: ({ parameters }) => runShell("tap", parameters),
        swipe: ({ parameters }) => runShell("swipe", parameters),
        key: ({ parameters }) => runShell("key", parameters),
        text: ({ parameters }) => runShell("text", parameters),
        openApp: ({ parameters }) => runShell("openApp", parameters),
        listApps: ({ parameters }) => runShell("listApps", parameters),
        notifications: ({ parameters }) => runShell("notifications", parameters),
        info: ({ parameters }) => runShell("info", parameters)
    };
}

function verifier() {
    return async (_parameters, result) => ({
        checks: [
            { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
            { name: "driver-reported-no-failure", passed: !(result && result.ok === false) }
        ]
    });
}

function createAdbCapabilityRuntime({
    authorityStore = null,
    acknowledge = null,
    driverOverrides = null,
    replayStore = null,
    execFileImpl = null
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
            capabilityId,
            operation,
            consequential: true,
            driverId: `android.adb.${operation}`,
            driver: async (ctx) => {
                invocations.set(operation, (invocations.get(operation) ?? 0) + 1);
                return driver(ctx);
            }
        });
    }
    bridge.registerVerifier(capabilityId, verifier());

    // The device a request actually drives must be inside the grant's scope.
    // The caller does not get to name a scope that disagrees with parameters.serial:
    // a grant for device:DEV1 authorizes DEV1 and nothing else.
    function grantedDevices(grantedScope) {
        return (Array.isArray(grantedScope) ? grantedScope : []).filter(s => typeof s === "string" && s.startsWith("device:"));
    }

    function deviceScope(operation, parameters, requestedScope, grantedScope) {
        const declared = Array.isArray(requestedScope) ? requestedScope.filter(s => typeof s === "string") : [];
        if (operation === "devices" || operation === "connect") return declared;
        const serial = typeof parameters?.serial === "string" ? parameters.serial.trim() : "";
        // No serial: the device is chosen later from what is plugged in, so the
        // grant must already name exactly one device and the request may not name a
        // different one. Anything else fails closed.
        if (serial === "") {
            const granted = grantedDevices(grantedScope);
            if (granted.length !== 1) return ["device:UNSPECIFIED"];
            if (declared.some(s => s.startsWith("device:") && s !== granted[0])) return ["device:CONTRADICTED"];
            return declared.length === 0 ? granted : declared;
        }
        const token = `device:${serial}`;
        const named = declared.filter(s => s.startsWith("device:"));
        // No declared device: the driven device is the whole scope.
        if (named.length === 0) return [token];
        // The declared device IS the driven device: submit it unchanged.
        if (named.length === 1 && named[0] === token) return declared;
        // Otherwise the caller named one device and drives another. No honest
        // scope represents both, so the request carries a token no grant has.
        return ["device:CONTRADICTED"];
    }

    async function authorize({ identity = {}, scope = [], nowMs = Date.now() } = {}) {
        if (authorityStore === null || authorityStore === undefined) {
            return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_UNAVAILABLE", evaluation: null };
        }
        let evaluation;
        try {
            evaluation = await loadAndEvaluateAuthority(authorityStore, {
                capabilityId, action: "execute", scope, identity, nowMs
            });
        } catch (error) {
            return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_ERROR", detail: String(error?.message ?? ""), evaluation: null };
        }
        if (evaluation?.allowed !== true) {
            return { allowed: false, state: STATE.AVAILABLE_BUT_NOT_AUTHORIZED, reason: String(evaluation?.reasonCode ?? "DENIED"), evaluation: null };
        }
        return { allowed: true, state: STATE.AUTHORIZED, reason: "AUTHORIZED", evaluation };
    }

    const runtime = {
        async execute({ operation, parameters = {}, requestId, identity = {}, scope = [], nowMs = Date.now(), signal = null } = {}) {
            if (!OPERATIONS.includes(operation)) {
                return { outcome: OUTCOME.REFUSED, reason: "OPERATION_UNBOUND", capabilityId, operation };
            }
            const problem = parameterProblem(operation, parameters);
            if (problem) return { outcome: OUTCOME.REFUSED, reason: problem, capabilityId, operation };
            let grant = null;
            if (authorityStore) { try { grant = await authorityStore.getCapability(capabilityId); } catch { grant = null; } }
            const boundScope = deviceScope(operation, parameters, scope, grant?.payload?.scope ?? []);
            const granted = grantedDevices(grant?.payload?.scope ?? []);
            const serial = typeof parameters?.serial === "string" ? parameters.serial.trim() : "";
            // The grant names exactly one device and the caller named none, so that
            // device is the target. Stamped in before the driver, which otherwise
            // would discover a device on its own.
            const boundParameters = serial === "" && granted.length === 1 && !["devices", "connect"].includes(operation)
                ? { ...parameters, serial: granted[0].slice("device:".length) }
                : parameters;
            const auth = await authorize({ identity, scope: boundScope, nowMs });
            if (!auth.allowed) {
                return {
                    ok: false, denied: true, outcome: OUTCOME.DENIED, state: auth.state,
                    ownerRatificationRequired: auth.state === STATE.OWNER_RATIFICATION_REQUIRED,
                    capabilityId, operation, reason: auth.reason, detail: auth.detail ?? null
                };
            }
            return bridge.execute({ capabilityId, operation, parameters: boundParameters, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount(operation) {
            return operation ? (invocations.get(operation) ?? 0) : [...invocations.values()].reduce((n, c) => n + c, 0);
        },
        ratificationProposal({ principal = "owner", scope = [] } = {}) {
            const body = {
                capabilityId, family: "android", operations: [...OPERATIONS],
                consequenceClass: CATALOGUE[CAPABILITY_ID].consequence, mutating: true,
                requestedScope: scope, principal, rationale: CATALOGUE[CAPABILITY_ID].rationale,
                status: "UNSIGNED_NOT_ACTIVE"
            };
            return Object.freeze({
                kind: "OWNER_RATIFICATION_PROPOSAL", status: "UNSIGNED_NOT_ACTIVE",
                note: "Proposal only. PROPOSAL != GRANT.",
                proposalDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
                ...body
            });
        }
    };
    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;

function installAdbCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("ADB capability runtime was not created by this module");
    if (installed !== null) throw new Error("ADB capability runtime already installed");
    installed = runtime;
    return true;
}

function adbRuntime() {
    if (installed === null) installed = createAdbCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}

function isAdbCapabilityRuntime(runtime) { return runtimeGate.has(runtime); }

module.exports = {
    CAPABILITY_ID, OPERATIONS, STATE, CATALOGUE,
    createAdbCapabilityRuntime, installAdbCapabilityRuntime, adbRuntime, isAdbCapabilityRuntime,
    parameterProblem, shellCommand
};
