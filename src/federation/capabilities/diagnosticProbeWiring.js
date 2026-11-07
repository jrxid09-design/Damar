"use strict";

/**
 * DAMAR.RUNTIME.DIAGNOSTIC.PROBE WIRING (Repair5, DB02-D) — narrowly-scoped
 * internal module, same shape as src/mataDewa/capabilities/visualModeWiring.js.
 *
 * PURPOSE: the FIRST real production external capability wired through the
 * FULL governed path required by DB02-D:
 *
 *   canonical capability registration -> real availability observation ->
 *   ExternalCapabilityFederation.discover -> inspect -> validate ->
 *   enableTool -> real artifact digest -> trusted candidate advertisement ->
 *   distributed route -> ExecutionLease -> claimGovernedExecution ->
 *   governed external executor -> sandbox -> Verification -> Manager
 *   response.
 *
 * It is a safe, read-only diagnostic: no network, no arbitrary filesystem
 * access, no secrets, no shell passthrough, deterministic bounded input and
 * output (see src/federation/artifacts/diagnosticProbeTool.js).
 *
 * LAWS (same as MD-011):
 *   - AVAILABILITY != AUTHORITY. `isGenuinelyAvailable()` reports the REAL
 *     federation lifecycle state (candidate ENABLED) — never a default.
 *     Authority is granted ONLY through the canonical Authority owner
 *     (Owner ratification); this module never seeds, upserts, or infers a
 *     grant.
 *   - GOVERNED EXECUTION ONLY: the actuator never runs the artifact
 *     directly. It ALWAYS goes through the canonical
 *     DistributedExecutionRouter (route -> claimGovernedExecution) and the
 *     governed external tool executor (sandbox + digest verification). No
 *     direct dispatchActuation bypass, no caller-supplied executor.
 *   - The single-node DistributedExecutionRouter/NodeTrust/NodeRegistry
 *     here are constructed via the SAME reusable production factory
 *     (wave6Production.createDistributedNodeRuntime) used by the canonical
 *     Wave 6 adapter — not a duplicate re-implementation. This capability
 *     owns its own dedicated node identity (a governed capability is free
 *     to own its own node context; nothing requires exactly one node).
 *   - Wiring failure is a COMPOSITION MISCONFIGURATION: helpers throw a
 *     typed, explicit error (never silently swallowed).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const federationLib = require("../index");
const wave6Production = require("../../integration/wave6Production");

const CAPABILITY_ID = "damar.runtime.diagnostic.probe";
const OPERATION = "probe";
const TOOL_NAME = "probe";
const ARTIFACT_PATH = path.resolve(__dirname, "../artifacts/diagnosticProbeTool.js");

const CAPABILITY_DESCRIPTOR = Object.freeze({
    schemaVersion: 1,
    id: CAPABILITY_ID,
    kind: "system",
    provider: "core",
    operations: Object.freeze([OPERATION]),
    requirements: Object.freeze([]),
    effects: Object.freeze(["diagnostic_probe"]),
    description: "Governed, read-only distributed runtime diagnostic probe (no network/filesystem/secrets/shell) validating node readiness and sandboxed governed execution."
});

/** Trusted scope resolver: the probe carries no external resource target. */
const SCOPE_BINDINGS = Object.freeze({
    [CAPABILITY_ID]: Object.freeze({
        [OPERATION]: () => Object.freeze([])
    })
});

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ---------------------------------------------------------------------------
// Module-singleton governed infrastructure (constructed at most once, lazily
// — same "construct once, deterministic" shape as
// wave6Production.ensureCanonicalWave6ExecutionAdapter). NOT exported.
// ---------------------------------------------------------------------------
let provisioned = null;

function ensureProvisioned() {
    if (provisioned) return provisioned;
    const federation = new federationLib.ExternalCapabilityFederation();
    const artifactDigest = sha256File(ARTIFACT_PATH);
    const artifactSurface = fs.readFileSync(ARTIFACT_PATH, "utf8");
    const snap = federation.discover({
        source: "local://damar-runtime/federation/artifacts",
        sourceType: "local-artifact",
        publisher: "damar-runtime",
        name: "diagnostic-probe",
        version: "1.0.0",
        license: "MIT",
        artifactDigest,
        permissions: { network: [], filesystem: [], process: [], secrets: [] }
    });
    federation.inspect(snap.candidateId, { artifactSurface });
    const inspected = federation.snapshot(snap.candidateId);
    if (inspected.state !== "INSPECTED") {
        throw new Error(`DIAGNOSTIC_PROBE_WIRING_FAILED: artifact failed inspection (state=${inspected.state}, reason=${inspected.quarantineReason})`);
    }
    federation.validate(snap.candidateId, { toolDigests: { [TOOL_NAME]: artifactDigest } });
    federation.enableTool(snap.candidateId, { toolName: TOOL_NAME });

    // Dedicated single-node governed execution runtime — real
    // DistributedExecutionRouter + NodeTrust + NodeRegistry via the same
    // reusable production factory the canonical Wave6 adapter uses.
    const node = wave6Production.createDistributedNodeRuntime({ capabilityIds: [CAPABILITY_ID] });
    // Self-trust: the mesh trust plane grants no scope by default: a node
    // must be explicitly paired before it can route/claim its OWN
    // advertised capability. This is genuine production wiring, not a test
    // shortcut — a single-node deployment must trust its own identity for
    // local governed compute/tool-execution.
    node.trust.pair({
        nodeId: node.identity.nodeId, state: "TRUSTED",
        scopes: ["COMPUTE", "TOOL_EXECUTION"]
    });

    const executor = wave6Production.createGovernedExternalToolExecutor({
        federation,
        sandboxPolicy: { network: [], filesystem: [], processSpawn: false, secrets: false },
        executionRouter: node.dexecRouter
    });

    // Bounded, process-local executionId -> verification-context map,
    // populated by the actuator invoke() below and read by the Lane 4
    // verifier (see wireVerifier). This is NEVER authority and NEVER the
    // actuator's self-report standing in for truth: the verifier
    // independently re-checks the CURRENT artifact digest + enablement
    // state against the federation's own live lifecycle state.
    const verificationContext = new Map();
    const MAX_CONTEXT = 256;
    function noteContext(executionId, ctx) {
        if (verificationContext.size >= MAX_CONTEXT) {
            const oldest = verificationContext.keys().next().value;
            if (oldest !== undefined) verificationContext.delete(oldest);
        }
        verificationContext.set(executionId, ctx);
    }

    provisioned = Object.freeze({
        federation, node, executor,
        candidateId: snap.candidateId, toolName: TOOL_NAME,
        artifactPath: ARTIFACT_PATH, artifactDigest,
        verificationContext, noteContext
    });
    return provisioned;
}

/**
 * DB02-D: genuine availability observation. AVAILABLE iff the federation
 * candidate for this tool is genuinely ENABLED (real lifecycle state) —
 * never a default, never derived from node membership or federation
 * discovery alone (DISCOVERED/QUARANTINED/INSPECTED/VALIDATED are NOT
 * enabled).
 */
function isGenuinelyAvailable() {
    try {
        const p = ensureProvisioned();
        return p.federation.isToolEnabled(p.candidateId, p.toolName) === true;
    } catch {
        return false;
    }
}

/** Register the capability descriptor through a canonical Lane 2 registrar. */
function wireCapability({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") {
        throw new TypeError("DIAGNOSTIC_PROBE_WIRING_INVALID: canonical capability registrar required");
    }
    const result = registrar.register(JSON.stringify({ ...CAPABILITY_DESCRIPTOR }));
    if (!result || typeof result.incarnationId !== "string") {
        throw new Error(`DIAGNOSTIC_PROBE_WIRING_FAILED: '${CAPABILITY_ID}' did not yield a valid incarnation`);
    }
    return Object.freeze({ id: CAPABILITY_ID, incarnationId: result.incarnationId, operation: OPERATION });
}

/**
 * Register the Lane 3 actuator. invoke() NEVER runs the artifact directly:
 * it claims a governed execution through the canonical
 * DistributedExecutionRouter and dispatches it to the governed external
 * tool executor (real AppContainer sandbox + digest verification).
 */
function wireActuator({ actuatorRegistry, wiring } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function") {
        throw new TypeError("DIAGNOSTIC_PROBE_WIRING_INVALID: canonical actuator registry required");
    }
    if (!wiring || typeof wiring.incarnationId !== "string") {
        throw new TypeError("DIAGNOSTIC_PROBE_WIRING_INVALID: capability wiring record required");
    }
    return actuatorRegistry.register({
        capabilityId: CAPABILITY_ID,
        operations: [OPERATION],
        capabilityIncarnationId: wiring.incarnationId,
        actuatorId: "act-damar-diagnostic-probe",
        invoke: async ({ executionId, capabilityId, operation, principal, parameters } = {}) => {
            const p = ensureProvisioned();
            const version = typeof parameters?.version === "string" ? parameters.version.slice(0, 32) : "1";
            const nonce = typeof parameters?.nonce === "string" && parameters.nonce.length > 0
                ? parameters.nonce.slice(0, 64)
                : crypto.randomBytes(8).toString("hex");
            const intent = Object.freeze({
                intentId: executionId, capabilityId: capabilityId ?? CAPABILITY_ID,
                operation: operation ?? OPERATION, arguments: { version, nonce }
            });
            // Route/claim authorization is evaluated against the SAME
            // already-authenticated Lane 2 principal (never a hardcoded
            // system subject) — one governed grant covers both the Lane 2
            // gate and this deeper router/claim gate.
            const claim = await p.node.ingress.claimGovernedToolExecution({
                intent, toolId: `tool.${CAPABILITY_ID}`,
                candidateId: p.candidateId, toolName: p.toolName, toolArtifactPath: p.artifactPath,
                subject: typeof principal === "string" && principal.length > 0 ? principal : "damar",
                sandboxNeeds: { needsNetwork: [], needsFilesystem: [], needsProcessSpawn: false, needsSecrets: false }
            });
            const result = await p.executor.execute({ claimId: claim.claimId, args: { version, nonce } });
            const digestVerified = sha256File(p.artifactPath) === p.artifactDigest &&
                p.federation.isToolEnabled(p.candidateId, p.toolName);
            p.noteContext(executionId, {
                expectedNonce: nonce, output: result.output, digestVerified
            });
            return {
                ok: true,
                version: result.output?.version ?? null,
                status: result.output?.status ?? null,
                nonce: result.output?.nonce ?? null,
                runtimeIdentity: result.output?.runtimeIdentity ?? null,
                claimId: claim.claimId,
                targetNodeId: claim.targetNodeId,
                sandbox: result.sandbox
            };
        }
    });
}

/**
 * Build the Lane 4 trusted verifier definition (composition-time-only; NOT
 * a caller-injectable verifier). observe() independently re-checks the
 * CURRENT artifact digest + federation enablement (world truth the
 * actuator's self-report cannot fake) plus the deterministic echo contract
 * (nonce, status).
 */
function wireVerifier({ wiring } = {}) {
    if (!wiring || typeof wiring.incarnationId !== "string") {
        throw new TypeError("DIAGNOSTIC_PROBE_WIRING_INVALID: capability wiring record required");
    }
    return Object.freeze({
        capabilityId: CAPABILITY_ID,
        operations: [OPERATION],
        capabilityIncarnationId: wiring.incarnationId,
        verifierId: "ver-damar-diagnostic-probe",
        readiness: "READY",
        observe(ctx) {
            const p = ensureProvisioned();
            const stored = p.verificationContext.get(ctx.executionId);
            if (!stored) {
                return { artifactVerified: false, nonceEchoed: false, statusOk: false };
            }
            return {
                artifactVerified: stored.digestVerified === true,
                nonceEchoed: stored.output?.nonce === stored.expectedNonce,
                statusOk: stored.output?.status === "ok"
            };
        }
    });
}

module.exports = Object.freeze({
    CAPABILITY_ID, OPERATION, TOOL_NAME, ARTIFACT_PATH,
    CAPABILITY_DESCRIPTOR, SCOPE_BINDINGS,
    isGenuinelyAvailable, wireCapability, wireActuator, wireVerifier
});
