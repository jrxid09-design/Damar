"use strict";

/**
 * W6-R3-02 — AppContainer sandbox RUNTIME CONSTANTS (inert).
 *
 * This module intentionally exports ONLY inert configuration constant(s):
 * the AppContainer profile name and the path to the native launch helper.
 * It does NOT export any launch primitive. The governed executor in
 * src/integration/wave6Production.js owns the ONLY launch path
 * (closure-private). There is no importable "launchSandboxedTool" anywhere
 * (R3-03).
 *
 * The untrusted external tool runs inside a Windows AppContainer with ZERO
 * package capabilities and LOW integrity. Raw TCP/UDP/DNS (loopback 127.0.0.1,
 * localhost, ::1, LAN, public IP, DNS) is DENIED BY THE WINDOWS KERNEL
 * (WFP AppContainer enforcement). Node --permission has NO network
 * enforcement (proven) and is not the isolation boundary.
 *
 * SECURITY POSTURE: there is NO fallback. If the native helper is missing, or
 * the platform is not Windows with AppContainer support, governed external
 * execution FAILS CLOSED (the executor rejects; it never downgrades to a
 * non-isolating sandbox).
 */

const path = require("node:path");

const APPCONTAINER_NAME = "DamarGovExternalSandbox";
const HOST_EXE = path.resolve(__dirname, "..", "..", "native", "sandbox-host", "sandbox-host.exe");

module.exports = Object.freeze({
    APPCONTAINER_NAME,
    HOST_EXE,
    // NO launch function is exported here. R3-03: the launch primitive is
    // closure-private inside createGovernedExternalToolExecutor.
});