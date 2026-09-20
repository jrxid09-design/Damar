"use strict";

/**
 * W8-IW1 — CLI CAPABILITY FAMILY (Manager-owned execution ownership).
 *
 * The CLI is INGRESS, NEVER AUTHORITY. This module is the only place in the CLI
 * cluster that spawns a process: `src/cli/index.js` holds no `child_process`
 * require and no `spawn` call. Consequential CLI operations are requested as
 * capabilities and must pass authority first:
 *
 *   CLI parse
 *     -> Manager-owned request                (this module)
 *     -> authority (src/authority/evaluate.js::loadAndEvaluateAuthority)
 *     -> exact capability + exact operation
 *     -> canonicalCapabilityExecution bridge
 *     -> composition-registered driver (spawn)
 *     -> Verification
 *     -> Audit + durable acknowledgement
 *     -> canonical completion
 *
 * Laws honoured here:
 *   CLI PARSE != AUTHORITY
 *   SHELL COMMAND != ACTION INTENT
 *   CAPABILITY REGISTERED != AUTHORITY
 *   EXECUTOR != OWNER AUTHORITY
 *
 * OWNER DECISION (recorded): migrated families stay DENY-UNTIL-RATIFIED. Nothing
 * here mints, infers, bootstraps or auto-ratifies a grant. Unratified, the driver
 * is never entered and zero process is started.
 *
 * Scope note: the operator's own product bootstrap is unaffected by this gating —
 * `npm start` runs src/server.js directly and `npm run damar` runs the
 * launcher (scripts/launch.js), neither of which passes through the CLI. What is
 * gated here is the CLI's own convenience paths (`damar console`, `damar --serve`)
 * and its SSH tunnel to a caller-supplied host.
 */

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const {
    CanonicalCapabilityExecution,
    OUTCOME
} = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");

const ROOT = path.join(__dirname, "..", "..");

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

/**
 * Declarative capability catalogue. Operation-level and minimal; the SSH tunnel
 * (remote egress to a caller-supplied host) is never folded into the local
 * daemon start.
 */
const CATALOGUE = Object.freeze({
    "cli.daemon.start": {
        family: "cli",
        consequence: "process-execution",
        mutating: false,
        rationale: "Starts the Damar daemon (port 3001) or the launcher for the desktop console. Operator bootstrap task requested from CLI ingress.",
        operations: ["serve", "console"],
        verifier: "ok-flag"
    },
    "cli.ssh.tunnel": {
        family: "cli",
        consequence: "process-execution+network-egress",
        mutating: false,
        rationale: "Spawns ssh -N -L to a caller-supplied user@host: remote network reach from CLI ingress.",
        operations: ["open"],
        verifier: "port-flag"
    }
});

/** Real drivers. `driverOverrides` (composition-time only) may replace a driver
 *  implementation; it can never change capability identity, authority,
 *  verification or audit, so it is not a caller seam. */
function realDrivers() {
    return {
        serve: async ({ parameters }) => {
            const child = spawn(process.execPath, [
                path.join(ROOT, "src", "server.js"), "--role", "cli"
            ], { stdio: "inherit" });
            child.on("exit", code => { process.exitCode = code ?? 0; });
            return { ok: true, pid: child.pid ?? null, operation: "serve", parameters };
        },
        console: async ({ parameters }) => {
            const argv = [path.join(ROOT, "scripts", "launch.js"), "--console"];
            const options = {
                cwd: ROOT,
                stdio: "inherit",
                env: { ...process.env, DAMAR_ROLE: "console" }
            };
            const child = process.platform === "win32"
                ? spawn(process.execPath, argv, options)
                : spawn("node", argv, options);
            child.on("exit", code => { process.exitCode = code ?? 0; });
            return { ok: true, pid: child.pid ?? null, operation: "console", parameters };
        },

        /** Parse user@host[:remotePort], pick a free local port, open the tunnel
         *  and wait until it is actually usable. */
        "ssh-tunnel": async ({ parameters }) => {
            const match = String(parameters?.target ?? "").match(/^(?:([^@]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/);
            if (!match) return { ok: false, error: "TARGET_MALFORMED" };

            const [, user, host, remotePort = "3000"] = match;
            const localPort = await new Promise(resolve => {
                const srv = net.createServer();
                srv.listen(0, "127.0.0.1", () => {
                    const port = srv.address().port;
                    srv.close(() => resolve(port));
                });
            });

            const sshTarget = user ? `${user}@${host}` : host;
            const child = spawn("ssh", [
                "-N",
                "-o", "ExitOnForwardFailure=yes",
                "-o", "ServerAliveInterval=30",
                "-L", `${localPort}:127.0.0.1:${remotePort}`,
                sshTarget
            ], { stdio: ["ignore", "inherit", "inherit"] });

            const ready = await new Promise(resolve => {
                let tries = 0;
                const attempt = () => {
                    tries++;
                    const sock = net.connect(localPort, "127.0.0.1");
                    sock.once("connect", () => { sock.destroy(); resolve(true); });
                    sock.once("error", () => {
                        sock.destroy();
                        if (tries > 40) resolve(false);
                        else setTimeout(attempt, 500);
                    });
                };
                setTimeout(attempt, 600);
            });

            if (!ready) {
                try { child.kill(); } catch { /* already gone */ }
                return { ok: false, error: "TUNNEL_NOT_READY" };
            }

            tunnels.add(child);
            child.on("exit", () => tunnels.delete(child));
            return { ok: true, localPort, sshTarget };
        }
    };
}

const tunnels = new Set();

/** capability|operation -> real driver key. Explicit, so the SSH tunnel (remote
 *  egress) can never be confused with the local daemon start. */
const DRIVER_KEY = Object.freeze({
    "cli.daemon.start": Object.freeze({ serve: "serve", console: "console" }),
    "cli.ssh.tunnel": Object.freeze({ open: "ssh-tunnel" })
});

function driverReportVerifier(expects) {
    return async (_parameters, result) => {
        const checks = [{
            name: "driver-returned-result",
            passed: result !== undefined && result !== null
        }];
        checks.push({
            name: "driver-reported-no-failure",
            passed: !(result && typeof result === "object" && (result.ok === false || result.error))
        });
        if (expects === "port-flag") {
            checks.push({
                name: "tunnel-local-port-established",
                passed: typeof result?.localPort === "number" && result.localPort > 0
            });
        }
        return { checks };
    };
}

const runtimeGate = new WeakSet();

function createCliCapabilityRuntime({
    authorityStore = null,
    acknowledge = null,
    driverOverrides = null,
    replayStore = null,
    requireRollbackResistance = true
} = {}) {

    const bridge = new CanonicalCapabilityExecution({ replayStore, requireRollbackResistance });
    const drivers = realDrivers();
    const invocations = new Map();

    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    for (const [rawId, spec] of Object.entries(CATALOGUE)) {
        const capabilityId = canonicalCapabilityId(rawId);
        for (const operation of spec.operations) {
            const override = driverOverrides?.[rawId]?.[operation];
            const real = drivers[DRIVER_KEY[rawId][operation]];
            const driver = typeof override === "function" ? override : real;
            if (typeof driver !== "function") {
                throw new Error(`no driver for ${rawId}|${operation}`);
            }
            bridge.registerCapability({
                capabilityId,
                operation,
                consequential: true,
                driverId: `cli.${rawId}.${operation}`,
                driver: async ({ parameters }) => {
                    invocations.set(capabilityId, (invocations.get(capabilityId) ?? 0) + 1);
                    return driver({ parameters });
                }
            });
        }
        bridge.registerVerifier(capabilityId, driverReportVerifier(spec.verifier));
    }

    async function authorizationFor(capabilityId, { identity = {}, nowMs = Date.now() } = {}) {
        if (authorityStore === null || authorityStore === undefined) {
            return {
                allowed: false,
                state: STATE.OWNER_RATIFICATION_REQUIRED,
                reasonCode: "AUTHORITY_UNAVAILABLE",
                evaluation: null
            };
        }
        let evaluation;
        try {
            evaluation = await loadAndEvaluateAuthority(authorityStore, {
                capabilityId, action: "execute", scope: [], identity, nowMs
            });
        }
        catch (error) {
            return {
                allowed: false,
                state: STATE.OWNER_RATIFICATION_REQUIRED,
                reasonCode: "AUTHORITY_ERROR",
                detail: String(error?.message ?? ""),
                evaluation: null
            };
        }
        if (evaluation?.allowed !== true) {
            return {
                allowed: false,
                state: STATE.AVAILABLE_BUT_NOT_AUTHORIZED,
                reasonCode: String(evaluation?.reasonCode ?? "DENIED"),
                detail: evaluation?.detail ?? null,
                evaluation: null
            };
        }
        return { allowed: true, state: STATE.AUTHORIZED, reasonCode: "AUTHORIZED", evaluation };
    }

    function denial(capabilityId, operation, auth) {
        return {
            ok: false,
            denied: true,
            outcome: OUTCOME.DENIED,
            state: auth.state,
            ownerRatificationRequired: auth.state === STATE.OWNER_RATIFICATION_REQUIRED,
            capabilityId,
            operation,
            reason: auth.reasonCode,
            detail: auth.detail ?? null,
            note: "Capability registered but not owner-authorized; no process was started."
        };
    }

    const runtime = {
        state: "composed",

        async availability({ identity = {} } = {}) {
            const out = {};
            for (const [rawId, spec] of Object.entries(CATALOGUE)) {
                const capabilityId = canonicalCapabilityId(rawId);
                const auth = await authorizationFor(capabilityId, { identity });
                out[capabilityId] = {
                    state: auth.state,
                    reasonCode: auth.reasonCode,
                    operations: spec.operations,
                    consequence: spec.consequence
                };
            }
            return out;
        },

        async execute({ capabilityId, operation, parameters = {}, requestId, identity = {} } = {}) {
            const id = canonicalCapabilityId(capabilityId);
            const spec = CATALOGUE[id];
            if (!spec || !spec.operations.includes(operation)) {
                return { outcome: OUTCOME.REFUSED, reason: "CAPABILITY_UNBOUND", capabilityId: id, operation };
            }
            // Caller-input validation strictly BEFORE authority and before any
            // effect: a malformed target is a malformed request, not an action to
            // authorize (and never a reason to start a process).
            if (id === "cli.ssh.tunnel" && operation === "open") {
                const target = String(parameters?.target ?? "");
                if (!/^(?:([^@]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?$/.test(target) || !target) {
                    return { outcome: OUTCOME.REFUSED, reason: "TARGET_MALFORMED", capabilityId: id, operation };
                }
            }
            const auth = await authorizationFor(id, { identity });
            if (!auth.allowed) return denial(id, operation, auth);
            const result = await bridge.execute({
                capabilityId: id,
                operation,
                parameters,
                evaluation: auth.evaluation,
                requestId
            });
            // Canonical result, returned verbatim (same shape as the coding
            // family): the caller reads `result.result` for driver data and can
            // always see outcome/verification/receipt. A non-verified outcome is
            // never dressed up as success.
            return result;
        },

        invocationCount(capabilityId) {
            return invocations.get(canonicalCapabilityId(capabilityId)) ?? 0;
        },

        /** Close every tunnel this runtime opened (lifecycle, not authority). */
        closeTunnels() {
            let closed = 0;
            for (const child of tunnels) {
                try { child.kill(); closed++; } catch { /* already gone */ }
                tunnels.delete(child);
            }
            return closed;
        },

        /** OWNER RATIFICATION BUNDLE — proposal only, unsigned, inactive. */
        ratificationProposal({ principal = "owner", scope = [] } = {}) {
            const proposals = Object.entries(CATALOGUE).map(([rawId, spec]) => {
                const capabilityId = canonicalCapabilityId(rawId);
                const body = {
                    capabilityId,
                    family: spec.family,
                    operations: spec.operations,
                    consequenceClass: spec.consequence,
                    mutating: spec.mutating,
                    requestedScope: scope,
                    principal,
                    rationale: spec.rationale,
                    recommendedExpiry: "90d",
                    recommendedRevocation: "owner-signed revocation; generation bump invalidates outstanding grants"
                };
                return {
                    ...body,
                    proposalDigest: require("node:crypto").createHash("sha256")
                        .update(JSON.stringify({ ...body, operations: [...body.operations].sort() }))
                        .digest("hex")
                };
            });
            return Object.freeze({
                kind: "OWNER_RATIFICATION_PROPOSAL",
                status: "UNSIGNED_NOT_ACTIVE",
                note: "Proposal only. PROPOSAL != GRANT. This bundle cannot and does not authorize anything.",
                family: "cli",
                proposals: Object.freeze(proposals)
            });
        }
    };

    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;

function installCliCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) {
        throw new TypeError("CLI capability runtime was not created by this module");
    }
    if (installed !== null) throw new Error("CLI capability runtime already installed");
    installed = runtime;
    return true;
}

function cliRuntime() {
    if (installed === null) installed = createCliCapabilityRuntime({});
    return installed;
}

module.exports = {
    createCliCapabilityRuntime,
    installCliCapabilityRuntime,
    cliRuntime,
    CATALOGUE,
    STATE
};
