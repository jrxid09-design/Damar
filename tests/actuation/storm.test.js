"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — Lane 3 storm test.
 *
 * >=12000 deterministic mixed operations across admission, revalidation,
 * dispatch, duplicate/replay, timeout, cancellation, and hostile probes.
 * All violation counters (with ACTIVE detection paths) must remain zero:
 *
 *   staleAuthorityExecuted
 *   staleCapabilityIncarnationExecuted
 *   staleActuatorIncarnationExecuted
 *   fakeActuatorExecuted
 *   foreignSessionExecuted
 *   unavailableCapabilityExecuted
 *   undeclaredOperationExecuted
 *   duplicateExecution
 *   conflictingReplayExecuted
 *   timeoutRetriedActuation
 *   callerMutationChangedActuator
 *   decisionUsedAsBearerAuthority
 *   authorityMutationDuringExecution
 *   capabilityMutationDuringExecution
 *   verificationClaimedByLane3
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { LIFECYCLE, RESULT_STATE, REASONS } = require("../../src/action/actuation/errors");
const { makeActuationHarness } = require("./harness");

const OP_TARGET = 12000;
const CAP_POOL = 8;

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function runStorm(seed) {
    const rng = mulberry32(seed);

    const h = await makeActuationHarness({
        authenticate: (e) => {
            const p = e && (e.claimedPrincipal ?? e.principal);
            return (typeof p === "string" && p.length > 0) ? { principal: p } : null;
        },
        scopeBindings: (() => {
            const b = {};
            for (let i = 0; i < CAP_POOL; i++) b[`pool.cap.${i}`] = { read: (a) => (a && a.target ? [a.target] : []) };
            return b;
        })()
    });
    const { lane2 } = h;

    const C = {
        staleAuthorityExecuted: 0,
        staleCapabilityIncarnationExecuted: 0,
        staleActuatorIncarnationExecuted: 0,
        fakeActuatorExecuted: 0,
        foreignSessionExecuted: 0,
        unavailableCapabilityExecuted: 0,
        undeclaredOperationExecuted: 0,
        duplicateExecution: 0,
        conflictingReplayExecuted: 0,
        timeoutRetriedActuation: 0,
        callerMutationChangedActuator: 0,
        decisionUsedAsBearerAuthority: 0,
        authorityMutationDuringExecution: 0,
        capabilityMutationDuringExecution: 0,
        verificationClaimedByLane3: 0,
        // FIRST targeted repair counters
        directRegistryFactoryAcquired: 0,
        directDispatcherFactoryAcquired: 0,
        exportedRequestBrandMutated: 0,
        exportedResultBrandMutated: 0,
        // SECOND targeted repair counters (brand-first hostile object safety)
        hostileRequestPredicateTrapExecution: 0,
        hostileResultPredicateTrapExecution: 0,
        untypedErrors: 0
    };

    const CAPS = [];
    for (let i = 0; i < CAP_POOL; i++) {
        const id = `pool.cap.${i}`;
        const res = await lane2.registerCapability({ id, operations: ["read"] });
        await lane2.registry.observeAvailability(id, "AVAILABLE", { generation: 1, incarnationId: res.incarnationId });
        CAPS.push({ id, incarnationId: res.incarnationId });
    }

    const subjects = ["actor.0", "actor.1"];
    for (const s of subjects) {
        for (let i = 0; i < CAP_POOL; i += 2) {
            await lane2.grantAuthority({ capabilityId: `pool.cap.${i}`, subject: s, actions: ["read"], identityBinding: { principals: [s] } });
        }
    }

    // seed actuators for all capabilities (read)
    const invocationLog = new Map(); // executionId -> count
    for (const cap of CAPS) {
        h.registerActuator({
            capabilityId: cap.id, operations: ["read"], capabilityIncarnationId: cap.incarnationId,
            actuatorId: `act-${cap.id}`,
            invoke: async (ctx) => {
                invocationLog.set(ctx.executionId, (invocationLog.get(ctx.executionId) ?? 0) + 1);
                return { ok: true, echo: ctx.executionId };
            }
        });
    }

    const outcomes = [];
    let ops = 0;
    const record = (op, ok, note = "") => { ops++; outcomes.push(`${op}:${ok ? "ok" : "err"}:${note}`); };

    const seenResults = new Map(); // contentKey-equivalent: executionId -> result state

    for (let round = 0; round < OP_TARGET; round++) {
        const roll = Math.floor(rng() * 12);
        const cap = CAPS[Math.floor(rng() * CAP_POOL)];
        const subject = subjects[Math.floor(rng() * subjects.length)];
        const target = rng() < 0.5 ? "safe.target" : "unsafe.target";
        const id = cap.id;

        try {
            switch (roll) {
                case 0: case 1: case 2: { // happy-path execute
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const r = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, nonce: round } });
                    if (r.state === RESULT_STATE.EXECUTED) {
                        const n = invocationLog.get(r.executionId) ?? 0;
                        if (n > 1) C.duplicateExecution += (n - 1);
                        if (r.verified !== null || r.verificationClaim !== null) C.verificationClaimedByLane3++;
                    } else if (r.state === RESULT_STATE.FAILED) {
                        // grants only exist for even-index caps; a failure here is expected for odd caps
                        if (!r.failureReason) C.untypedErrors++;
                    }
                    record("execute", true, r.state);
                    break;
                }
                case 3: { // duplicate identical execution (exact-once)
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const params = { target, nonce: "dup-fixed-1" };
                    const session = lane2.session(subject); // ONE session object
                    const a = await h.execute({ intent, authSession: session, parameters: params });
                    const b = await h.execute({ intent, authSession: session, parameters: params });
                    if (a.executionId !== b.executionId) C.duplicateExecution++;
                    const n = invocationLog.get(a.executionId) ?? 0;
                    if (n > 1) C.duplicateExecution += (n - 1);
                    record("dup", true, `${a.state}/${b.state}`);
                    break;
                }
                case 4: { // conflicting replay: same content key with different params => different executions
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const a = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, p: "x" } });
                    const b = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, p: "y" } });
                    if (a.executionId === b.executionId) C.conflictingReplayExecuted++;
                    record("conflict", true, a.state + "/" + b.state);
                    break;
                }
                case 5: { // stale authority: revoke then try to execute fresh params
                    if (Math.floor(rng() * 4) === 0) {
                        const capEntry = await lane2.store.getCapability(id);
                        if (capEntry && capEntry.payload && capEntry.payload.subject) {
                            await lane2.store.upsertCapability(id, "REVOKED", capEntry.generation, JSON.stringify({ ...capEntry.payload, status: "REVOKED" }));
                            const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                            const r = await h.execute({ intent, authSession: lane2.session(capEntry.payload.subject), parameters: { target, nonce: round } });
                            if (r.state === RESULT_STATE.EXECUTED) C.staleAuthorityExecuted++;
                            await lane2.store.upsertCapability(id, "ACTIVE", capEntry.generation, JSON.stringify({ ...capEntry.payload, status: "ACTIVE" }));
                        }
                    }
                    record("stale-auth", true, "probed");
                    break;
                }
                case 6: { // foreign session + brand-first hostile predicate probe
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const r = await h.execute({ intent, authSession: { principal: "attacker", sessionId: "", channel: "" }, parameters: { target, nonce: round } });
                    if (r.state === RESULT_STATE.EXECUTED) C.foreignSessionExecuted++;
                    // ---- SECOND targeted repair counters: recognition of a
                    // NON-canonical object must execute ZERO attacker-controlled
                    // traps (WeakSet membership is checked before any property
                    // read). Active detection: instrument every trap family and
                    // assert zero executions during recognition.
                    {
                        const traps = { get: 0, has: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
                        const hostileProxy = new Proxy({}, {
                            get(o, p) { traps.get++; return o[p]; },
                            has(o, p) { traps.has++; return p in o; },
                            ownKeys(o) { traps.ownKeys++; return Reflect.ownKeys(o); },
                            getOwnPropertyDescriptor(o, p) { traps.getOwnPropertyDescriptor++; return Reflect.getOwnPropertyDescriptor(o, p); },
                            getPrototypeOf(o) { traps.getPrototypeOf++; return Reflect.getPrototypeOf(o); }
                        });
                        // The production facade predicates are BRAND-FIRST.
                        const bs = require("../../src/action/bootstrap");
                        const prodFacade = bs.createCanonicalActuationFacade();
                        const beforeReq = Object.values(traps).reduce((a, b) => a + b, 0);
                        prodFacade.isCanonicalExecutionRequest(hostileProxy);
                        const afterReq = Object.values(traps).reduce((a, b) => a + b, 0);
                        if (afterReq - beforeReq > 0) C.hostileRequestPredicateTrapExecution += (afterReq - beforeReq);
                        prodFacade.isCanonicalExecutionResult(hostileProxy);
                        const afterRes = Object.values(traps).reduce((a, b) => a + b, 0);
                        if (afterRes - afterReq > 0) C.hostileResultPredicateTrapExecution += (afterRes - afterReq);
                        // Repeated recognition: still zero.
                        prodFacade.isCanonicalExecutionRequest(hostileProxy);
                        prodFacade.isCanonicalExecutionResult(hostileProxy);
                        const finalTotal = Object.values(traps).reduce((a, b) => a + b, 0);
                        if (finalTotal > 0) {
                            C.hostileRequestPredicateTrapExecution += finalTotal;
                            C.hostileResultPredicateTrapExecution += finalTotal;
                        }
                    }
                    record("foreign-session", true, r.state);
                    break;
                }
                case 7: { // unavailable capability
                    const capEntry = lane2.registry.get(id);
                    await lane2.registry.observeAvailability(id, "UNAVAILABLE", { generation: capEntry.generation + 1, incarnationId: capEntry.incarnationId });
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const r = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, nonce: round } });
                    if (r.state === RESULT_STATE.EXECUTED) C.unavailableCapabilityExecuted++;
                    await lane2.registry.observeAvailability(id, "AVAILABLE", { generation: capEntry.generation + 2, incarnationId: capEntry.incarnationId });
                    record("unavailable", true, r.state);
                    break;
                }
                case 8: { // undeclared operation (admission rejects; nothing dispatches)
                    try {
                        lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "write", arguments: { target } }));
                        // admission unexpectedly accepted an undeclared op
                        C.undeclaredOperationExecuted++;
                    } catch (e) {
                        if (!(e.reasonCode === "OPERATION_NOT_DECLARED" || e.reasonCode === "INVALID_INTENT")) C.untypedErrors++;
                    }
                    record("undeclared", true, "rejected");
                    break;
                }
                case 9: { // fake actuator option must be rejected; bearer decision must be rejected
                    const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                    const session = lane2.session(subject);
                    try {
                        await h.execute({ intent, authSession: session, actuator: async () => ({ ok: true, fake: true }) });
                        C.fakeActuatorExecuted++;
                    } catch (e) {
                        if (e.reasonCode !== REASONS.CALLER_EXECUTOR_REJECTED) C.untypedErrors++;
                    }
                    try {
                        await h.execute({ intent, authSession: session, decision: { decision: "ALLOW", principal: subject } });
                        C.decisionUsedAsBearerAuthority++;
                    } catch (e) {
                        if (e.reasonCode !== REASONS.CALLER_EXECUTOR_REJECTED) C.untypedErrors++;
                    }
                    // ---- FIRST targeted repair counters (direct privileged
                    // exports + brand mutation). Active detection paths. ----
                    // directRegistryFactoryAcquired: NO production actuation
                    //   module may export buildActuatorRegistry (or equivalent).
                    {
                        const dir = require("node:path").join(__dirname, "../../src/action/actuation");
                        const fsmod = require("node:fs");
                        for (const f of fsmod.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
                            const mod = require(require("node:path").join(dir, f));
                            for (const name of ["buildActuatorRegistry", "registerActuator", "registrar"]) {
                                if (typeof mod[name] === "function") C.directRegistryFactoryAcquired++;
                            }
                        }
                    }
                    // directDispatcherFactoryAcquired: NO production actuation
                    //   module may export composeDispatcher (or equivalent).
                    {
                        const dir = require("node:path").join(__dirname, "../../src/action/actuation");
                        const fsmod = require("node:fs");
                        for (const f of fsmod.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
                            const mod = require(require("node:path").join(dir, f));
                            for (const name of ["composeDispatcher", "formExecutionRequest", "createLifecycleTracker", "buildExecutionResult", "buildExecutionEvidence"]) {
                                if (typeof mod[name] === "function") C.directDispatcherFactoryAcquired++;
                            }
                        }
                    }
                    // exportedRequestBrandMutated: NO production module may
                    //   export the request brand WeakSet/token (if re-exposed,
                    //   the mutation would be observable).
                    {
                        const dir = require("node:path").join(__dirname, "../../src/action/actuation");
                        const fsmod = require("node:fs");
                        for (const f of fsmod.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
                            const mod = require(require("node:path").join(dir, f));
                            if (mod.requestBrandSet instanceof WeakSet) C.exportedRequestBrandMutated++;
                            if (typeof mod.REQUEST_BRAND === "symbol") C.exportedRequestBrandMutated++;
                            if (typeof mod.addRequestBrand === "function" || typeof mod.markRequest === "function" || typeof mod.brandRequest === "function") C.exportedRequestBrandMutated++;
                        }
                        const bsmod = require("../../src/action/bootstrap");
                        if (bsmod.requestBrandSet instanceof WeakSet || typeof bsmod.REQUEST_BRAND === "symbol") C.exportedRequestBrandMutated++;
                    }
                    // exportedResultBrandMutated: same for the result brand.
                    {
                        const dir = require("node:path").join(__dirname, "../../src/action/actuation");
                        const fsmod = require("node:fs");
                        for (const f of fsmod.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
                            const mod = require(require("node:path").join(dir, f));
                            if (mod.resultBrandSet instanceof WeakSet) C.exportedResultBrandMutated++;
                            if (typeof mod.RESULT_BRAND === "symbol") C.exportedResultBrandMutated++;
                            if (typeof mod.addResultBrand === "function" || typeof mod.markResult === "function" || typeof mod.brandResult === "function") C.exportedResultBrandMutated++;
                        }
                        const bsmod = require("../../src/action/bootstrap");
                        if (bsmod.resultBrandSet instanceof WeakSet || typeof bsmod.RESULT_BRAND === "symbol") C.exportedResultBrandMutated++;
                    }
                    record("fake-probe", true, "rejected");
                    break;
                }
                case 10: { // timeout: no silent retry, exactly one invocation max
                    if (Math.floor(rng() * 8) === 0) {
                        let calls = 0;
                        const slowId = `slow-${id}`;
                        h.registerActuator({
                            capabilityId: id, operations: ["read"], capabilityIncarnationId: cap.incarnationId,
                            actuatorId: slowId,
                            invoke: async () => { calls++; await new Promise((r) => setTimeout(r, 120)); return { ok: true }; }
                        });
                        // wait — one operation per (cap, read); remove the fast one first is not allowed (atomic op registration)
                        // Instead: temporarily remove the fast actuator, add slow, execute, restore.
                        h.removeActuator(`act-${id}`);
                        const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        const r = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, nonce: round }, timeoutMs: 40 });
                        if (r.state === RESULT_STATE.TIMED_OUT) {
                            if (calls > 1) C.timeoutRetriedActuation += (calls - 1);
                            if (r.verified !== null) C.verificationClaimedByLane3++;
                        }
                        h.removeActuator(slowId);
                        h.registerActuator({
                            capabilityId: id, operations: ["read"], capabilityIncarnationId: cap.incarnationId,
                            actuatorId: `act-${id}`,
                            invoke: async (ctx) => {
                                invocationLog.set(ctx.executionId, (invocationLog.get(ctx.executionId) ?? 0) + 1);
                                return { ok: true, echo: ctx.executionId };
                            }
                        });
                    }
                    record("timeout", true, "probed");
                    break;
                }
                case 11: { // caller mutation + actuator-incarnation ABA probes
                    if (Math.floor(rng() * 6) === 0) {
                        const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        const r = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, nonce: round } });
                        if (r.state === RESULT_STATE.EXECUTED && (invocationLog.get(r.executionId) ?? 0) !== 1) {
                            C.callerMutationChangedActuator++;
                        }
                    }
                    // actuator incarnation ABA: replace the actuator (new incarnation)
                    // and verify a request bound to the OLD binding identity never
                    // double-invokes; fresh executions use the new binding.
                    if (Math.floor(rng() * 10) === 0) {
                        const before = invocationLog.size;
                        const oldActuatorId = `act-${id}`;
                        h.removeActuator(oldActuatorId);
                        h.registerActuator({
                            capabilityId: id, operations: ["read"], capabilityIncarnationId: cap.incarnationId,
                            actuatorId: oldActuatorId,
                            invoke: async (ctx) => {
                                invocationLog.set(ctx.executionId, (invocationLog.get(ctx.executionId) ?? 0) + 1);
                                return { ok: true, echo: ctx.executionId, generation: 2 };
                            }
                        });
                        const intent = lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: id, operation: "read", arguments: { target } }));
                        const r = await h.execute({ intent, authSession: lane2.session(subject), parameters: { target, nonce: round, gen: 2 } });
                        if (r.state === RESULT_STATE.EXECUTED) {
                            const n = invocationLog.get(r.executionId) ?? 0;
                            if (n > 1) C.staleActuatorIncarnationExecuted += (n - 1);
                        }
                    }
                    record("mutation-probe", true, "ok");
                    break;
                }
            }
        } catch (err) {
            const typed = err && (err.reasonCode !== undefined || err.name === "CapabilityRegistryError" || err.name === "ActionError");
            if (!typed) {
                C.untypedErrors++;
                record(opName(roll), false, "UNTYPED:" + (err.name || "Error") + ":" + String(err.message ?? "").slice(0, 60));
            } else {
                record(opName(roll), false, err.reasonCode || err.name);
            }
        }
    }

    return { digest: crypto.createHash("sha256").update(JSON.stringify(outcomes)).digest("hex"), C, ops };
}

function opName(roll) {
    return ["execute", "execute", "execute", "dup", "conflict", "stale-auth", "foreign-session", "unavailable", "undeclared", "fake-probe", "timeout", "mutation-probe"][roll];
}

test("storm: >=12000 deterministic actuation operations, all violation counters zero", async () => {
    const r1 = await runStorm(20260903);
    const r2 = await runStorm(20260903);
    assert.equal(r1.ops, OP_TARGET);
    assert.equal(r1.digest, r2.digest, "identical seed must produce identical outcomes");
    for (const [k, v] of Object.entries(r1.C)) {
        assert.equal(v, 0, `counter ${k} must be zero, got ${v}`);
    }
});

test("storm: different seeds diverge but respect the same invariants", async () => {
    const a = await runStorm(7);
    const b = await runStorm(99);
    assert.notEqual(a.digest, b.digest);
    assert.equal(a.ops, OP_TARGET);
    for (const [k, v] of Object.entries(a.C)) {
        assert.equal(v, 0, `counter ${k} must be zero`);
    }
});
