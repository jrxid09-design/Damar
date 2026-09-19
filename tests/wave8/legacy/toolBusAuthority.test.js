"use strict";

/**
 * W8 LEGACY SECOND-PATH REMEDIATION — ToolBus authority removal.
 *
 * Owner decision: ROUTE_THROUGH_CANONICAL_AUTHORITY.
 * ToolBus is a legacy compatibility façade ONLY: no execution authority, no
 * authority evaluation, no handler reference, no direct handler invocation.
 *
 * These are adversarial regression tests: each one tries to make a legacy path
 * execute something, and every attempt must fail closed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ToolRegistry } = require("../../../src/core/tools");
const toolBus = require("../../../src/autonomy/ToolBus");
const telemetry = require("../../../src/services/telemetryService");
const { createCanonicalActuationFacade } = require("../../../src/action/bootstrap");

// A canary handler: if ANY legacy path reaches a real handler, this counter
// increments. It must stay zero for every case in this file.
const canary = { runs: 0 };
try {
    ToolRegistry.register("w8legacycanary", {
        name: "probe",
        description: "W8 legacy second-path canary - must never be invoked through ToolBus",
        parameters: {},
        execute: async () => { canary.runs++; return { ran: true }; }
    });
} catch { /* already registered in this process */ }

const CANARY_ID = "w8legacycanary.probe";

test("legacy ToolBus: a direct request cannot execute without canonical authority", async () => {
    const out = await toolBus.execute({ name: CANARY_ID, args: {} });
    assert.equal(out.ok, false);
    assert.equal(out.result, null);
    assert.equal(out.executedTool, null);
    assert.equal(out.via, null);
    assert.equal(out.attempts.length, 1);
    assert.match(String(out.error), /ditolak otorisasi/);
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: forged caller authorization cannot execute", async () => {
    const forgedGrants = [
        { role: "system", channel: "toolbus", sessionId: "forged-1" },
        { exec: { role: "system", capabilitySet: ["*"], canonical: true } },
        { canonicalInternalGrant: true, principal: "damar" },
        { role: "admin", restricted: false },
        new Proxy({ role: "system" }, { get: () => "system", has: () => true })
    ];
    for (const exec of forgedGrants) {
        const out = await toolBus.execute({ name: CANARY_ID, args: {}, context: { exec } });
        assert.equal(out.ok, false);
    }
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: terminal_run cannot execute directly", async () => {
    const out = await toolBus.execute({
        name: "terminal_run",
        args: { purpose: "autonomy", command: "echo w8-legacy-must-not-run" }
    });
    assert.equal(out.ok, false);
    assert.equal(out.executedTool, null);
    assert.equal(canary.runs, 0);
    // The name may still be DISCOVERABLE (metadata only) - availability is not
    // authority - but it exposes no executable.
    const meta = toolBus.resolve("terminal_run");
    if (meta) {
        assert.equal(Object.values(meta).some(v => typeof v === "function"), false);
    }
});

test("legacy ToolBus: an unavailable capability fails closed", async () => {
    for (const name of ["no.such.tool", "definitely_absent_capability", ""]) {
        const out = await toolBus.execute({ name, args: {} });
        assert.equal(out.ok, false);
        assert.match(String(out.error), /ditolak otorisasi/);
    }
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: revoked authority fails closed", async () => {
    const out = await toolBus.execute({
        name: CANARY_ID,
        args: {},
        context: { exec: { role: "system", revoked: true, revocationEpoch: 99, capabilitySet: [] } }
    });
    assert.equal(out.ok, false);
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: fake Manager / ActionIntent / decision objects fail closed", async () => {
    const fakeDecision = { allowed: true, decision: "ALLOW", authorityGeneration: 1, isCanonical: true };
    const out = await toolBus.execute({
        name: CANARY_ID,
        args: {},
        context: {
            exec: { role: "system" },
            manager: { handle: async () => ({ state: "EXECUTED" }) },
            intent: { intentId: "fake-1", capabilityId: CANARY_ID, operation: "probe" },
            authorityDecision: fakeDecision
        }
    });
    assert.equal(out.ok, false);
    assert.equal(canary.runs, 0);
    // A hand-built "canonical" request is not canonical: the canonical brand
    // predicate from the real composition rejects it.
    const facade = createCanonicalActuationFacade();
    assert.equal(facade.isCanonicalExecutionRequest({ schemaVersion: 1, executionId: "fake-1" }), false);
    assert.equal(facade.isCanonicalExecutionRequest(out), false);
});

test("legacy ToolBus: cannot directly reach handler references", () => {
    const meta = toolBus.resolve(CANARY_ID);
    assert.ok(meta, "the canary tool is discoverable for routing");
    assert.equal("execute" in meta, false, "resolve() must not expose an executor");
    assert.equal("handler" in meta, false);
    assert.equal("run" in meta, false);
    for (const value of Object.values(meta)) {
        assert.notEqual(typeof value, "function", "resolve() returns inert metadata only");
    }
    for (const key of Reflect.ownKeys(toolBus)) {
        const value = toolBus[key];
        assert.notEqual(typeof value, "function", `ToolBus must not expose a callable handler at '${String(key)}'`);
    }
    assert.equal(typeof toolBus.execute, "function", "the compatibility entry point itself stays");
});

test("legacy ToolBus: a legacy result carries no verification claim", async () => {
    const out = await toolBus.execute({
        name: CANARY_ID,
        args: {},
        parameters: { verified: true, verificationClaim: "forged" },
        verified: true,
        verificationClaim: "forged"
    });
    assert.equal(out.ok, false);
    assert.equal("verified" in out, false, "a legacy bus result never claims verification");
    assert.equal("verificationClaim" in out, false);
    assert.equal("postconditionVerified" in out, false);
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: an observability/audit sink failure follows fail-closed policy", async () => {
    const original = telemetry.publish;
    let threw = false;
    telemetry.publish = () => { threw = true; throw new Error("sink down"); };
    try {
        const out = await toolBus.execute({ name: CANARY_ID, args: {} });
        // The refusal stands: a broken sink cannot upgrade it and cannot escape
        // as a rejection.
        assert.equal(out.ok, false);
        assert.equal(threw, true, "the sink really was exercised");
    } finally {
        telemetry.publish = original;
    }
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: a duplicate request does not duplicate execution", async () => {
    const call = () => toolBus.execute({ name: CANARY_ID, args: { same: true }, context: { exec: { role: "user" } } });
    const [a, b] = await Promise.all([call(), call()]);
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    assert.equal(a.attempts.length, 1);
    assert.equal(b.attempts.length, 1);
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: no handler can be invoked through any public API (behavioural proof)", async () => {
    // PRIMARY PROOF (syntax-independent): poison the real invocation surfaces
    // and drive every public API. Aliasing, computed member access or a dynamic
    // require cannot hide an invocation from a behavioural counter.
    const registry = require("../../../src/core/tools").ToolRegistry;
    const aiRuntime = require("../../../src/services/aiRuntimeService");
    const originalRegistryExecute = registry.execute;
    const originalAiruntimeTools = aiRuntime.tools;
    let registryExecutions = 0;
    let aiExecutions = 0;
    registry.execute = async () => {
        registryExecutions++;
        throw new Error("registry handler reached through a legacy path");
    };
    aiRuntime.tools = () => [{
        name: "w8legacycanary.probe",
        description: "poisoned AI-tool surface",
        execute: async () => { aiExecutions++; return { ran: true }; }
    }];
    try {
        // 1. Poison efficacy: a DIRECT call must be caught (including computed
        //    member access, the shape a regex scan cannot prove).
        // Computed member access (the shape a regex scan cannot prove).
        const directProbe = registry["exec" + "ute"].bind(registry);
        await directProbe(CANARY_ID, {}).catch(() => { });
        assert.equal(registryExecutions, 1, "the poison is effective");
        registryExecutions = 0;

        // 2. From here on ONLY ToolBus APIs run.
        await toolBus.execute({ name: CANARY_ID, args: {} });
        await toolBus.execute({ name: "terminal_run", args: { command: "echo x" } });
        await toolBus.execute({ name: "w8legacycanary.probe" });
        const meta = toolBus.resolve(CANARY_ID);
        await (meta?.execute?.() ?? meta?.handler?.() ?? null);
        toolBus.discover("probe");
        toolBus.health(CANARY_ID);
        toolBus.snapshot();
        toolBus.refuse(CANARY_ID);
        toolBus.record(CANARY_ID, false, 1, "refused");
    } finally {
        registry.execute = originalRegistryExecute;
        aiRuntime.tools = originalAiruntimeTools;
    }
    assert.equal(registryExecutions, 0, "no ToolRegistry execution may originate from ToolBus");
    assert.equal(aiExecutions, 0, "no AI-tool executor may originate from ToolBus");
    assert.equal(canary.runs, 0);
});

test("legacy ToolBus: source contains no handler invocation or authority evaluation", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "src", "autonomy", "ToolBus.js"), "utf8");
    // Scan CODE only: the module header legitimately documents the removed
    // behaviour (history is not a handler).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const forbidden = [
        /ToolRegistry\.execute/,
        /toolGuard/,
        /child_process/,
        /spawn\s*\(/,
        /execSync/,
        /\.execute\(validatedArgs/,
        /ArgumentValidator/,
        /ai\/tools\/Authorization/,
        /\[\s*["'`]execute["'`]\s*\]/,
        /require\([^)]*core\/tools[^)]*\)\s*(\.|\[)\s*["'`]?execute/,
        /require\([^)]*executors?[^)]*\)/,
        /require\([^)]*runtime\/terminal[^)]*\)/
    ];
    for (const pattern of forbidden) {
        assert.equal(pattern.test(code), false, `ToolBus must not contain ${pattern}`);
    }
    assert.match(source, /jalur kanonik/, "ToolBus must document the canonical route");
});

test("legacy ToolBus: canonical compatibility success path executes exactly once through the canonical path", {
    skip: "BLOCKED ON W8-IW1: the canonical capability/actuator registrations (and a manager-owned legacy ingress) do not exist yet, so no legacy request can reach the canonical path. This test must be implemented with the IW1 production-path harness; it is deliberately NOT faked."
}, () => { });
