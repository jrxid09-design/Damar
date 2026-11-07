"use strict";

/**
 * damar.runtime.diagnostic.probe — REAL production external artifact
 * (Repair5, DB02-D). Runs ONLY inside the governed AppContainer sandbox
 * (src/federation/sandboxShim.js): no network, no filesystem, no process
 * spawn, no secrets, no shell passthrough. Deterministic, bounded input and
 * output — a safe diagnostic used to validate governed distributed
 * execution, node readiness, and recovery diagnostics. NOT test-only: this
 * is the artifact the production ExternalCapabilityFederation lifecycle
 * discovers/inspects/validates/enables (see
 * src/federation/capabilities/diagnosticProbeWiring.js).
 */
module.exports = function diagnosticProbe(args) {
    const version = typeof args?.version === "string" ? args.version.slice(0, 32) : "";
    const nonce = typeof args?.nonce === "string" ? args.nonce.slice(0, 64) : "";
    if (!/^[0-9a-zA-Z._-]{1,32}$/.test(version)) {
        throw new Error("INVALID_VERSION: version must be 1-32 bounded chars");
    }
    if (!/^[0-9a-f]{1,64}$/i.test(nonce)) {
        throw new Error("INVALID_NONCE: nonce must be 1-64 bounded hex chars");
    }
    return {
        version,
        status: "ok",
        nonce,
        runtimeIdentity: "damar-runtime-diagnostic-probe/1"
    };
};
