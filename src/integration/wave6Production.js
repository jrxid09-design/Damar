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
    // R3-01: install the canonical AuthorityRegistry owner. The seam accepts
    // ONLY an AuthorityRegistry produced by createCanonicalAuthorityRegistry
    // (composition-root ownership, brand verified). A caller-created
    // `new AuthorityRegistry(...)` is NEVER canonical and can never capture
    // authority. Without installation, routing fails closed at route time.
    if (authorityRegistry !== null && authorityRegistry !== undefined) {
        dexec.installCanonicalAuthorityRegistry(authorityRegistry);
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
 * F (W6-R3-02/03 REPAIR): REAL sandbox via Windows AppContainer.
 *
 * The untrusted external tool runs inside a spawned Node child placed in a
 * Windows AppContainer with ZERO package capabilities and LOW integrity.
 * Raw TCP/UDP/DNS (loopback 127.0.0.1/localhost/::1, LAN, public, DNS) is
 * DENIED BY THE WINDOWS KERNEL (WFP AppContainer enforcement) — independently
 * proven: a process in this AppContainer cannot connect to 127.0.0.1,
 * localhost, ::1, a LAN address, a public IP, or resolve DNS. Node's
 * --permission has NO network enforcement (proven) and is NOT used as the
 * isolation boundary here.
 *
 * The child's module surface is additionally narrowed by the sandbox shim
 * (vm require= node: builtins + curated core allowlist only; ambient env
 * scrubbed before tool code). Filesystem/process are denied by AppContainer;
 * only directories explicitly ACL'd by the host are readable.
 *
 * launchSandboxedTool is NOT returned on the executor surface (R3-03). The
 * ONLY production external-tool entry point is execute({ claimId, ... }) via
 * the canonical governed claim.
 */
const { APPCONTAINER_NAME, HOST_EXE: SANDBOX_HOST_EXE } = require("../federation/appContainerSandbox");
const { SHIM_SOURCE } = require("../federation/sandboxShim");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const SANDBOX_DEFAULTS = Object.freeze({
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024
});

// ---- private AppContainer launch primitive (R3-03: closure-private) ----
function stageIntoPackage({ nodeExecutable, toolArtifactPath, runName }) {
    const root = path.join(os.homedir(), "AppData", "Local", "Packages", APPCONTAINER_NAME);
    if (!fs.existsSync(root)) {
        throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
            "AppContainer package folder missing — sandbox host unavailable (R3-02 fail-closed)");
    }
    const dir = path.join(root, "run-" + runName);
    fs.mkdirSync(dir, { recursive: true });
    const stagedNode = path.join(dir, "node.exe");
    fs.copyFileSync(nodeExecutable, stagedNode);
    const stagedTool = path.join(dir, path.basename(String(toolArtifactPath)) || "tool.js");
    fs.copyFileSync(toolArtifactPath, stagedTool);
    return { dir, stagedNode, stagedTool };
}

function launchAppContainerTool({
    toolArtifactPath,
    toolArgs = {},
    envMaterial = {},
    nodeExecutable = process.execPath,
    timeoutMs = 30_000,
    runName = crypto.randomBytes(8).toString("hex")
} = {}) {
    return new Promise((resolve, reject) => {
        if (process.platform !== "win32") {
            return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                "AppContainer sandbox requires Windows (R3-02)"));
        }
        if (!fs.existsSync(SANDBOX_HOST_EXE)) {
            return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                "native/sandbox-host/sandbox-host.exe missing — governed external execution fails closed (R3-03)"));
        }
        let staged;
        try {
            staged = stageIntoPackage({ nodeExecutable, toolArtifactPath, runName });
        } catch (e) {
            return reject(e instanceof Error && e.code ? e : meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                "failed to stage sandbox payload: " + String(e.message).slice(0, 160)));
        }
        const outFile = path.join(staged.dir, "out.json");
        const argsJson = JSON.stringify(toolArgs ?? {});
        const envJson = JSON.stringify(envMaterial ?? {});
        const hostArgs = [
            "--app-container", APPCONTAINER_NAME,
            "--node", staged.stagedNode,
            "--entry", "__eval__",
            "--cwd", staged.dir,
            "--read", staged.dir,
            "--write", staged.dir,
            "--timeout-ms", String(Math.floor(Number(timeoutMs) || 30000)),
            "--",
            SHIM_SOURCE,
            staged.stagedTool,
            outFile,
            argsJson,
            envJson
        ];
        const child = spawn(SANDBOX_HOST_EXE, hostArgs, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
        let stderrChunk = "";
        let killed = false;
        child.stderr.on("data", d => {
            stderrChunk += d.toString();
            if (Buffer.byteLength(stderrChunk, "utf8") > 64 * 1024) { killed = true; child.kill("SIGKILL"); }
        });
        child.on("error", err => {
            if (killed) return;
            reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "sandbox-host spawn failed: " + String(err.message).slice(0, 140)));
        });
        child.on("close", code => {
            if (killed) return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox output exceeded cap"));
            if (code === 124) return reject(meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, `sandbox timeout (${timeoutMs}ms)`));
            let raw;
            try {
                raw = fs.readFileSync(outFile, "utf8");
            } catch {
                const tail = stderrChunk.slice(-200).trim();
                return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                    `sandbox produced no result (host code=${code}) ${tail}`));
            }
            if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
                return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox result exceeds output cap"));
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "sandbox produced non-JSON result"));
            }
            if (parsed && parsed.ok === true) {
                return resolve(Object.freeze({
                    ok: true,
                    output: parsed.output ?? null,
                    sandboxPid: Number(parsed.pid) || 0,
                    mechanism: "AppContainer",
                    sandboxId: APPCONTAINER_NAME
                }));
            }
            if (parsed && String(parsed.error).indexOf("OUTPUT_EXCEEDS_CAP") >= 0) {
                return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox result exceeds output cap"));
            }
            return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                `sandbox error: ${String((parsed && parsed.error) || "unknown").slice(0, 300)}`));
        });
    });
}

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

    return Object.freeze({
        id: "governed-external-executor",
        checkSandboxViolations,
        /**
         * R3-03: NO public launchSandboxedTool. The ONLY production
         * external-tool entry point is execute({ claimId, ... }) through the
         * canonical governed claim. The private AppContainer launch primitive
         * is not exported and is not reachable through any public surface.
         *
         * R2-07/R3-05: execute a governed external tool.
         *
         * NO caller-shaped authority / sandbox launcher / toolFn exists in
         * this API: the caller can ONLY present a `claimId` produced by the
         * canonical router (`claimGovernedExecution`). The router resolves
         * authority via LIVE canonical evaluation and consumes the one-use
         * lease/claim at this boundary; the executor receives the BOUND facts
         * from the claim. The tool code is loaded by the AppContainer sandbox
         * from the claim-bound artifact path (not by this process).
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
            // R3-02: network EGRESS is actually denied by the AppContainer
            // kernel. A network-declaring tool is still rejected at admission
            // unless the deployment explicitly opts into NON_ENFORCED_ACCEPTED
            // (documented acceptance of the residual). The default remains
            // fail-closed at admission; even where network is refused by the
            // kernel, we do not silently change policy.
            if (sandboxNeeds.needsNetwork.length > 0 &&
                sandboxPolicy.networkEnforcement !== "NON_ENFORCED_ACCEPTED" &&
                sandboxPolicy.networkEnforcement !== "APP_CONTAINER_DENY") {
                violations.push("network need declared but not permitted by sandbox policy (R3-02)");
            }
            if (violations.length > 0) {
                throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, `sandbox violations: ${violations.slice(0, 3).join("; ")}`);
            }
            // 5. REAL AppContainer sandbox launch (private primitive). Tool
            //    code comes from the claim-bound artifact path; this process
            //    never loads tool code itself.
            const result = await launchAppContainerTool({
                toolArtifactPath: claim.toolArtifactPath,
                toolArgs: args,
                envMaterial,
                timeoutMs: config.timeoutMs
            });
            return Object.freeze({
                ok: true,
                output: result.output,
                claimId: claim.claimId,
                executionId: claim.executionId,
                decisionDigest: claim.decisionDigest,
                consumedLease: claim.consumedLease ? claim.consumedLease.executionId : null,
                sandbox: { pid: result.sandboxPid, mechanism: result.mechanism, sandboxId: result.sandboxId }
            });
        }
    });
}

module.exports = Object.freeze({
    createDistributedNodeRuntime,
    createGovernedExternalToolExecutor
});
