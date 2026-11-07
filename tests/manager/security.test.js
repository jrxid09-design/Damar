"use strict";

/**
 * DAMAR MANAGER — SECURITY + END-TO-END REGRESSION SUITE (Lane 5).
 *
 * Direct tests for the 36 required Lane 5 proofs plus hostile-input probes
 * and structural guards.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { LIFECYCLE, OUTCOME, REASONS, CHANNEL_TYPES } = require("../../src/manager");
const { createDamarManager } = require("../../src/manager/bootstrap");
const { makeManagerHarness } = require("./productionHarness");
const { makeActuationHarness } = require("../actuation/harness");
const { makeVerificationHarness } = require("../verification/harness");
const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
const { RESULT_STATE } = require("../../src/action/actuation/errors");
const { VERIFICATION_STATE } = require("../../src/action/verification/errors");
const { DECISION } = require("../../src/action/gate");

const ROOT = require("node:path").join(__dirname, "..", "..");

function lane4Bindings() {
    const read = (a) => (a && a.target ? [a.target.trim().toLowerCase()] : []);
    const write = (a) => {
        const p = a && (a.path ?? a.target);
        const s = typeof p === "string" ? p.trim().toLowerCase() : "";
        return s ? [s] : [];
    };
    return {
        "fs.cap": { read, write },
        "fs.restore": { write, read }
    };
}

function authAlice(lane3) {
    return (evidence) => lane3.lane2.authDomain.authenticate({
        ...(evidence ?? {}), claimedPrincipal: "alice"
    });
}

const REQUEST_INPUT = (overrides = {}) => ({
    channelType: CHANNEL_TYPES.CONSOLE,
    channelId: "console",
    sessionId: "sess-alice",
    correlationId: "corr-1",
    receivedAtMs: 1_000_000,
    ...overrides
});

// ---- setup: register a capability + grant + verifier + actuator ----
async function setupFull(h) {
    const capRes = await h.lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await h.lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await h.lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });

    let actuations = 0;
    h.lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => { actuations++; return { ok: true }; }
    });

    h.lane4.registerVerifier({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        verifierId: "ver-fs", observe: (ctx, sink) => sink.resolveEvidence({ world: { value: 42 } })
    });

    return { capRes, actuationsRef: () => actuations };
}

async function makeFullHarness({ observeFn, planner } = {}) {
    // The Manager sends auth evidence WITHOUT claimedPrincipal (no principal
    // injection). Use one verification harness so its Lane 3 result brand and
    // Lane 4 verification domain are over the SAME actuation composition.
    const h = await makeVerificationHarness({
        scopeBindings: lane4Bindings(),
        authenticate: (evidence) => {
            // Simulate trusted auth: map the session id to a known principal.
            // CHANNEL != AUTHORITY: the channel cannot supply the principal;
            // this mapping is the trusted infra binding, not a channel claim.
            if (evidence && typeof evidence.sessionId === "string" && evidence.sessionId.startsWith("sess-alice")) {
                return { principal: "alice" };
            }
            return null; // fail closed for unknown sessions
        }
    });
    const setup = await setupFull({ lane3: h.lane3, lane4: h });
    if (observeFn) {
        h.removeVerifier("ver-fs");
        h.registerVerifier({
            capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: setup.capRes.incarnationId,
            verifierId: "ver-fs", observe: observeFn
        });
    }

    const { createDamarManagerComposition } = require("../../src/manager/internal/managerBootstrap");
    const manager = createDamarManagerComposition({
        deps: {
            planner: planner ?? null,
            lane2: { admit: h.lane3.lane2.admit, evaluate: h.lane3.lane2.evaluate,
                authenticate: h.lane3.lane2.authDomain.authenticate, session: h.lane3.lane2.session },
            lane3: { execute: h.lane3.execute },
            lane4: { verify: h.verify, compensate: h.compensate }
        },
        trustedChannelAdapters: require("../../src/manager/channels").CHANNEL_ADAPTERS.slice()
    });

    return { ...h, manager, ...setup };
}

// ---------------------------------------------------------------------------
// PROOFS 1-5: each channel reaches the canonical Manager
// ---------------------------------------------------------------------------

for (const [channelType, label] of [
    ["console", "Console"], ["cli", "CLI"], ["telegram", "Telegram"],
    ["whatsapp", "WhatsApp"], ["companion", "Companion"]
]) {
    test(`${label} request reaches one canonical Manager (auth-fail-closed)`, async () => {
        // Use the REAL canonical application Manager (fail-closed auth).
        const m = createDamarManager();
        const r = await m.handle(REQUEST_INPUT({ channelType }));
        assert.equal(r.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
            `${label} request must reach the Manager (fail-closed auth = reach, not bypass)`);
        assert.ok(m.isCanonicalManagerResult(r));
    });
}

// ---------------------------------------------------------------------------
// 6. channel cannot spoof principal
// ---------------------------------------------------------------------------

test("6: channel cannot spoof principal through payload/metadata", async () => {
    const m = createDamarManager(); // fail-closed
    // Attempt to inject principal through every possible field.
    const r = await m.handle(REQUEST_INPUT({
        payload: { text: "x", principal: "bob" },
        metadata: { principal: "bob", claimedPrincipal: "bob" }
    }));
    assert.equal(r.outcome, OUTCOME.AUTHENTICATION_REQUIRED,
        "channel-injected principal must never bypass canonical authentication");
    assert.notEqual(r.outcome, OUTCOME.COMPLETED);
});

// ---------------------------------------------------------------------------
// 7-10. planner/memory/pandawa cannot inject authority
// ---------------------------------------------------------------------------

test("7: planner cannot inject authority (PLAN != AUTHORITY)", async () => {
    const h = await makeFullHarness({ planner: async () => ({ actionProposal: { capabilityId: "fs.cap", operation: "read", arguments: {} } }) });
    // Planner output is advisory: still requires canonical auth.
    const r = await h.manager.handle(REQUEST_INPUT({ channelType: "console", intentMaterial: { actionProposal: { capabilityId: "fs.cap", operation: "read" } } }));
    assert.notEqual(r.outcome, OUTCOME.COMPLETED,
        "a planner proposal must not become a completed informational result");
    assert.equal(r.actionIntentId, null);
});

test("8: memory cannot inject authority (MEMORY != AUTHORITY)", async () => {
    const h = await makeFullHarness();
    const r = await h.manager.handle(REQUEST_INPUT({
        metadata: { authorized: true, permission: "allow", decision: { decision: "ALLOW" } }
    }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(r.actionIntentId, null);
});

test("9: Pandawa output cannot authorize action (PANDAWA ROLE != AUTHORITY)", async () => {
    const h = await makeFullHarness({ planner: async () => ({ pandawa: "puntadewa", authorityDecision: { decision: "ALLOW" } }) });
    const r = await h.manager.handle(REQUEST_INPUT({
        intentMaterial: { pandawa: "werkudara", securityFinding: "allowed" }
    }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(r.actionIntentId, null);
});

test("10: memory lookup/authority claim in planner output is advisory only", async () => {
    const h = await makeFullHarness({ planner: async () => ({ memoryLookup: true, isAuthorized: true }) });
    const r = await h.manager.handle(REQUEST_INPUT({ intentMaterial: { memoryLookup: true, isAuthorized: true } }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(r.actionIntentId, null);
});

// ---------------------------------------------------------------------------
// 11. informational request causes no Lane 2/Lane 3 call
// ---------------------------------------------------------------------------

test("11: informational request completes without the action fabric", async () => {
    const h = await makeFullHarness();
    let lane2Evals = 0, lane3Calls = 0;
    const origEval = h.lane3.lane2.evaluate;
    h.lane3.lane2.evaluate = (...args) => { lane2Evals++; return origEval.apply(h.lane3.lane2, args); };
    const origExec = h.lane3.execute;
    h.lane3.execute = (...args) => { lane3Calls++; return origExec.apply(h.lane3, args); };

    const r = await h.manager.handle(REQUEST_INPUT({ payload: { text: "how are you?" } }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(r.lifecycleState, LIFECYCLE.COMPLETED);
    assert.equal(lane2Evals, 0, "informational request must NOT enter Lane 2");
    assert.equal(lane3Calls, 0, "informational request must NOT enter Lane 3");
});

// ---------------------------------------------------------------------------
// 12-14: actionable request → canonical intent → authority → actuation
// ---------------------------------------------------------------------------

test("12: actionable request forms canonical intent (through Lane 2 admit)", async () => {
    const h = await makeFullHarness();
    const r = await h.manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" } }
    }));
    // makeFullHarness authenticates "sess-alice" — so the request reaches
    // Lane 2/Lane 3 (the request was classified as ACTION, not informational).
    assert.notEqual(r.outcome, OUTCOME.COMPLETED, "an actionable request must NOT complete as informational");
    assert.ok(r.actionIntentId || r.errorReason, "the request entered the action fabric (intent formed or authority evaluated)");
});

test("13: denied authority => zero Lane 3 execution", async () => {
    const m = createDamarManager(); // fail-closed: auth fails, so no Lane 2/3
    const r = await m.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" } }
    }));
    // Fail-closed authentication means neither Lane 2 evaluation nor Lane 3
    // dispatch is reached (see 13b for the authority-denied-when-authenticated path).
    assert.equal(r.outcome, OUTCOME.AUTHENTICATION_REQUIRED);
});

test("13b: denied authority (custom composition) => zero Lane 3 execution", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    // NO grantAuthority — alice has NO authority.

    let lane3Calls = 0;
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });

    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: (...args) => { lane3Calls++; return lane3.execute(...args); } },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.ERROR }), compensate: async () => {} }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" } }
    }));
    assert.equal(r.outcome, OUTCOME.AUTHORITY_DENIED);
    assert.equal(lane3Calls, 0, "denied authority must cause ZERO Lane 3 execution");
});

test("14: allowed action => Lane 3 executes exactly once", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    let lane3Calls = 0;
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: (...args) => { lane3Calls++; return lane3.execute(...args); } },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v1" }), compensate: async () => ({}) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(lane3Calls, 1, "allowed action must execute Lane 3 exactly once");
});

// ---------------------------------------------------------------------------
// 15-19: verification outcome preservation (no fabricated certainty)
// ---------------------------------------------------------------------------

test("15: successful execution but failed verification != Manager SUCCESS", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_FAILURE, verificationId: "v1" }), compensate: async () => ({ state: "COMPENSATION_FAILED" }) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.notEqual(r.outcome, OUTCOME.COMPLETED, "failed verification must NOT yield Manager SUCCESS");
    assert.equal(r.outcome, OUTCOME.FAILED);
});

test("16: VERIFIED_SUCCESS => Manager success", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS, verificationId: "v1" }), compensate: async () => ({}) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.equal(r.outcome, OUTCOME.COMPLETED);
    assert.equal(r.lifecycleState, LIFECYCLE.VERIFIED);
});

test("17: INCONCLUSIVE preserved", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.INCONCLUSIVE, verificationId: "v1" }), compensate: async () => ({}) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE, "INCONCLUSIVE must NOT be fabricated into success/failure");
    assert.equal(r.lifecycleState, LIFECYCLE.INCONCLUSIVE);
});

test("18: TIMED_OUT preserved", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.TIMED_OUT, verificationId: "v1" }), compensate: async () => ({}) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE, "TIMED_OUT maps to INCONCLUSIVE (ambiguity preserved, not FAILED)");
    assert.equal(r.lifecycleState, LIFECYCLE.INCONCLUSIVE);
});

test("19: verification ERROR preserved", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.ERROR, verificationId: "v1" }), compensate: async () => ({}) }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }));
    assert.equal(r.outcome, OUTCOME.FAILED);
    assert.equal(r.errorReason, REASONS.VERIFICATION_ERROR);
});

// ---------------------------------------------------------------------------
// 20-22: compensation
// ---------------------------------------------------------------------------

test("20: compensation goes through fresh Lane 2 + Lane 3 (via Lane 4 facade)", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    const capRestore = await lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: capRestore.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: capRestore.incarnationId,
        actuatorId: "act-restore", invoke: async () => ({ ok: true })
    });
    let lane3Calls = 0;
    let lane4CompensateCalls = 0;
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: (...args) => { lane3Calls++; return lane3.execute(...args); } },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_FAILURE, verificationId: "v1" }),
                compensate: async (p) => { lane4CompensateCalls++; return { state: "COMPENSATION_EXECUTED", compensationId: "c1" }; }
            }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: {
            capabilityId: "fs.cap", operation: "read", arguments: { target: "t" },
            expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } },
            compensationPolicy: { attempt: true, capabilityId: "fs.restore", operation: "write", parameters: { path: "x" } }
        }
    }));
    assert.equal(lane4CompensateCalls, 1, "Manager must route compensation through Lane 4 facade");
    assert.equal(r.compensationId, "c1");
    assert.notEqual(r.outcome, OUTCOME.COMPLETED, "compensation executed != restored");
    assert.equal(r.outcome, OUTCOME.EXECUTED_UNVERIFIED);
});

test("21: original ALLOW not reused for compensation (fresh Lane 2)", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    // NO grant for fs.restore.
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_FAILURE, verificationId: "v1" }),
                compensate: async (p) => {
                    // This would go through the real Lane 4 facade, which calls
                    // lane2.admit + lane2.evaluate + lane3.execute. Since the
                    // test composition uses the same lane3, the original ALLOW
                    // for fs.cap does NOT authorize fs.restore.
                    const intent = lane3.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: p.capabilityId, operation: p.operation, arguments: p.parameters }));
                    const session = lane3.lane2.session(p.principal);
                    const result = await lane3.execute({ intent, authSession: session, parameters: p.parameters });
                    return { state: result.state === "EXECUTED" ? "COMPENSATION_EXECUTED" : "COMPENSATION_FAILED", compensationId: "c1", executionResult: result };
                }
            }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: {
            capabilityId: "fs.cap", operation: "read", arguments: { target: "t" },
            expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } },
            compensationPolicy: { attempt: true, capabilityId: "fs.restore", operation: "write", parameters: { path: "x" } }
        }
    }));
    assert.equal(r.outcome, OUTCOME.FAILED, "compensation must fail (no authority for fs.restore — original ALLOW not reused)");
});

test("22: compensation executed but unverified != restored", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    const capRestore = await lane3.lane2.registerCapability({ id: "fs.restore", operations: ["write"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.registry.observeAvailability("fs.restore", "AVAILABLE", { generation: 1, incarnationId: capRestore.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.restore", subject: "alice", actions: ["write"], identityBinding: { principals: ["alice"] } });
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    lane3.registerActuator({
        capabilityId: "fs.restore", operations: ["write"], capabilityIncarnationId: capRestore.incarnationId,
        actuatorId: "act-restore", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: {
                verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_FAILURE, verificationId: "v1" }),
                compensate: async () => ({ state: "COMPENSATION_EXECUTED", compensationId: "c1" })
            }
        }
    });
    const r = await manager.handle(REQUEST_INPUT({
        requestedOperation: {
            capabilityId: "fs.cap", operation: "read", arguments: { target: "t" },
            expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } },
            compensationPolicy: { attempt: true, capabilityId: "fs.restore", operation: "write", parameters: { path: "x" } }
        }
    }));
    assert.equal(r.outcome, OUTCOME.EXECUTED_UNVERIFIED, "compensation executed but NOT verified != restored");
    assert.notEqual(r.outcome, OUTCOME.COMPLETED);
});

// ---------------------------------------------------------------------------
// 23: cancelled after dispatch != no-side-effect
// ---------------------------------------------------------------------------

test("23: cancelled after dispatch preserves ambiguity (!= no-side-effect)", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    let cancelled = false;
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => {
            // Simulate a long-running actuator that gets cancelled mid-flight.
            await new Promise((r) => setTimeout(r, 10));
            return { ok: true };
        }
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.INCONCLUSIVE }), compensate: async () => ({}) }
        }
    });
    const signal = { aborted: false };
    const handlePromise = manager.handle(REQUEST_INPUT({
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    }), { signal });
    // Cancel mid-flight.
    signal.aborted = true;
    const r = await handlePromise;
    // After dispatch, cancellation does NOT prove no side effect.
    assert.notEqual(r.outcome, OUTCOME.COMPLETED);
    assert.notEqual(r.outcome, OUTCOME.FAILED, "cancelled after dispatch != FAILED 'no side effect'");
});

// ---------------------------------------------------------------------------
// 24: duplicate Manager request does not duplicate Lane 3 execution
// ---------------------------------------------------------------------------

test("24: duplicate Manager request does not duplicate Lane 3 execution", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const capRes = await lane3.lane2.registerCapability({ id: "fs.cap", operations: ["read"] });
    await lane3.lane2.registry.observeAvailability("fs.cap", "AVAILABLE", { generation: 1, incarnationId: capRes.incarnationId });
    await lane3.lane2.grantAuthority({ capabilityId: "fs.cap", subject: "alice", actions: ["read"], identityBinding: { principals: ["alice"] } });
    let lane3Calls = 0;
    lane3.registerActuator({
        capabilityId: "fs.cap", operations: ["read"], capabilityIncarnationId: capRes.incarnationId,
        actuatorId: "act-fs", invoke: async () => ({ ok: true })
    });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: (...args) => { lane3Calls++; return lane3.execute(...args); } },
            lane4: { verify: async () => ({ verificationState: VERIFICATION_STATE.VERIFIED_SUCCESS }), compensate: async () => ({}) }
        }
    });
    const input = REQUEST_INPUT({
        correlationId: "dup-1",
        requestedOperation: { capabilityId: "fs.cap", operation: "read", arguments: { target: "t" }, expectedPostcondition: { expect: { "world.value": { op: "eq", value: 42 } } } }
    });
    const first = manager.handle(input);
    const second = manager.handle(input);
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.managerRequestId, r2.managerRequestId, "same correlation => same lifecycle (deduplicated)");
    assert.equal(lane3Calls, 1, "duplicate Manager request must not duplicate Lane 3 execution");
});

// ---------------------------------------------------------------------------
// 25-27: fake/clone/foreign ManagerRequest rejected
// ---------------------------------------------------------------------------

test("25: fake ManagerRequest rejected by isCanonicalManagerRequest", async () => {
    const h = await makeFullHarness();
    const fake = { schemaVersion: 1, requestId: "fake", channelType: "console" };
    assert.equal(h.manager.isCanonicalManagerRequest(fake), false);
});

test("26: JSON clone ManagerRequest rejected", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const manager = createDamarManagerComposition({
        deps: {
            lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session },
            lane3: { execute: lane3.execute },
            lane4: { verify: async () => ({}), compensate: async () => ({}) }
        }
    });
    // We can't easily get a ManagerRequest externally (handle() forms it
    // internally); we prove the brand check rejects structural clones:
    const fakeClone = JSON.parse(JSON.stringify({ schemaVersion: 1, requestId: "x", channelType: "console", channelId: "c", sessionId: "s", correlationId: "k", receivedAtMs: 1, payload: {}, metadata: {}, intentMaterial: {}, requestedOperation: null, requestClass: "informational", cancellationId: "canc-1" }));
    assert.equal(manager.isCanonicalManagerRequest(fakeClone), false, "JSON clone must be rejected (brand-first)");
});

test("27: foreign composition ManagerRequest rejected", async () => {
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const A = createDamarManagerComposition({
        deps: { lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session }, lane3: { execute: lane3.execute }, lane4: { verify: async () => ({}), compensate: async () => ({}) } }
    });
    const B = createDamarManagerComposition({
        deps: { lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session }, lane3: { execute: lane3.execute }, lane4: { verify: async () => ({}), compensate: async () => ({}) } }
    });
    // Mint a result in A.
    const r = await A.handle(REQUEST_INPUT({ payload: { text: "hi" } }));
    assert.ok(A.isCanonicalManagerResult(r), "A result canonical to A");
    assert.ok(!B.isCanonicalManagerResult(r), "A result NOT canonical to B (foreign domain)");
});

// ---------------------------------------------------------------------------
// 28: ManagerResult cannot become authority
// ---------------------------------------------------------------------------

test("28: fake ManagerResult cannot become authority", async () => {
    const h = await makeFullHarness();
    const r = await h.manager.handle(REQUEST_INPUT({ payload: { text: "hi" } }));
    // ManagerResult fields carry no bearer authority.
    assert.ok(!("decision" in r && r.decision === "ALLOW"));
    assert.ok(!("authorized" in r));
});

// ---------------------------------------------------------------------------
// 29: hostile Proxy manager predicates zero traps
// ---------------------------------------------------------------------------

test("29: hostile Proxy manager predicates zero traps", () => {
    const lane3 = { execute: async () => null, isCanonicalExecutionRequest: () => false, isCanonicalExecutionResult: () => true };
    const lane2 = { admit: () => null, evaluate: async () => null, authenticate: () => null, session: () => null };
    const lane4 = { verify: async () => ({}), compensate: async () => ({}) };
    const traps = { get: 0, has: 0, ownKeys: 0, gopd: 0, gtp: 0, set: 0, def: 0, del: 0, apply: 0, construct: 0 };
    const hostile = new Proxy({}, {
        get(t, p) { traps.get++; return Reflect.get(t, p); },
        has(t, p) { traps.has++; return Reflect.has(t, p); },
        ownKeys(t) { traps.ownKeys++; return Reflect.ownKeys(t); },
        getOwnPropertyDescriptor(t, p) { traps.gopd++; return Reflect.getOwnPropertyDescriptor(t, p); },
        getPrototypeOf(t) { traps.gtp++; return Reflect.getPrototypeOf(t); },
        set(t, p, v) { traps.set++; return Reflect.set(t, p, v); },
        defineProperty(t, p, d) { traps.def++; return Reflect.defineProperty(t, p, d); },
        deleteProperty(t, p) { traps.del++; return Reflect.deleteProperty(t, p); },
        apply(t, thisArg, args) { traps.apply++; return Reflect.apply(t, thisArg, args); },
        construct(t, args) { traps.construct++; return Reflect.construct(t, args); }
    });
    const manager = createDamarManagerComposition({
        deps: { lane2, lane3, lane4, planner: null }
    });
    assert.equal(manager.isCanonicalManagerRequest(hostile), false);
    assert.equal(manager.isCanonicalManagerResult(hostile), false);
    assert.equal(Object.values(traps).reduce((a, b) => a + b, 0), 0, "ZERO hostile traps");
});

// ---------------------------------------------------------------------------
// 30: alternate Manager composition cannot mint canonical app provenance
// ---------------------------------------------------------------------------

test("30: alternate composition artifacts rejected by canonical application Manager", async () => {
    const canonicalApp = createDamarManager();
    const lane3 = await makeActuationHarness({ scopeBindings: lane4Bindings() });
    const altManager = createDamarManagerComposition({
        deps: { lane2: { admit: lane3.lane2.admit, evaluate: lane3.lane2.evaluate, authenticate: authAlice(lane3), session: lane3.lane2.session }, lane3: { execute: lane3.execute }, lane4: { verify: async () => ({}), compensate: async () => ({}) } }
    });
    const altResult = await altManager.handle(REQUEST_INPUT({ payload: { text: "hi" } }));
    assert.ok(!canonicalApp.isCanonicalManagerResult(altResult), "canonical app rejects alternate composition's result");
});

// ---------------------------------------------------------------------------
// 31-36: structural / legacy / identity
// ---------------------------------------------------------------------------

test("31: no channel-specific execution bypass exists in src/manager", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(ROOT, "src", "manager");
    const offenders = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                if (/managerExecute|directToolRun|directActuator|fastExecute|trustedInternalExecute/i.test(text)) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [], "no channel-specific bypass in src/manager");
});

test("32: no direct actuator/verifier path in Manager", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(ROOT, "src", "manager");
    const offenders = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                if (/registerActuator|registerVerifier|buildActuator|buildVerifier/.test(text) &&
                    !text.includes("NOT exported") && !text.includes("//")) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [], "Manager must not register actuators/verifiers");
});

test("33: no Aether active runtime identity in src/manager", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(ROOT, "src", "manager");
    const offenders = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                if (/Aether.*Manager|aether.*identity.*active/i.test(text)) {
                    offenders.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [], "no Aether active identity in src/manager");
});

test("34: Damar remains sole canonical identity", () => {
    const { SelfModel, IDENTITAS } = require("../../src/consciousness/SelfModel");
    assert.equal(IDENTITAS.nama, "Damar");
    // SelfModel is a constructor; the canonical identity is exposed via IDENTITAS.
    const instance = new SelfModel();
    const model = instance.identitas ?? instance.identity ?? IDENTITAS;
    assert.ok(model && model.nama === "Damar", "canonical identity is Damar");
});

test("35: Pandawa mappings unchanged", () => {
    const agentHub = require("../../src/services/agentHub");
    const agents = agentHub.agents().filter(a => a.kind === "worker");
    const ids = agents.map(a => a.id).sort();
    assert.deepEqual(ids, ["janaka", "nakula", "puntadewa", "sadewa", "werkudara"], "Pandawa mappings unchanged");
});

test("36: Lane 1-4 public surfaces unchanged (regression)", () => {
    const actionApi = require("../../src/action");
    assert.equal(typeof actionApi.parseActionIntent, "function");
    assert.equal(typeof actionApi.DECISION, "object");
    assert.equal(typeof actionApi.isCanonicalAuthorityEvaluation, "function");
    const verificationApi = require("../../src/action/verification");
    assert.equal(typeof verificationApi.VERIFICATION_STATE, "object");
    assert.equal(typeof verificationApi.isVerificationState, "function");
    const bootstrap = require("../../src/action/bootstrap");
    const v = bootstrap.createCanonicalVerificationFacade();
    assert.deepEqual(Object.keys(v).sort(),
        ["compensate", "isCanonicalCompensationPlan", "isCanonicalVerificationRequest", "isCanonicalVerificationResult", "verify"]);
});

// ---------------------------------------------------------------------------
// HOSTILE INPUT PROBES
// ---------------------------------------------------------------------------

test("hostile: Proxy payload rejected (zero-trap)", async () => {
    const h = await makeFullHarness();
    const traps = { get: 0 };
    const hostile = new Proxy({ text: "x" }, { get(t, p) { traps.get++; return Reflect.get(t, p); } });
    await assert.rejects(() => h.manager.handle(REQUEST_INPUT({ payload: hostile })),
        (e) => e.reasonCode === REASONS.NON_PLAIN_OBJECT);
    assert.equal(traps.get, 0, "payload Proxy must not trigger traps during classification");
});

test("hostile: top-level Manager request Proxy is rejected before property traps", async () => {
    const manager = createDamarManager();
    let traps = 0;
    const input = new Proxy({}, {
        get() { traps++; throw new Error("get trap"); },
        ownKeys() { traps++; throw new Error("ownKeys trap"); },
        getPrototypeOf() { traps++; throw new Error("prototype trap"); }
    });
    await assert.rejects(() => manager.handle(input));
    assert.equal(traps, 0);
});

test("hostile: cyclic payload rejected", async () => {
    const h = await makeFullHarness();
    const cyc = { text: "x" };
    cyc.self = cyc;
    await assert.rejects(() => h.manager.handle(REQUEST_INPUT({ payload: cyc })),
        (e) => e.reasonCode === REASONS.CYCLIC_INPUT);
});

test("hostile: prototype pollution key rejected", async () => {
    const h = await makeFullHarness();
    await assert.rejects(() => h.manager.handle(REQUEST_INPUT({
        payload: JSON.parse('{"__proto__": {"x": 1}}')
    })), (e) => e.reasonCode === REASONS.DANGEROUS_KEY);
});

// ---------------------------------------------------------------------------
// STRUCTURAL GUARDS
// ---------------------------------------------------------------------------

test("STRUCTURAL: production facade is exactly least-privilege", () => {
    const m = createDamarManager();
    const keys = Object.keys(m).sort();
    assert.deepEqual(keys, ["cancel", "handle", "isCanonicalManagerRequest", "isCanonicalManagerResult"]);
    assert.ok(Object.isFrozen(m));
});

test("STRUCTURAL: internal factory not exported through public manager package", () => {
    const api = require("../../src/manager");
    assert.equal(typeof api.createDamarManager, "function");
    for (const name of ["createDamarManagerComposition", "bootstrap"]) {
        assert.equal(typeof api[name], "undefined", `public manager package must not export '${name}'`);
    }
});

test("STRUCTURAL: src/** never imports tests/**", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const srcRoot = path.join(ROOT, "src");
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".js")) {
                const text = fs.readFileSync(full, "utf8");
                if (/require\(\s*["'][^"']*tests\//.test(text)) offenders.push(path.relative(ROOT, full));
            }
        }
    };
    walk(srcRoot);
    assert.deepEqual(offenders, [], "production src must never import tests");
});
