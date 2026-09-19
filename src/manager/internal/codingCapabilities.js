"use strict";

/**
 * W8-IW1 — CODING CAPABILITY FAMILY (Manager-owned execution ownership).
 *
 * This module is the highest common canonical choke point for the coding
 * family: it is the ONLY module that requires the low-level coding drivers
 * (LSP/serena/graphify/powershell/git/test/refactor). `src/coding/CodingBrain.js`
 * and `src/coding/tools.js` no longer reach the drivers statically; they go
 * through the adapters below, and every adapter call must pass authority first.
 *
 * Canonical path per call:
 *
 *   model / tool call
 *     -> Manager-owned coding capability runtime   (this module)
 *     -> capability request (ActionIntent equivalent)
 *     -> authority (src/authority/evaluate.js::loadAndEvaluateAuthority)
 *     -> exact capability + exact operation (no caller-selected handler)
 *     -> canonicalCapabilityExecution bridge
 *     -> low-level driver
 *     -> Verification
 *     -> Audit + durable acknowledgement
 *     -> canonical completion
 *
 * OWNER DECISION (recorded): consequential families are migrated and left
 * DENY-UNTIL-RATIFIED. Nothing here mints, infers, bootstraps or auto-ratifies a
 * grant; the executor has no authority to grant itself capabilities. Without a
 * valid owner-ratified grant the capability reports
 * STATE.OWNER_RATIFICATION_REQUIRED / AVAILABLE_BUT_NOT_AUTHORIZED, the driver is
 * never resolved, and zero physical effect occurs.
 *
 * Registration != authorization; availability != authority; migration !=
 * authorization.
 */

const crypto = require("node:crypto");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const {
    CanonicalCapabilityExecution,
    OUTCOME
} = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");

/** Truthful availability vocabulary (never implies authority). */
const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

/**
 * Declarative capability catalogue: capability id -> exact driver methods.
 * `mutating` is the effect class; everything here spawns a process or writes, so
 * every entry is consequential and separately authorizable.
 */
const CATALOGUE = Object.freeze({
    "coding.git.read": {
        family: "coding",
        consequence: "process-execution",
        mutating: false,
        driver: "patcher",
        rationale: "Git inspection spawns git; read-only in effect but still process execution.",
        methods: ["isRepo", "currentBranch", "status", "diff"],
        verifier: null
    },
    "coding.git.write": {
        family: "coding",
        consequence: "process-execution+repository-mutation",
        mutating: true,
        driver: "patcher",
        rationale: "Commit/branch/restore mutate the user's repository.",
        methods: ["createBranch", "commit", "restore"],
        verifier: "ok-flag",
        dependencies: ["coding.git.read"]
    },
    "coding.test.run": {
        family: "coding",
        consequence: "process-execution",
        mutating: true,
        driver: "tester",
        rationale: "Runs the project's own lint/test scripts: arbitrary project code execution.",
        methods: ["detect", "runScript", "lint", "test", "check", "verify"],
        verifier: "ok-flag"
    },
    "coding.lsp": {
        family: "coding",
        consequence: "process-execution",
        mutating: false,
        driver: "lsp",
        rationale: "Spawns language servers and speaks LSP; process execution.",
        methods: ["installed", "health", "available", "op"],
        verifier: null
    },
    "coding.serena": {
        family: "coding",
        consequence: "process-execution",
        mutating: false,
        driver: "symbol",
        rationale: "Serena CLI/project-server indexing; process execution.",
        methods: ["available", "index", "healthCheck"],
        verifier: null
    },
    "coding.graphify": {
        family: "coding",
        consequence: "process-execution",
        mutating: true,
        driver: "graph",
        rationale: "Graphify CLI runs; `update` writes the graph output.",
        methods: ["available", "hasGraph", "query", "path", "explain", "update"],
        verifier: "ok-flag"
    },
    "coding.powershell": {
        family: "coding",
        consequence: "process-execution",
        mutating: false,
        driver: "powershell",
        rationale: "PowerShell/PSScriptAnalyzer execution — explicitly separately authorizable.",
        methods: ["available", "analyze", "symbols"],
        verifier: null
    },
    "coding.refactor.read": {
        family: "coding",
        consequence: "process-execution",
        mutating: false,
        driver: "refactor",
        rationale: "Refactor previews resolve edits through LSP; no workspace write.",
        methods: ["previewRename", "actions"],
        verifier: null
    },
    "coding.refactor.write": {
        family: "coding",
        consequence: "filesystem-mutation",
        mutating: true,
        driver: "refactor",
        rationale: "Applies workspace edits to the user's source tree.",
        methods: ["renameSymbol", "applyAction"],
        verifier: "ok-flag",
        dependencies: ["coding.refactor.read", "coding.git.write"]
    }
});

/** Driver modules: required HERE and nowhere else in the coding family. */
function loadDrivers() {
    return {
        patcher: require("../../coding/patcher/gitPatcher"),
        tester: require("../../coding/tester/testRunner"),
        lsp: require("../../coding/lsp/LSPManager"),
        symbol: require("../../coding/symbol/serenaAdapter"),
        graph: require("../../coding/graph/graphifyAdapter"),
        powershell: require("../../coding/analyzer/powershell"),
        refactor: require("../../coding/refactor/Refactorer")
    };
}

/** Honest postcondition: the capability completes only if its driver returned a
 *  result and did not report failure. Named for exactly what it checks. */
function driverReportVerifier(expects) {
    return async (_parameters, result) => {
        const checks = [{
            name: "driver-returned-result",
            passed: result !== undefined && result !== null
        }];
        if (expects === "ok-flag") {
            checks.push({
                name: "driver-reported-no-failure",
                passed: !(result && typeof result === "object" && (result.ok === false || result.error))
            });
        }
        return { checks };
    };
}

const runtimeGate = new WeakSet();

/**
 * @param {object} options
 * @param {object|null} options.authorityStore  canonical authority store
 *   ({ getCapability, getGeneration, countConsumption }). Without it no
 *   evaluation is possible and everything reports OWNER_RATIFICATION_REQUIRED.
 * @param {Function|null} options.acknowledge  durable audit acknowledgement port
 */
function createCodingCapabilityRuntime({ authorityStore = null, acknowledge = null } = {}) {

    const bridge = new CanonicalCapabilityExecution();
    const drivers = loadDrivers();
    const invocations = new Map();     // capabilityId -> real driver invocations
    const byDriver = new Map();        // driver name -> { capabilityId, methods }

    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    for (const [rawId, spec] of Object.entries(CATALOGUE)) {
        const capabilityId = canonicalCapabilityId(rawId);
        for (const method of spec.methods) {
            bridge.registerCapability({
                capabilityId,
                operation: method,
                consequential: true,
                driverId: `${spec.driver}.${method}`,
                driver: async ({ parameters }) => {
                    // Counted here: this closure runs only after the bridge has
                    // authorized, bound and digested the request.
                    invocations.set(capabilityId, (invocations.get(capabilityId) ?? 0) + 1);
                    const args = Array.isArray(parameters?.args) ? parameters.args : [];
                    const fn = Reflect.get(drivers[spec.driver], method);
                    if (typeof fn !== "function") {
                        throw new TypeError(`driver method unavailable: ${spec.driver}.${method}`);
                    }
                    return Reflect.apply(fn, drivers[spec.driver], args);
                }
            });
        }
        bridge.registerVerifier(capabilityId, driverReportVerifier(spec.verifier));
        // One driver may serve several capabilities (git read/write, refactor
        // read/write): keep every method's own capability binding.
        const methodsFor = byDriver.get(spec.driver) ?? new Map();
        for (const method of spec.methods) methodsFor.set(method, capabilityId);
        byDriver.set(spec.driver, methodsFor);
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
                capabilityId,
                action: "execute",
                scope: [],
                identity,
                // A real clock is mandatory here: the canonical evaluator compares
                // atMs against notBefore/expiresAt, and with an absent nowMs that
                // comparison is false, so an expired grant would slip through.
                nowMs
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

    /** Truthful denial: the state reflects WHY nothing ran (no authority store
     *  at all vs. a real store with no valid owner grant). */
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
            detail: auth.detail ?? null
        };
    }

    const runtime = {
        state: "composed",

        /** Availability per capability. Never implies authority. */
        async availability({ identity = {} } = {}) {
            const out = {};
            for (const [rawId, spec] of Object.entries(CATALOGUE)) {
                const capabilityId = canonicalCapabilityId(rawId);
                const auth = await authorizationFor(capabilityId, { identity });
                out[capabilityId] = {
                    state: auth.state,
                    reasonCode: auth.reasonCode,
                    mutating: spec.mutating,
                    consequence: spec.consequence
                };
            }
            return out;
        },

        /** Capability-backed adapter carrying the driver's method surface. Every
         *  call is authorized, digested, verified and audited. */
        adapter(name) {
            const methodsFor = byDriver.get(name);
            if (!methodsFor) throw new Error(`unknown coding driver: ${name}`);
            const adapter = {};
            for (const [method, capabilityId] of methodsFor) {
                adapter[method] = async (...args) => {
                    const auth = await authorizationFor(capabilityId);
                    if (!auth.allowed) return denial(capabilityId, method, auth);
                    const result = await bridge.execute({
                        capabilityId,
                        operation: method,
                        parameters: { args },
                        evaluation: auth.evaluation
                    });
                    if (result.outcome === OUTCOME.EXECUTED_VERIFIED) return result.result;
                    return {
                        ok: false,
                        denied: result.outcome === OUTCOME.DENIED || result.outcome === OUTCOME.REFUSED,
                        outcome: result.outcome,
                        capabilityId,
                        operation: method,
                        reason: result.reason ?? null,
                        verification: result.verification ?? null
                    };
                };
            }
            return Object.freeze(adapter);
        },

        /** Direct capability execution (used by the production harness).
         *  A caller may supply identity (principal/channel/session) but never an
         *  authority evaluation: the runtime obtains that itself. */
        async execute({ capabilityId, operation, parameters = {}, requestId, identity = {} } = {}) {
            const id = canonicalCapabilityId(capabilityId);
            const spec = CATALOGUE[id];
            if (!spec || !spec.methods.includes(operation)) {
                return { outcome: OUTCOME.REFUSED, reason: "CAPABILITY_UNBOUND", capabilityId: id, operation };
            }
            const auth = await authorizationFor(id, { identity });
            if (!auth.allowed) return denial(id, operation, auth);
            return bridge.execute({ capabilityId: id, operation, parameters, evaluation: auth.evaluation, requestId });
        },

        /** Real driver invocation counter (evidence only; no authority). */
        invocationCount(capabilityId) {
            return invocations.get(canonicalCapabilityId(capabilityId)) ?? 0;
        },

        /**
         * OWNER RATIFICATION BUNDLE — a proposal, not authority. Unsigned and
         * unactivated; nothing here changes what is authorized.
         */
        ratificationProposal({ principal = "owner", scope = [] } = {}) {
            const proposals = Object.entries(CATALOGUE).map(([rawId, spec]) => {
                const capabilityId = canonicalCapabilityId(rawId);
                const body = {
                    capabilityId,
                    family: spec.family,
                    operations: spec.methods,
                    consequenceClass: spec.consequence,
                    mutating: spec.mutating,
                    requestedScope: scope,
                    principal,
                    driver: spec.driver,
                    dependencies: spec.dependencies ?? [],
                    rationale: spec.rationale,
                    recommendedExpiry: "90d",
                    recommendedRevocation: "owner-signed revocation; generation bump invalidates outstanding grants"
                };
                return {
                    ...body,
                    proposalDigest: crypto.createHash("sha256")
                        .update(JSON.stringify({
                            ...body,
                            operations: [...body.operations].sort(),
                            dependencies: [...body.dependencies].sort()
                        }))
                        .digest("hex")
                };
            });
            return Object.freeze({
                kind: "OWNER_RATIFICATION_PROPOSAL",
                status: "UNSIGNED_NOT_ACTIVE",
                note: "Proposal only. PROPOSAL != GRANT. This bundle cannot and does not authorize anything.",
                family: "coding",
                proposals: Object.freeze(proposals)
            });
        }
    };

    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;

/** Composition-time installation. Not a bypass: an installed runtime still needs
 *  a real authority store to authorize anything, and can only be installed once. */
function installCodingCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) {
        throw new TypeError("coding capability runtime was not created by this module");
    }
    if (installed !== null) throw new Error("coding capability runtime already installed");
    installed = runtime;
    return true;
}

/** Production default: no authority store => deny-until-ratified for every
 *  capability, with zero driver invocation. */
function codingRuntime() {
    if (installed === null) installed = createCodingCapabilityRuntime({});
    return installed;
}

module.exports = {
    createCodingCapabilityRuntime,
    installCodingCapabilityRuntime,
    codingRuntime,
    CATALOGUE,
    STATE
};
