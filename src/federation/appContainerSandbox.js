"use strict";

/**
 * W6-R4-02 — AppContainer sandbox RUNTIME PROVISIONING (composition-owned).
 *
 * This module exports the AppContainer profile name, the path to the native
 * launch helper, AND a provisioning primitive `ensureSandboxRuntimeReady()`.
 *
 * PROVISIONING MODEL
 *   `ensureSandboxRuntimeReady` is the ONLY sanctioned way to make the
 *   AppContainer runtime available. It is:
 *     - COMPOSITION-OWNED: intended to be invoked by the runtime composition
 *       closure (and tests) — never exposed through the RuntimeHost facade.
 *     - IDEMPOTENT: deriving an existing profile is a no-op; concurrent
 *       callers coalesce through a single-flight promise.
 *     - BOUNDED: a hard wall-clock budget; a hung helper fails closed instead
 *       of blocking a caller forever.
 *     - FAIL-CLOSED: missing helper / non-Windows / helper error / tamper →
 *       throws; execution with the sandbox disabled is never returned.
 *     - TAMPER-DETECTING: the helper binary's SHA-256 is compared against the
 *       value recorded in the R4-02 manifest. If the binary changed since it
 *       was frozen, provisioning rejects (a modified host is not trusted).
 *
 * The native `--ensure` mode guarantees the profile exists and carries ZERO
 * package capabilities (network is then kernel-denied via WFP — loopback,
 * LAN, public, and DNS are all refused).
 *
 * SECURITY POSTURE: there is NO fallback. If provisioning fails, governed
 * external execution FAILS CLOSED (the executor rejects; it never downgrades
 * to a non-isolating sandbox).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const APPCONTAINER_NAME = "DamarGovExternalSandbox";
const HOST_EXE = path.resolve(__dirname, "..", "..", "native", "sandbox-host", "sandbox-host.exe");

// R4-02: frozen helper binary digest. Rebuilds re-record this value via the
// provisioning manifest check; a binary that differs from this exact digest is
// treated as tampered/untrusted and provisioning fails closed.
const SANDBOX_HOST_DIGEST = "b199a4f10dd18332b1248b9e34f494d9bed7dee02530737ffadd4b320921e5e0";

const PROVISION_TIMEOUT_MS = 30_000;

// ---- single-flight state -------------------------------------------------
let inflight = null;
let lastResult = null;

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Provision the AppContainer sandbox runtime. Resolves with a frozen
 * { ready, mechanism, sandboxId } when the profile exists with zero
 * capabilities; rejects FAIL-CLOSED otherwise.
 *
 * Notes:
 *  - On non-Windows the helper cannot run; rejects (never a non-isolating
 *    fallback).
 *  - Concurrent callers share one probe.
 *  - A manipulated `sandbox-host.exe` (digest mismatch) rejects.
 */
async function ensureSandboxRuntimeReady({
    appContainerName = APPCONTAINER_NAME,
    helperPath = HOST_EXE,
    timeoutMs = PROVISION_TIMEOUT_MS,
    skipDigest = false
} = {}) {
    // Composition-owned configuration only; refuse degenerate callers.
    if (typeof appContainerName !== "string" || appContainerName.length === 0) {
        throw new Error("SANDBOX_PROVISION_ARGS: appContainerName required");
    }
    if (typeof helperPath !== "string" || helperPath.length === 0) {
        throw new Error("SANDBOX_PROVISION_ARGS: helperPath required");
    }
    const useSkipDigest = skipDigest === true;

    if (inflight) return inflight;
    inflight = (async () => {
        if (process.platform !== "win32") {
            throw new Error("SANDBOX_UNSUPPORTED_PLATFORM: AppContainer requires Windows (R4-02)");
        }
        if (!fs.existsSync(helperPath)) {
            throw new Error("SANDBOX_PROVISION_MISSING_HELPER: " + helperPath);
        }
        // Tamper detection: the frozen helper binary must match the manifest
        // digest. Callers may opt out only in test compositions that freeze a
        // different helper build (tests never touch production Authority).
        if (!useSkipDigest) {
            const actual = sha256File(helperPath);
            if (SANDBOX_HOST_DIGEST !== actual) {
                throw new Error(
                    "SANDBOX_PROVISION_TAMPER: helper digest mismatch (binary differs from frozen manifest)");
            }
        }
        const result = await runEnsureProbe(helperPath, appContainerName, timeoutMs);
        lastResult = Object.freeze({
            ready: true,
            mechanism: "AppContainer",
            sandboxId: appContainerName,
            provisionedAtMs: Date.now()
        });
        return lastResult;
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

function runEnsureProbe(helperPath, appContainerName, timeoutMs) {
    return new Promise((resolve, reject) => {
        const args = ["--app-container", appContainerName, "--ensure"];
        const child = spawn(helperPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* best-effort */ }
            reject(Object.assign(new Error("SANDBOX_PROVISION_TIMEOUT: helper did not answer in bounds"), { code: "SANDBOX_PROVISION_TIMEOUT" }));
        }, timeoutMs);
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(Object.assign(new Error("SANDBOX_PROVISION_SPAWN: " + String(err.message).slice(0, 160)), { code: "SANDBOX_PROVISION_SPAWN" }));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                return resolve(true);
            }
            const tail = stderr.trim().slice(-200);
            if (code === 6) {
                return reject(Object.assign(new Error("SANDBOX_PROVISION_CAPS: profile carries unexpected capabilities: " + tail), { code: "SANDBOX_PROVISION_CAPS" }));
            }
            return reject(Object.assign(new Error("SANDBOX_PROVISION_FAILED: helper exit " + code + " " + tail), { code: "SANDBOX_PROVISION_FAILED" }));
        });
    });
}

/** Honest current provisioning status (no side effects). */
function sandboxProvisioningStatus() {
    if (process.platform !== "win32") return { ready: false, reason: "SANDBOX_UNSUPPORTED_PLATFORM" };
    if (!fs.existsSync(HOST_EXE)) return { ready: false, reason: "SANDBOX_PROVISION_MISSING_HELPER" };
    return {
        ready: Boolean(lastResult),
        cached: Boolean(lastResult),
        mechanism: "AppContainer",
        sandboxId: APPCONTAINER_NAME
    };
}

module.exports = Object.freeze({
    APPCONTAINER_NAME,
    HOST_EXE,
    SANDBOX_HOST_DIGEST,
    ensureSandboxRuntimeReady,
    sandboxProvisioningStatus
    // NOTE: NO launch function is exported here. The launch primitive is
    // closure-private inside createGovernedExternalToolExecutor (R3-03).
});