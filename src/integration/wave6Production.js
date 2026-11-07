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
    // R4-01: NO authorityRegistry parameter and NO installer call here. The
    // canonical Authority owner is constructed+marked+installed exclusively
    // inside the production composition root (canonicalComposition.js). The
    // router resolves LIVE against that module-private source at route time;
    // before the composition installs it, routing fails closed.
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
const { APPCONTAINER_NAME, HOST_EXE: SANDBOX_HOST_EXE, ensureSandboxRuntimeReady, sandboxProvisioningStatus } = require("../federation/appContainerSandbox");
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

// ---- R5-04: NATIVE-HOST-OWNED staging + launch (no JS package-dir writes) ----
//
// The JS parent NEVER writes into the protected AppContainer package directory
// and NEVER supplies a destination path. It supplies ONLY the validated SOURCE
// node executable, the validated SOURCE artifact path, the EXPECTED artifact
// digest (the federation-pinned digest), the execution identity, and bounded
// args/env. The trusted native host derives the destination, stages, verifies
// source+destination digests, checks TOCTOU, and launches the restricted child.
function launchAppContainerTool({
    artifactPath,
    artifactDigest,
    executionId = crypto.randomBytes(16).toString("hex"),
    toolArgs = {},
    envMaterial = {},
    nodeExecutable = process.execPath,
    timeoutMs = 30_000
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
        // The artifact source + its expected digest are MANDATORY. A caller that
        // cannot present both cannot stage; there is no JS copy fallback.
        if (typeof artifactPath !== "string" || artifactPath.length === 0) {
            return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed sandbox requires an artifact source path"));
        }
        if (typeof artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(artifactDigest)) {
            return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "governed sandbox requires the 64-hex pinned artifact digest (R5-04)"));
        }
        const nodeSrc = String(nodeExecutable);
        if (!fs.existsSync(nodeSrc)) {
            return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION, "node executable source unavailable"));
        }
        const nodeDigest = crypto.createHash("sha256").update(fs.readFileSync(nodeSrc)).digest("hex");
        const argsJson = JSON.stringify(toolArgs ?? {});
        const envJson = JSON.stringify(envMaterial ?? {});
        const hostArgs = [
            "--governed",
            "--app-container", APPCONTAINER_NAME,
            "--execution-id", String(executionId).slice(0, 128),
            "--node-source", nodeSrc,
            "--node-digest", nodeDigest,
            "--artifact-source", artifactPath,
            "--artifact-digest", artifactDigest,
            "--timeout-ms", String(Math.floor(Number(timeoutMs) || 30000)),
            "--",
            SHIM_SOURCE,
            argsJson,
            envJson
        ];
        const child = spawn(SANDBOX_HOST_EXE, hostArgs, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
        let stdoutChunk = "";
        let stderrChunk = "";
        let killed = false;
        child.stdout.on("data", d => {
            stdoutChunk += d.toString();
            if (Buffer.byteLength(stdoutChunk, "utf8") > 1024 * 1024) { killed = true; child.kill("SIGKILL"); }
        });
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
            // Parse the framed result relayed by the native host on stdout.
            const framed = parseNativeResult(stdoutChunk);
            if (framed === null) {
                const tail = stderrChunk.slice(-200).trim();
                return reject(meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                    `sandbox produced no result (host code=${code}) ${tail}`));
            }
            if (Buffer.byteLength(framed, "utf8") > 256 * 1024) {
                return reject(meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "sandbox result exceeds output cap"));
            }
            let parsed;
            try {
                parsed = JSON.parse(framed);
            } catch {
                return reject(meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "sandbox produced non-JSON result"));
            }
            if (parsed && parsed.ok === true) {
                return resolve(Object.freeze({
                    ok: true,
                    output: parsed.output ?? null,
                    sandboxPid: Number(parsed.pid) || 0,
                    mechanism: "AppContainer",
                    sandboxId: APPCONTAINER_NAME,
                    stagedDigest: artifactDigest
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

/**
 * R5-04: parse the native host's framed result relay from stdout:
 *   SANDBOXHOST_RESULT_BEGIN <bytes>\n<body>\nSANDBOXHOST_RESULT_END
 * Returns the body string, or null when the frame is absent/empty.
 */
function parseNativeResult(stdoutChunk) {
    const beginMark = "SANDBOXHOST_RESULT_BEGIN ";
    const endMark = "SANDBOXHOST_RESULT_END";
    const bi = stdoutChunk.indexOf(beginMark);
    if (bi < 0) return null;
    const lineEnd = stdoutChunk.indexOf("\n", bi);
    if (lineEnd < 0) return null;
    const declared = Number(stdoutChunk.slice(bi + beginMark.length, lineEnd).trim());
    if (!Number.isFinite(declared) || declared <= 0) return null;
    const bodyStart = lineEnd + 1;
    const ei = stdoutChunk.indexOf("\n" + endMark, bodyStart);
    const body = ei < 0 ? stdoutChunk.slice(bodyStart) : stdoutChunk.slice(bodyStart, ei);
    return body;
}

let compositionProvisionPromise = null;
function ensureCompositionProvisioning() {
    if (!compositionProvisionPromise) {
        compositionProvisionPromise = ensureSandboxRuntimeReady().then(
            () => true,
            (e) => { compositionProvisionPromise = null; throw e; }
        );
    }
    return compositionProvisionPromise;
}

/**
 * R4-07 — GOVERNED CLAIM MATERIAL BINDING.
 *
 * The external-tool environment is NEVER supplied by the caller of execute().
 * No `envMaterial` parameter exists on the production path: a caller cannot
 * inject arbitrary environment variables, secrets, or resource scopes into an
 * execution. Material is resolved INTERNALLY at the executor boundary from the
 * CLAIM-BOUND `sandboxNeeds` (the declared + authorized scopes) against a
 * composition-owned, frozen material table captured at construction.
 *
 *   claim.sandboxNeeds =
 *     { needsNetwork, needsFilesystem, needsProcessSpawn, needsSecrets }
 *     -> resolveEnvMaterial(claim, materialNode)
 *
 * The resolver returns ONLY the env sub-table for scopes that were declared in
 * the claim AND whitelisted in the composition's frozen material table. If a
 * scope asks for secrets and none is authorized, the key is simply absent
 * (fail-closed minimum). The native AppContainer env block + shim
 * deny-by-default remain the final gate.
 *
 * If a caller passes `envMaterial` to execute() it is REJECTED (the parameter
 * no longer exists in the production signature).
 */
function resolveEnvMaterial(claim, materialTable) {
    const out = {};
    const needs = (claim && claim.sandboxNeeds) || {};
    const needSecrets = needs.needsSecrets === true;
    const needFs = Array.isArray(needs.needsFilesystem) ? needs.needsFilesystem.map((p) => String(p).slice(0, 256)) : [];
    const fsKeys = [];
    for (const root of needFs) {
        // Only allow a material path if the claim actually asked for this
        // filesystem scope; the material table is the ONLY value source.
        if (materialTable.filesystem) {
            for (const [k, v] of Object.entries(materialTable.filesystem)) {
                if (typeof k === "string" && k.length > 0 && String(root).startsWith(k)) {
                    fsKeys.push([k, v]);
                }
            }
        }
    }
    if (needSecrets && materialTable.secrets) {
        for (const [k, v] of Object.entries(materialTable.secrets)) {
            if (typeof k === "string" && k.length > 0 && typeof v === "string") {
                out[k] = v;
            }
        }
    }
    for (const [k, v] of fsKeys) {
        if (typeof v === "string") out[k] = v;
    }
    return out;
}

function createGovernedExternalToolExecutor({ federation, sandboxPolicy, sandboxRoots = {}, executionRouter = null, material = null }) {
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
    // R4-07: frozen composition-owned material table. Callers of execute()
    // cannot supply env. Validators only pass a material on the constructor
    // (test composition privilege).
    const materialTable = material && typeof material === "object"
        ? Object.freeze({
            filesystem: Object.freeze((material.filesystem ?? {})),
            secrets: Object.freeze((material.secrets ?? {}))
          })
        : Object.freeze({ filesystem: Object.freeze({}), secrets: Object.freeze({}) });

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
         * R4-02: provisioning status of the AppContainer runtime (honest,
         * no side effects; `await ensureSandboxedRuntimeReady()` outside the
         * executor for an explicit preflight).
         */
        sandboxProvisioningStatus,
        /**
         * R4-02: explicit provisioning preflight (single-flight, tamper-aware).
         * The executor does NOT require the caller to call this before
         * execute() — execute() performs a fail-closed provisioning check
         * internally — but the composition may use it to fail fast at boot.
         */
        ensureSandboxRuntimeReady,
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
        async execute({ claimId, args = {} } = {}) {
            // R4-07: NO caller envMaterial parameter exists. A caller that
            // attempts to smuggle an `envMaterial` key is rejected explicitly.
            if (arguments[0] && typeof arguments[0] === "object" &&
                Object.prototype.hasOwnProperty.call(arguments[0], "envMaterial")) {
                throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED,
                    "governed execution does not accept caller envMaterial (R4-07: material is claim-bound)");
            }
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
            // 5. REAL AppContainer sandbox launch (native-host-owned staging).
            //    R5-04: the executor resolves the AUTHORITATIVE artifact digest
            //    from the federation's validation-time pin (digest pinning is
            //    mandatory). The claim carries the artifact SOURCE path; the
            //    digest is bound end-to-end and verified by the native host
            //    before launch. A tool whose enabled artifact cannot present its
            //    pinned digest fails closed — no JS-side copy fallback exists.
            const provisioned = await ensureCompositionProvisioning().catch((e) => null);
            if (provisioned !== true) {
                throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                    "sandbox runtime not provisioned (R4-02 fail-closed): " + String(provisioned?.message || ("not ready")).slice(0, 160));
            }
            const pinnedDigest = typeof federation.getPinnedToolDigest === "function"
                ? federation.getPinnedToolDigest(claim.candidateId, claim.toolName)
                : null;
            if (typeof pinnedDigest !== "string" || !/^[0-9a-f]{64}$/.test(pinnedDigest)) {
                throw meshFailure(MESH_ERRORS.SANDBOX_VIOLATION,
                    "no pinned artifact digest for the enabled tool (R5-04 fail-closed: digest pinning mandatory)");
            }
            const result = await launchAppContainerTool({
                artifactPath: claim.toolArtifactPath,
                artifactDigest: pinnedDigest,
                executionId: claim.executionId,
                toolArgs: args,
                envMaterial: resolveEnvMaterial(claim, materialTable),
                timeoutMs: config.timeoutMs
            });
            return Object.freeze({
                ok: true,
                output: result.output,
                claimId: claim.claimId,
                executionId: claim.executionId,
                decisionDigest: claim.decisionDigest,
                consumedLease: claim.consumedLease ? claim.consumedLease.executionId : null,
                sandbox: {
                    pid: result.sandboxPid, mechanism: result.mechanism,
                    sandboxId: result.sandboxId, stagedDigest: result.stagedDigest
                }
            });
        }
    });
}

/**
 * DB-02/DB02-C (Repair5): the ONE canonical production Wave 6 lane-3 adapter,
 * lazily constructed at most once. This is what
 * the internal Manager bootstrap module's createDamarManager() wires into
 * the canonical Manager singleton's `wave6Adapter` composition parameter —
 * REAL infrastructure (a DistributedNodeRuntime + GovernedExternalToolExecutor),
 * never a test double, and never a caller-supplied route/claim/execute
 * callback.
 *
 * SEALED CONSTRUCTION (DB02-C): takes NO parameters. Daybreak's finding was
 * that a caller-selected `capabilityIds`/`logicalDamarId` on a first-call-wins
 * singleton let an earlier importer's choice silently become what the REAL
 * canonical Manager later received — "FIRST-CALLER-WINS TRUST IS NOT TRUST."
 * With zero parameters, every call (whoever makes it, whenever) produces the
 * IDENTICAL deterministic construction, so there is no caller-influenceable
 * state left to poison. The constructor itself (`ensureCanonicalWave6ExecutionAdapter`)
 * is additionally kept off the normal enumerable export surface (see
 * module.exports below) — ordinary importers get only the read-only getter.
 *
 * HONEST LIMITATION (DB02-D, partially repaired): the node now advertises
 * the REAL canonical AVAILABLE capability ids (via
 * action/bootstrap.js::_getCanonicalAvailableCapabilityIds — a read-only
 * view, not a caller-selected list), so `route()` can genuinely find an
 * advertising node for a real capability. There is STILL no production
 * capability -> federation-enabled-tool-candidate resolver: no capability in
 * this codebase today is backed by a discovered/validated/enabled external
 * tool artifact (src/federation/federation.js's ExternalCapabilityFederation
 * lifecycle has no production caller). That remaining link is a distinct,
 * deeper gap requiring an actual production external-tool capability +
 * artifact to exist — a product/architecture decision, not thin wiring — and
 * is intentionally NOT fabricated here. Until it exists, `tryDistributed`
 * correctly reports `{ distributed: false }` and the Manager falls back to
 * the frozen local Lane 3 — honest inert wiring, not a faked distributed path.
 */
let canonicalWave6Adapter = null;

/**
 * DB02-C: construct the ONE canonical adapter if it doesn't exist yet, else
 * return it. Zero-argument. NOT on the normal enumerable module.exports
 * shape (see below) — reachable only by a caller that already knows to look
 * for the non-enumerable property, and harmless even then since there is no
 * parameter to poison.
 */
function ensureCanonicalWave6ExecutionAdapter() {
    if (canonicalWave6Adapter) return canonicalWave6Adapter;
    // DB02-D (Repair5): advertise the REAL canonical capability ids (a
    // read-only, deterministic view — see action/bootstrap.js
    // _getCanonicalAvailableCapabilityIds) instead of an empty list. This is
    // a require(), not a caller-suppliable argument: this zero-parameter
    // constructor still produces the identical deterministic construction on
    // every call (DB02-C invariant preserved).
    const { _getCanonicalAvailableCapabilityIds } = require("../action/bootstrap");
    const capabilityIds = _getCanonicalAvailableCapabilityIds();
    const node = createDistributedNodeRuntime({ capabilityIds });
    canonicalWave6Adapter = Object.freeze({
        async tryDistributed({ intent, parameters = {} }) {
            let routed;
            try {
                routed = await node.dexecRouter.route({ intent, toolId: `tool.${intent.capabilityId}` });
            } catch {
                // No production node currently advertises this capability
                // (or no eligible trusted node) — honest ineligible result.
                return Object.freeze({ distributed: false });
            }
            // A route exists, but governed execution additionally requires a
            // federation-enabled tool candidate (candidateId/toolName); no
            // production caller resolves one yet, so the attempt is reported
            // ineligible rather than fabricating a claim.
            return Object.freeze({ distributed: false, targetNodeId: routed.targetNodeId ?? null });
        }
    });
    return canonicalWave6Adapter;
}

/**
 * DB02-C: read-only accessor. Returns the already-constructed canonical
 * adapter, or null before the trusted production composition has run. Cannot
 * create or mutate anything.
 */
function getCanonicalWave6ExecutionAdapter() {
    return canonicalWave6Adapter;
}

const wave6ProductionExports = {
    createDistributedNodeRuntime,
    createGovernedExternalToolExecutor,
    getCanonicalWave6ExecutionAdapter,
    APPCONTAINER_NAME: require("../federation/appContainerSandbox").APPCONTAINER_NAME
    // R4-04: `createWave6Lane3Facade` (caller-controlled callback facade) is
    // REMOVED from production surfaces. The Manager's Lane-3 distributed seam
    // is shape-validated composition-time DI (see managerBootstrap.js DB-02
    // note); the production RuntimeHost composition never accepts caller
    // callbacks. Tests construct their own seam via
    // tests/manager/productionHarness.js (test-only).
};
// DB02-C: the zero-argument constructor is deliberately NOT an enumerable
// export — ordinary importers (Object.keys, destructuring `{ x }` still
// works if named explicitly, but nothing iterates to discover it) only see
// the read-only getter above. The only caller is
// the internal Manager bootstrap module's createDamarManager().
Object.defineProperty(wave6ProductionExports, "ensureCanonicalWave6ExecutionAdapter", {
    value: ensureCanonicalWave6ExecutionAdapter,
    enumerable: false, writable: false, configurable: false
});
module.exports = Object.freeze(wave6ProductionExports);
