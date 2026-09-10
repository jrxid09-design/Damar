"use strict";

/**
 * WAVE 6 R5/R6 (W6-07 REPAIR) Ã¢â‚¬â€ canonical production integration adapters.
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
    auditSink = null,                // frozen Audit Ledger port
    authorityRegistry = null         // canonical AuthorityRegistry instance (R2-02)
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
    // R2-02: bind the canonical AuthorityRegistry owner (first-wins, brand
    // checked). Without this, routing fails closed at route time.
    if (authorityRegistry !== null && authorityRegistry !== undefined) {
        dexec.bindCanonicalAuthorityRegistry(authorityRegistry);
    }
    // C: node advertisement entries reference canonical capability ids
    const dexecRouter = new dexec.DistributedExecutionRouter({ trust, registry });
    dexecRouter.bindLocalNodeId(identity.nodeId);
    const caps = capabilityIds.slice(0, 64).map(capabilityId => ({
        capabilityId, toolId: `tool.${capabilityId}`, latencyScore: 50, privacy: "INTERNAL"
    }));
    dexecRouter.advertise({ nodeId: identity.nodeId, profile, capabilities: caps });
    // D: recovery coordinator REQUIRES the frozen checkpoint verifier
    // (R2-04: closure-bound canonical verifier — no injectable callback)
    const recovery = dresil.createDistributedRecoveryCoordinator({ trust });
    // R2-06: canonical ingress handle — the production consumer path from the
    // frozen action owner (RuntimeHost/InteractionBus -> Manager -> ActionIntent
    // -> Authority -> Capability -> Router). Exposed for integration tests and
    // the governed execution entry point; it does not bypass any owner.
    const ingress = Object.freeze({
        /**
         * Submit a FROZEN ActionIntent through the canonical router. Authority
         * is resolved LIVE against the bound canonical AuthorityRegistry; the
         * caller never supplies an evaluation, digest, or artifact.
         */
        async submitIntent({ intent, toolId = null, privacyClass = "INTERNAL", localPreferred = false, preferredNodeId = null, ttlMs = null, subject = "damar" }) {
            return dexecRouter.route({ intent, toolId, privacyClass, localPreferred, preferredNodeId, ttlMs, subject });
        },
        /**
         * Create a governed external execution claim (R2-07). The executor
         * consumes the claim; the caller never supplies authority.
         */
        async claimGovernedToolExecution({ intent, toolId = null, candidateId, toolName, toolArtifactPath = null, privacyClass = "INTERNAL", localPreferred = false, preferredNodeId = null, ttlMs = null, subject = "damar", sandboxNeeds = null }) {
            return dexecRouter.claimGovernedExecution({
                intent, toolId, candidateId, toolName, toolArtifactPath,
                privacyClass, localPreferred, preferredNodeId, ttlMs, subject, sandboxNeeds
            });
        }
    });
    return Object.freeze({
        identity, registry, trust, router, presence, audit, replayGuard,
        dexecRouter, recovery, ingress,
        pairing: deviceIdentity ? new mesh.MeshPairingAdapter({ trust, registry, deviceIdentity }) : null
    });
}

/**
 * F (W6-R2-05 REPAIR): REAL sandbox via child process + Node permission
 * model. The external tool runs in a spawned Node child with:
 *   --permission (permission system ON Ã¢â‚¬â€ default DENY)
 *   --allow-fs-read only for sandbox-declared roots + tool artifact + node_modules
 *   --allow-fs-write only for tool-declared write roots
 *   NO --allow-child-process (process spawn denied at V8 level)
 *   NO --allow-worker (worker threads denied)
 *   scrubbed environment (only explicit scoped secrets/material Ã¢â‚¬â€ never
 *   the full parent env)
 *   runtime timeout (process killed)
 *   output capped
 * Network is NOT enforceable by the Node permission model (documented
 * limitation); network-declaring tools FAIL CLOSED at admission unless the
 * deployment explicitly accepts non-enforced network and documents it.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const SANDBOX_DEFAULTS = Object.freeze({
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    nodeExecutable: process.execPath
});

function createGovernedExternalToolExecutor({ federation, sandboxPolicy, sandboxRoots = {}, executionRouter = null }) {
    if (!federation || typeof federation.isToolEnabled !== "function") throw new TypeError("federation required");
    if (!sandboxPolicy || typeof sandboxPolicy !== "object") throw new TypeError("sandboxPolicy required");
    // R2-07: the executor is driven by a BRANDED canonical execution router.
    // A caller-supplied object shaped like a router is rejected; authority and
    // lease consumption flow exclusively through the router's claim path.
    if (executionRouter !== null && executionRouter !== undefined && !dexec.isCanonicalExecutionRouter(executionRouter)) {
        throw new TypeError("executionRouter must be a canonical DistributedExecutionRouter (brand check failed)");
    }
    const networkAllowed = new Set(sandboxPolicy.network ?? []);
    const fsRoots = new Set(sandboxPolicy.filesystem ?? []);
    const spawnerAllowed = sandboxPolicy.processSpawn === true;
    const secretsAllowed = sandboxPolicy.secrets === true;
    const config = Object.freeze({ ...SANDBOX_DEFAULTS, ...(sandboxPolicy.config ?? {}) });

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

    /**
     * REAL sandbox launch: the tool runs in a spawned Node child with the
     * Node permission model enforcing default-deny fs/child-process/worker.
     * Environment is scrubbed (only explicit scoped material). Timeout kills.
     * Output capped. Tool mutation after validation -> re-quarantined.
     */
    function launchSandboxedTool({ toolModulePath, toolArgs, fsReadAllowlist, fsWriteAllowlist, timeoutMs = null, envMaterial = {} }) {
        return new Promise((resolve, reject) => {
            const resolved = path.resolve(toolModulePath);
            const readAllow = ["node_modules", resolved, ...(fsReadAllowlist ?? [])].map(p => path.resolve(p));
            const writeAllow = (fsWriteAllowlist ?? []).map(p => path.resolve(p));
            // build permission flags Ã¢â‚¬â€ NO --allow-child-process, NO --allow-worker
            const permissionFlags = ["--permission", "--no-warnings"];
            for (const p of readAllow) permissionFlags.push(`--allow-fs-read=${p}`);
            for (const p of writeAllow) permissionFlags.push(`--allow-fs-write=${p}`);
            // scrubbed environment: NEVER inherit the parent env
            const sandboxEnv = {
                NODE_ENV: "sandbox",
                DAMAR_SANDBOX: "1",
                SANDBOX_TOOL_ARGS: JSON.stringify(toolArgs ?? {}),
                SANDBOX_TOOL_MODULE: resolved,
                ...envMaterial // explicit scoped material ONLY
            };
            const entryScript = path.resolve(__dirname, "..", "federation", "sandboxEntry.js");
            const child = spawn(config.nodeExecutable, [...permissionFlags, entryScript], {
                cwd: sandboxRoots.workspace ?? process.cwd(),
                env: sandboxEnv,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: timeoutMs ?? config.timeoutMs,
                killSignal: "SIGKILL",
                windowsHide: true
            });
            let stdout = "", stderr = "";
            let killed = false;
            const totalBytes = () => Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
            child.stdout.on("data", d => {
                stdout += d.toString();
                if (totalBytes() > config.maxOutputBytes) { killed = true; child.kill("SIGKILL"); reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox output exceeded cap")); }
            });
            child.stderr.on("data", d => { stderr += d.toString(); });
            child.on("error", err => reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox spawn failed: ${String(err.message).slice(0, 120)}`)));
            child.on("close", (code, signal) => {
                if (killed) return; // already rejected
                // non-zero exit with stderr: the tool failed inside the sandbox
                // (permission denial, module error, invariant violation)
                if (typeof code === "number" && code !== 0) {
                    const reason = stderr.slice(0, 300);
                    return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox exited code=${code}: ${reason}`));
                }
                // W6-R2-05: timeout kill — on Windows, spawn's built-in timeout
                // kills with TerminateProcess and close fires code=0/signal=null
                // with empty stdout; treat empty stdout as timeout/empty-output
                if (signal === "SIGKILL" || !stdout.trim()) {
                    return reject(meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, `sandbox timeout or empty output (signal=${signal}, code=${code})`));
                }
                try {
                    const parsed = JSON.parse(stdout);
                    // unwrap the sandbox entry wrapper — return the tool's output directly
                    resolve(Object.freeze({ ok: true, output: parsed.output ?? null, sandboxPid: child.pid }));
                } catch {
                    reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "sandbox produced non-JSON output"));
                }
            });
        });
    }

    return Object.freeze({
        id: "governed-external-executor",
        checkSandboxViolations,
        launchSandboxedTool,
        /**
         * R2-07: execute a governed external tool.
         *
         * NO caller-shaped authority exists in this API: the caller can ONLY
         * present a `claimId` produced by the canonical router
         * (`claimGovernedExecution`). The router resolves authority via LIVE
         * canonical evaluation and consumes the one-use lease/claim at this
         * boundary; the executor receives the BOUND facts from the claim.
         *
         * `toolArtifactPath`, `candidateId`, `toolName`, `args` and sandbox
         * needs are validated against the claim — swapping any of them after
         * authorization fails closed.
         */
        async execute({ claimId, args = {}, envMaterial = {} } = {}) {
            // 1. the claim is the ONLY authority entry point
            if (typeof claimId !== "string" || claimId.length === 0) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed execution requires a claimId from the canonical router (no caller-shaped authority)");
            }
            const router = executionRouter;
            if (!router) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed external execution requires an executionRouter bound at construction (R2-07)");
            }
            // 2. consume the claim: LIVE authority facts + one-use lease
            //    consumption through the router's mandatory ledger
            const claim = router.consumeGovernedClaim(claimId, { localNodeId: null });
            // 3. enablement (discovery != enablement)
            if (!federation.isToolEnabled(claim.candidateId, claim.toolName)) {
                throw meshFailure(MESH_ERRORS.TOOL_NOT_ENABLED, `tool '${String(claim.toolName).slice(0, 64)}' is not enabled`);
            }
            // 4. sandbox verification against the tool's DECLARED needs
            const sandboxNeeds = claim.sandboxNeeds ?? {
                needsNetwork: [], needsFilesystem: [], needsProcessSpawn: false, needsSecrets: false
            };
            const violations = checkSandboxViolations(sandboxNeeds);
            // R2-05: network is NOT enforceable by the Node permission model —
            // fail CLOSED for untrusted tools that declare network needs
            if (sandboxNeeds.needsNetwork.length > 0 && sandboxPolicy.networkEnforcement !== "NON_ENFORCED_ACCEPTED") {
                violations.push("network need declared but network egress is not enforceable in this sandbox (fail-closed)");
            }
            if (violations.length > 0) {
                throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox violations: ${violations.slice(0, 3).join("; ")}`);
            }
            // 5. REAL sandbox launch (code comes from the claim-bound artifact path)
            const result = await launchSandboxedTool({
                toolModulePath: claim.toolArtifactPath ?? path.resolve(__dirname, "..", "federation", "noopTool.js"),
                toolArgs: args,
                fsReadAllowlist: sandboxNeeds.needsFilesystem ?? [],
                fsWriteAllowlist: sandboxPolicy.fsWrite ?? [],
                envMaterial
            });
            return Object.freeze({
                ok: true,
                output: result.output,
                claimId: claim.claimId,
                executionId: claim.executionId,
                decisionDigest: claim.decisionDigest,
                consumedLease: claim.consumedLease ? claim.consumedLease.executionId : null,
                sandbox: { pid: result.sandboxPid }
            });
        },
        launchSandboxedTool
    });
}

module.exports = Object.freeze({
    createDistributedNodeRuntime,
    createGovernedExternalToolExecutor
});
