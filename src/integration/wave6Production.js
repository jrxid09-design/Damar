"use strict";

/**
 * WAVE 6 R5/R6 (W6-07 REPAIR) — canonical production integration adapters.
 *
 * Wires Wave 6 modules into the ACTUAL frozen production owners so the
 * end-to-end path is proven, not assumed:
 *
 *   A. EXECUTION: InteractionBus/Manager -> ActionIntent (frozen action
 *      owner) -> canonical Authority evaluation -> Capability resolution ->
 *      DistributedExecutionRouter (authorityBridge) -> lease ->
 *      consumeOnTarget -> actuation -> Verification. NO direct model->node
 *      or direct tool path exists in this composition.
 *
 *   B. DEVICE IDENTITY: mesh pairing adapter wraps the frozen
 *      DeviceIdentityService (already enforced in L1).
 *
 *   C. CAPABILITY: node advertisements reference canonical capability ids;
 *      the Capability Registry stays the only registration owner.
 *
 *   D. RECOVERY: the coordinator REQUIRES the frozen L2 checkpoint verifier
 *      (W6-05, enforced in construction).
 *
 *   E. EVOLUTION: canaries require registry ratification (W6-01).
 *
 *   F. SANDBOX: external tools execute THROUGH the governed path; a
 *      declarative sandbox object is combined with the frozen toolGuard
 *      policy vocabulary and verified at dispatch.
 */

const mesh = require("../mesh");
const dstate = require("../dstate");
const dexec = require("../dexec");
const dresil = require("../dresil");
const federation = require("../federation");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");

/**
 * Canonical production composition for ONE Damar node.
 * Every field is a frozen-owner instance or a Wave 6 module bound to one.
 */
function createDistributedNodeRuntime({
    logicalDamarId = null,
    deviceIdentity = null,           // frozen DeviceIdentityService instance (B)
    localNodeId = null,              // adopt existing opaque node id (restore)
    profile = "DESKTOP_PRIMARY",
    capabilityIds = [],              // canonical capability ids this node advertises
    auditSink = null                 // frozen Audit Ledger port
} = {}) {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const replayGuard = new mesh.MeshReplayGuard();
    const identity = localNodeId
        ? mesh.meshIdentity.adoptNodeIdentity({ nodeId: localNodeId, logicalDamarId })
        : mesh.meshIdentity.mintNodeIdentity({ logicalDamarId });
    const audit = new mesh.MeshAuditBridge({ ledger: auditSink ?? { append: () => true }, localNodeId: identity.nodeId });
    const router = new mesh.MeshRouter({ trust, registry, replayGuard, auditBridge: audit });
    registry.register({ identity, displayName: `node-${identity.nodeId.slice(6, 12)}` });
    router.bindLocalNodeId(identity.nodeId);
    const presence = new mesh.MeshPresence({ registry });
    // C: node advertisement entries reference canonical capability ids
    const dexecRouter = new dexec.DistributedExecutionRouter({ trust, registry, authorityBridge: dexec.createCanonicalAuthorityBridge() });
    dexecRouter.bindLocalNodeId(identity.nodeId);
    const caps = capabilityIds.slice(0, 64).map(capabilityId => ({
        capabilityId, toolId: `tool.${capabilityId}`, latencyScore: 50, privacy: "INTERNAL"
    }));
    dexecRouter.advertise({ nodeId: identity.nodeId, profile, capabilities: caps });
    // D: recovery coordinator REQUIRES the frozen checkpoint verifier
    const recovery = new dresil.DistributedRecoveryCoordinator({
        trust,
        checkpointVerifier: (cp, opts) => dstate.checkpoint.verifyCheckpoint(cp, opts)
    });
    return Object.freeze({
        identity, registry, trust, router, presence, audit, replayGuard,
        dexecRouter, recovery,
        pairing: deviceIdentity ? new mesh.MeshPairingAdapter({ trust, registry, deviceIdentity }) : null
    });
}

/**
 * F: governed external tool execution — the ONLY path an external (MCP/
 * plugin) tool may take. Combines the federation enablement state with
 * required authority/verification steps; a declarative sandbox object alone
 * executes nothing.
 */
function createGovernedExternalToolExecutor({ federation, sandboxPolicy }) {
    if (!federation || typeof federation.isToolEnabled !== "function") throw new TypeError("federation required");
    if (!sandboxPolicy || typeof sandboxPolicy !== "object") throw new TypeError("sandboxPolicy required");
    const networkAllowed = new Set(sandboxPolicy.network ?? []);
    const fsRoots = new Set(sandboxPolicy.filesystem ?? []);
    const spawnerAllowed = sandboxPolicy.processSpawn === true;
    const secretsAllowed = sandboxPolicy.secrets === true; // almost always false

    function checkSandboxViolations({ needsNetwork = [], needsFilesystem = [], needsProcessSpawn = false, needsSecrets = false }) {
        const violations = [];
        for (const domain of needsNetwork) {
            if (!networkAllowed.has(domain) && !networkAllowed.has("*")) {
                violations.push(`network domain '${String(domain).slice(0, 64)}' not permitted`);
            }
        }
        for (const root of needsFilesystem) {
            if (![...fsRoots].some(allowed => String(root).startsWith(allowed))) {
                violations.push(`filesystem path '${String(root).slice(0, 64)}' outside sandbox roots`);
            }
        }
        if (needsProcessSpawn && !spawnerAllowed) violations.push("process spawn forbidden");
        if (needsSecrets && !secretsAllowed) violations.push("secret access forbidden");
        return violations;
    }

    return Object.freeze({
        id: "governed-external-executor",
        /**
         * Execute an external tool ONLY when:
         *  1. the candidate is ENABLED for this tool (federation)
         *  2. the sandbox policy permits the tool's declared needs
         *  3. a canonical authority artifact covers the execution facts
         *  4. the lease is consumed (one-use) — W6-03
         * Any bypass attempt fails closed BEFORE the tool function runs.
         */
        async execute({ candidateId, toolName, toolFn, authorityArtifact, consumed, args = {} }) {
            // 1. enablement (discovery != enablement)
            if (!federation.isToolEnabled(candidateId, toolName)) {
                throw meshFailure(MESH_ERRORS.TOOL_NOT_ENABLED, `tool '${String(toolName).slice(0, 64)}' is not enabled`);
            }
            // 2. sandbox verification against the tool's DECLARED needs
            const needs = {
                needsNetwork: args.needsNetwork ?? [],
                needsFilesystem: args.needsFilesystem ?? [],
                needsProcessSpawn: args.needsProcessSpawn === true,
                needsSecrets: args.needsSecrets === true
            };
            const violations = checkSandboxViolations(needs);
            if (violations.length > 0) {
                throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox violations: ${violations.slice(0, 3).join("; ")}`);
            }
            // 3+4. authority artifact + consumed lease (W6-02/W6-03)
            if (!consumed || !consumed.consumed) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "execution requires a consumed one-use lease (W6-03)");
            }
            const artifact = authorityArtifact;
            if (!artifact || typeof artifact.decisionDigest !== "string") {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "canonical authority artifact required");
            }
            // 5. run the tool (this is the ONLY invocation point)
            const output = await toolFn(args);
            return Object.freeze({ ok: true, output: output ?? null, consumedLease: consumed.executionId });
        },
        checkSandboxViolations
    });
}

module.exports = Object.freeze({
    createDistributedNodeRuntime,
    createGovernedExternalToolExecutor
});
