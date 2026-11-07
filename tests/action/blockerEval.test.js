"use strict";

/**
 * ACTION AUTHORITY GATE V1 — blocker repair tests (evaluation branding + clock).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseActionIntent, DECISION, isCanonicalAuthorityEvaluation } = require("../../src/action");
const { makeHarness, composeRuntimeOverStore } = require("./helpers");

async function setupAvailable(h, id = "filesystem.read", ops = ["read"]) {
    const res = await h.registerCapability({ id, operations: ops });
    await h.registry.observeAvailability(id, "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
    return res;
}

// ---------------------------------------------------------------------------
// BLOCKER 5: positive evaluation must be BRANDED + gate must be SEALED
// ---------------------------------------------------------------------------

test("B5: gate evaluator/verifier are not replaceable (sealed)", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    const intent = h.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" }
    }));
    const id = h.session("alice");

    // The runtime surface is frozen; the evaluator/verifier are closure-bound.
    assert.ok(Object.isFrozen(h.rt), "runtime surface must be frozen");
    assert.throws(() => { h.rt.evaluate = async () => ({ decision: DECISION.ALLOW }); },
        "reassigning evaluate must throw (frozen)");
    // No writable internals are exposed.
    assert.equal(typeof h.rt._evaluate, "undefined");
    assert.equal(typeof h.rt._isCanonical, "undefined");
    assert.equal(typeof h.rt._registry, "undefined");
    assert.equal(typeof h.rt._clock, "undefined");
    assert.equal(typeof h.rt._authorityContext, "undefined");

    // The real evaluation still runs canonically (deny: no grant).
    const d = await h.rt.evaluate(intent, id);
    assert.equal(d.decision, DECISION.DENY);
});

test("B5: copied/plain canonical-looking AuthorityEvaluation is not canonical", async () => {
    const plainEval = {
        allowed: true,
        reasonCode: "AUTHORIZED",
        snapshot: {
            generation: 0, capabilityId: "filesystem.read", subject: "alice",
            principal: "alice", actions: ["read"], scope: ["safe.target"],
            allowedPurposes: [], identityBinding: null, maxExecutions: null
        }
    };
    assert.equal(isCanonicalAuthorityEvaluation(plainEval), false, "plain object must not be canonical");
    assert.equal(isCanonicalAuthorityEvaluation(JSON.parse(JSON.stringify(plainEval))), false, "clone must not be canonical");
    assert.equal(isCanonicalAuthorityEvaluation(null), false);
    assert.equal(isCanonicalAuthorityEvaluation({ allowed: true }), false);
});

test("B5: canonical evaluator output is accepted (branded)", async () => {
    const h = await makeHarness();
    await setupAvailable(h);
    await h.grantAuthority({ subject: "alice", actions: ["read"] });
    const intent = h.admit(JSON.stringify({
        schemaVersion: 1, capabilityId: "filesystem.read", operation: "read", arguments: { target: "safe.target" }
    }));
    const d = await h.evaluate(intent, h.session("alice"));
    assert.equal(d.decision, DECISION.ALLOW);
});

// ---------------------------------------------------------------------------
// BLOCKER 6: clock capture / timestamp validation
// ---------------------------------------------------------------------------

test("B6: invalid clock values reject at runtime construction / admission", async () => {
    for (const bad of [NaN, Infinity, -1, "x", () => 0, {}, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        // Trusted-bootstrap facility for clock-hardening composition (internal only).
        // The domain's clock stays valid; the RUNTIME receives the hostile clock,
        // proving the runtime's own captureClock validation rejects.
        const composed = composeRuntimeOverStore({
            authorityStore: { getCapability: async () => null, getGeneration: async () => 0, countConsumption: async () => 0 },
            clock: { nowMs: () => 1000 },
            runtimeClock: { nowMs: () => bad },
            authenticate: () => null,
            trustedScopeBindings: { "x.one": { read: () => [] } }
        });
        composed.capabilityRuntime.registrars.core.register(JSON.stringify({
            schemaVersion: 1, id: "x.one", kind: "system", provider: "core", operations: ["read"], requirements: [], effects: []
        }));
        assert.throws(() => composed.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "x.one", operation: "read" })),
            (e) => e.reasonCode === "MALFORMED_INPUT", `bad clock value ${String(bad)} must reject`);
    }
});

test("B6: omitted createdAtMs + invalid default clock => reject", async () => {
    const composed = composeRuntimeOverStore({
        authorityStore: { getCapability: async () => null, getGeneration: async () => 0, countConsumption: async () => 0 },
        clock: { nowMs: () => 1000 },
        runtimeClock: { nowMs: () => NaN },
        authenticate: () => null,
        trustedScopeBindings: { "x.one": { read: () => [] } }
    });
    composed.capabilityRuntime.registrars.core.register(JSON.stringify({
        schemaVersion: 1, id: "x.one", kind: "system", provider: "core", operations: ["read"], requirements: [], effects: []
    }));
    assert.throws(() => composed.rt.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "x.one", operation: "read" })),
        (e) => e.reasonCode === "MALFORMED_INPUT");
});
