"use strict";

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");

/**
 * W8-IW1 Phase 3A — canonical capability execution bridge.
 *
 * The happy path deliberately goes through the REAL authority primitive
 * (loadAndEvaluateAuthority), because a canonical authority evaluation is
 * branded in a closure-private WeakSet: a structural lookalike cannot be
 * fabricated. These tests therefore prove the bridge consumes the existing
 * authority system instead of trusting a shape.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    CanonicalCapabilityExecution,
    OUTCOME,
    REFUSAL,
    isCanonicalCapabilityResult
} = require("../../../src/manager/internal/canonicalCapabilityExecution.js");
const { loadAndEvaluateAuthority } = require("../../../src/authority/evaluate.js");

function grantStore(capabilityId, overrides = {}) {
    const subject = overrides.subject ?? "owner";
    const generation = overrides.generation ?? 0;
    const cap = {
        capabilityId,
        status: overrides.status ?? "ACTIVE",
        generation,
        payload: {
            subject,
            capabilityId,
            kind: "root",
            actions: overrides.actions ?? ["execute"],
            scope: overrides.scope ?? [],
            allowedPurposes: overrides.allowedPurposes ?? [],
            restrictions: overrides.restrictions ?? { kind: "unrestricted" },
            maxExecutions: null,
            identityBinding: null,
            notBefore: null,
            expiresAt: overrides.expiresAt ?? null,
            issuedAt: new Date().toISOString()
        }
    };
    return {
        getCapability: async (id) => (id === capabilityId ? cap : null),
        getGeneration: async () => generation,
        countConsumption: async () => 0
    };
}

async function authorized(capabilityId, request = {}, overrides = {}) {
    return loadAndEvaluateAuthority(
        grantStore(capabilityId, overrides),
        { capabilityId, action: "execute", ...request });
}

function ackedAcknowledger() {
    return (entry) => ({ ok: true, receipt: `ack:${entry.requestId}` });
}

/** A bridge with one always-authorized capability whose driver can be observed. */
async function composed({ capabilityId = "coding.lsp.query", consequential = true, verifier, driver } = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore: createRollbackResistantLedger() });
    const calls = [];
    bridge.registerCapability({
        capabilityId,
        operation: "execute",
        consequential,
        driver: driver ?? (async ({ parameters, requestId }) => {
            calls.push({ parameters, requestId });
            return { changed: true };
        })
    });
    if (verifier) bridge.registerVerifier(capabilityId, verifier);
    bridge.installAuditAcknowledger(ackedAcknowledger());
    const evaluation = await authorized(capabilityId);
    return { bridge, calls, evaluation, capabilityId };
}

const verifyOk = async () => ({ checks: [{ name: "effect", passed: true }] });
const verifyBad = async () => ({ checks: [{ name: "effect", passed: false }] });

test("bridge: authorized + verified + acknowledged request publishes EXECUTED_VERIFIED once", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: { q: 1 }, evaluation });
    assert.equal(result.outcome, OUTCOME.EXECUTED_VERIFIED);
    assert.equal(result.effectInvoked, true);
    assert.equal(calls.length, 1);
    assert.equal(isCanonicalCapabilityResult(result), true);
});

test("bridge: missing authority is DENIED before any driver is resolved", async () => {
    const { bridge, calls, capabilityId } = await composed({ verifier: verifyOk });
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation: null });
    assert.equal(result.outcome, OUTCOME.DENIED);
    assert.equal(result.reason, REFUSAL.AUTHORITY_MISSING);
    assert.equal(calls.length, 0);
});

test("bridge: forged structural evaluation is DENIED (brand-first, no trap triggering)", async () => {
    const { bridge, calls, capabilityId } = await composed({ verifier: verifyOk });
    let trapped = false;
    const hostileSnapshot = new Proxy({ capabilityId }, {
        get(target, prop) {
            trapped = true;
            return target[prop];
        }
    });
    const forged = { allowed: true, reasonCode: "AUTHORIZED", snapshot: hostileSnapshot };
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation: forged });
    assert.equal(result.outcome, OUTCOME.DENIED);
    assert.equal(result.reason, REFUSAL.AUTHORITY_FORGED);
    assert.equal(calls.length, 0);
    assert.equal(trapped, false, "an unbranded evaluation must not have its properties read");
});

test("bridge: genuine evaluation for a different capability is DENIED (binding mismatch)", async () => {
    const { bridge, calls, capabilityId } = await composed({ verifier: verifyOk });
    const other = await authorized("coding.git.patch");
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation: other });
    assert.equal(result.outcome, OUTCOME.DENIED);
    assert.equal(result.reason, REFUSAL.AUTHORITY_MISMATCH);
    assert.equal(calls.length, 0);
});

test("bridge: unregistered capability/operation is REFUSED (registration != authorization)", async () => {
    const { bridge, evaluation } = await composed({ verifier: verifyOk });
    const result = await bridge.execute({
        capabilityId: "coding.lsp.query", operation: "deleteEverything", parameters: {}, evaluation
    });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.CAPABILITY_UNBOUND);
});

test("bridge: caller-supplied function reference is refused before execution", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    const result = await bridge.execute({
        capabilityId, operation: "execute", parameters: { handler: () => 1 }, evaluation
    });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.NON_INERT_REQUEST);
    assert.match(result.detail, /function reference/);
    assert.equal(calls.length, 0);
});

test("bridge: hostile parameter containers are refused (proxy, getter, symbol, class)", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });

    const hostiles = [
        new Proxy({}, {}),
        { get boom() { throw new Error("hostile getter"); } },
        { sym: Symbol("s") },
        { nested: new (class Exotic { constructor() { this.x = 1; } })() }
    ];

    for (const parameters of hostiles) {
        const result = await bridge.execute({ capabilityId, operation: "execute", parameters, evaluation });
        assert.equal(result.outcome, OUTCOME.REFUSED, JSON.stringify(String(result.reason)));
        assert.equal(result.reason, REFUSAL.NON_INERT_REQUEST);
    }
    assert.equal(calls.length, 0);
});

test("bridge: a replayed request cannot invoke the driver twice", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    const request = { capabilityId, operation: "execute", parameters: { q: "same" }, evaluation };

    const first = await bridge.execute(request);
    const second = await bridge.execute(request);

    assert.equal(first.outcome, OUTCOME.EXECUTED_VERIFIED);
    assert.equal(second.outcome, OUTCOME.REFUSED);
    assert.equal(second.reason, REFUSAL.REPLAY);
    assert.equal(second.effectInvoked, false);
    assert.equal(calls.length, 1, "exact-once: the effect happened once");
});

test("bridge: changing parameters after authorization produces a different digest (no cross-replay)", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    await bridge.execute({ capabilityId, operation: "execute", parameters: { q: "one" }, evaluation });
    await bridge.execute({ capabilityId, operation: "execute", parameters: { q: "two" }, evaluation });
    assert.equal(calls.length, 2, "distinct digests are distinct requests");
});

test("bridge: cancellation before invocation yields zero physical effect", async () => {
    const { bridge, calls, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    const controller = new AbortController();
    controller.abort();
    const result = await bridge.execute({
        capabilityId, operation: "execute", parameters: {}, evaluation, signal: controller.signal
    });
    assert.equal(result.outcome, OUTCOME.CANCELLED_BEFORE_EFFECT);
    assert.equal(result.effectInvoked, false);
    assert.equal(calls.length, 0);
});

test("bridge: cancellation after invocation preserves ambiguity, never a prevention claim", async () => {
    const controller = new AbortController();
    const { bridge, evaluation, capabilityId } = await composed({
        verifier: verifyOk,
        driver: async () => {
            controller.abort();
            return { changed: true };
        }
    });
    const result = await bridge.execute({
        capabilityId, operation: "execute", parameters: {}, evaluation, signal: controller.signal
    });
    assert.equal(result.outcome, OUTCOME.AMBIGUOUS_AFTER_INVOCATION);
    assert.equal(result.effectInvoked, true);
});

test("bridge: verification failure cannot yield success", async () => {
    const { bridge, evaluation, capabilityId } = await composed({ verifier: verifyBad });
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
    assert.equal(result.outcome, OUTCOME.UNVERIFIED);
    assert.match(result.reason, /^VERIFICATION_FAILED/);
});

test("bridge: an unverified (no-verifier) consequential capability cannot yield success", async () => {
    const { bridge, evaluation, capabilityId } = await composed({
        capabilityId: "coding.shell.run",
        verifier: undefined
    });
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
    assert.notEqual(result.outcome, OUTCOME.EXECUTED_VERIFIED);
    assert.equal(result.outcome, OUTCOME.UNVERIFIED);
});

test("bridge: a declared non-consequential capability may complete without a verifier", async () => {
    const { bridge, evaluation, capabilityId } = await composed({
        capabilityId: "coding.read.file",
        consequential: false,
        verifier: undefined
    });
    const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
    assert.equal(result.outcome, OUTCOME.EXECUTED_VERIFIED);
});

test("bridge: hostile or malformed driver results fail closed", async () => {
    const cases = [
        { name: "proxy", value: new Proxy({}, {}) },
        { name: "callable", value: () => ({}) },
        { name: "symbol", value: Symbol("x") },
        { name: "class instance", value: new (class R { constructor() { this.ok = true; } })() },
        { name: "undefined", value: undefined }
    ];

    for (const { name, value } of cases) {
        const { bridge, evaluation, capabilityId } = await composed({
            verifier: verifyOk,
            driver: async () => value
        });
        const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
        assert.notEqual(result.outcome, OUTCOME.EXECUTED_VERIFIED, `${name} must not verify`);
        assert.equal(result.outcome, OUTCOME.UNVERIFIED, `${name} must be UNVERIFIED`);
    }
});

test("bridge: a throwing driver is FAILED, and AMBIGUOUS when cancellation raced it", async () => {
    const plain = await composed({ verifier: verifyOk, driver: async () => { throw new Error("boom"); } });
    const failed = await plain.bridge.execute({
        capabilityId: plain.capabilityId, operation: "execute", parameters: {}, evaluation: plain.evaluation
    });
    assert.equal(failed.outcome, OUTCOME.FAILED);
    assert.match(failed.error, /boom/);

    const controller = new AbortController();
    const raced = await composed({
        verifier: verifyOk,
        driver: async () => { controller.abort(); throw new Error("boom"); }
    });
    const ambiguous = await raced.bridge.execute({
        capabilityId: raced.capabilityId, operation: "execute", parameters: {},
        evaluation: raced.evaluation, signal: controller.signal
    });
    assert.equal(ambiguous.outcome, OUTCOME.AMBIGUOUS_AFTER_INVOCATION);
});

test("bridge: audit acknowledgement failure cannot yield canonical success", async () => {
    const cases = [
        { name: "no acknowledger", install: null },
        { name: "throwing acknowledger", install: () => { throw new Error("audit down"); } },
        { name: "async acknowledger", install: async () => ({ ok: true }) },
        { name: "refusing acknowledger", install: () => ({ ok: false }) },
        { name: "malformed ack", install: () => "ok" }
    ];

    for (const { name, install } of cases) {
        const bridge = new CanonicalCapabilityExecution({ replayStore: createRollbackResistantLedger() });
        const calls = [];
        const capabilityId = "coding.git.patch";
        bridge.registerCapability({
            capabilityId, operation: "execute",
            driver: async () => { calls.push(1); return { changed: true }; }
        });
        bridge.registerVerifier(capabilityId, verifyOk);
        if (install) bridge.installAuditAcknowledger(install);
        const evaluation = await authorized(capabilityId);

        const result = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
        assert.notEqual(result.outcome, OUTCOME.EXECUTED_VERIFIED, `${name} must not yield success`);
        assert.equal(result.outcome, OUTCOME.UNVERIFIED);
        assert.equal(result.reason, "AUDIT_NOT_ACKNOWLEDGED");
        assert.equal(calls.length, 1, "the effect still happened; only completion is withheld");
    }
});

test("bridge: malformed requests are typed refusals and never throw", async () => {
    const { bridge } = await composed({ verifier: verifyOk });
    const requests = [
        null,
        new Proxy({}, {}),
        { capabilityId: "UPPER CASE BAD", operation: "execute", parameters: {} },
        { capabilityId: "coding.lsp.query", operation: "", parameters: {} },
        { capabilityId: "coding.lsp.query", operation: "execute", parameters: [], evaluation: undefined }
    ];
    for (const request of requests) {
        const result = await bridge.execute(request);
        assert.ok(isCanonicalCapabilityResult(result));
        assert.notEqual(result.outcome, OUTCOME.EXECUTED_VERIFIED);
    }
});

test("bridge: the driver table is closure-private (no exported resolver)", () => {
    const bridge = new CanonicalCapabilityExecution({ replayStore: createRollbackResistantLedger() });
    const surface = Object.keys(bridge);
    for (const name of surface) {
        assert.ok(!/driver|resolver|resolve|table/i.test(name), `${name} must not expose drivers`);
    }
    const mod = require("../../../src/manager/internal/canonicalCapabilityExecution.js");
    assert.deepEqual(Object.keys(mod).sort(), [
        "CanonicalCapabilityExecution", "OUTCOME", "REFUSAL", "isCanonicalCapabilityResult"
    ]);
    assert.equal(typeof mod.resolveDriver, "undefined");
    assert.equal(typeof mod.getDriver, "undefined");
});

test("bridge: results are branded (a structural lookalike is not canonical)", async () => {
    const { bridge, evaluation, capabilityId } = await composed({ verifier: verifyOk });
    const real = await bridge.execute({ capabilityId, operation: "execute", parameters: {}, evaluation });
    assert.equal(isCanonicalCapabilityResult(real), true);
    assert.equal(isCanonicalCapabilityResult({ ...real }), false);
    assert.equal(isCanonicalCapabilityResult("EXECUTED_VERIFIED"), false);
    assert.equal(isCanonicalCapabilityResult(null), false);
});
