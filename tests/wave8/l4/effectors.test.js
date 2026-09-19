"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEffectorDescriptor } = require("../../../src/embodiment/effectors/descriptor");
const { validateRegistrationBatch } = require("../../../src/embodiment/effectors/registration");
const { createEffectorAdapter } = require("../../../src/embodiment/effectors/adapter");
const { createDeadman } = require("../../../src/embodiment/effectors/deadman");
const { validateCalibration, applyCalibration, auditCalibrationChange } = require("../../../src/embodiment/effectors/calibration");
const { MAX_EFFECTORS, MAX_ADAPTER_RATE_HZ, OUTCOME } = require("../../../src/embodiment/effectors/laws");
const { makeActuationHarness } = require("../../actuation/harness");
const { createAuditLedger } = require("../../../src/runtime/auditLedger");
const { isRefValue } = require("../../../src/runtime/auditLedger/ids");
const utilTypes = require("node:util").types;

const auditSink = (events = []) => (event) => { events.push(event); return true; };

function isCanonicalTestRequest(request) {
    return request !== null && typeof request === "object" && Object.isFrozen(request) &&
        Reflect.ownKeys(request).length === 7 &&
        ["executionId", "intentId", "capabilityId", "operation", "principal", "scope", "parameters"]
            .every((key) => Object.prototype.hasOwnProperty.call(request, key));
}

function createTestEffectorAdapter(options) {
    const adapter = createEffectorAdapter({ ...options, isCanonicalRequest: options.isCanonicalRequest || isCanonicalTestRequest });
    return Object.freeze({
        execute(request, canonicalRequest = request) { return adapter.execute(request, canonicalRequest); },
        state: adapter.state
    });
}

function physicalDescriptor(extra = {}) {
    return {
        effectorId: "arm.left", deviceRef: "device-1", kind: "MOTOR", capabilityId: "motion.arm",
        preconditionVerifiers: ["scene.clear"], postconditionVerifiers: ["position.observed"],
        physicalLimits: { move: { min: -10, max: 10, windowMs: 1000, maxPerWindow: 5 } },
        deadmanRequired: false, calibrationRef: "cal-1", ...extra
    };
}

function gatedRequest(parameters, executionId = "l4-execution") {
    return Object.freeze({
        executionId, intentId: `intent-${executionId}`,
        capabilityId: "motion.arm", operation: "move", principal: "alice",
        scope: ["arm.left"], parameters
    });
}

test("L4 descriptor copies bounded declarations and defaults missing trust classifications strict", () => {
    const input = physicalDescriptor({ reversibility: undefined, hazardClass: undefined });
    delete input.reversibility;
    delete input.hazardClass;
    const result = validateEffectorDescriptor(input);
    assert.equal(result.reversibility, "IRREVERSIBLE");
    assert.equal(result.hazardClass, "SAFETY_CRITICAL");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.physicalLimits), true);
    input.physicalLimits.move.max = 999;
    assert.equal(result.physicalLimits.move.max, 10);
});

test("L4 enforces frozen descriptor enums and requires limits for MOTOR/RELAY", () => {
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ kind: "BOGUS" })), /kind/);
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ kind: "MOTOR", physicalLimits: null })), /physicalLimits/);
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ reversibility: "BOGUS" })), /reversibility/);
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ hazardClass: "BOGUS" })), /hazardClass/);
    assert.equal(validateEffectorDescriptor(physicalDescriptor({ reversibility: "COMPENSABLE", hazardClass: "PHYSICAL" })).kind, "MOTOR");
    const display = (extra) => ({
        effectorId: "screen", deviceRef: "device-2", kind: "DISPLAY", capabilityId: "display.set",
        preconditionVerifiers: [], postconditionVerifiers: [], deadmanRequired: false, ...extra
    });
    assert.equal(validateEffectorDescriptor(display({ hazardClass: "NONE" })).kind, "DISPLAY");
    // EM-7: an OMITTED hazardClass defaults to SAFETY_CRITICAL, so the same
    // non-motor descriptor is physical and must declare limits -- validation
    // and the runtime limit check can never disagree about the classification.
    assert.throws(() => validateEffectorDescriptor(display({})), /physicalLimits/);
    // The audit ledger's reference vocabulary, applied at registration: an id
    // the ledger cannot record would leave every command of that effector
    // unauditable, and the adapter refuses unauditable commands forever.
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ effectorId: "arm 1" })), /effectorId/);
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ effectorId: "-lead" })), /effectorId/);
    assert.equal(validateEffectorDescriptor(physicalDescriptor({ effectorId: "arm.left.actuator.primary" })).effectorId, "arm.left.actuator.primary");
    // Pinned to the ledger's own reference vocabulary, so the two cannot drift.
    assert.equal(isRefValue("arm.left.actuator.primary"), true);
    assert.equal(isRefValue("arm 1"), false);
    assert.equal(isRefValue("-lead"), false);
});

test("L4 direct factory requires a canonical-request verifier and rejects unbranded requests", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    assert.throws(() => createEffectorAdapter({ descriptor, audit: auditSink(), invoke() {} }), /configuration/);
    let calls = 0;
    const adapter = createEffectorAdapter({ descriptor, audit: auditSink(), isCanonicalRequest: () => false, invoke: async () => { calls++; } });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }), gatedRequest({ move: 1 }))).reason, "GATED_REQUEST_REQUIRED");
    assert.equal(calls, 0);
});

test("L4 refuses a gated request that does not match the canonical request it claims", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let calls = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), invoke: async () => { calls++; return { ok: true }; } });
    const canonical = gatedRequest({ move: 1 }, "mismatch");
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "mismatch-other"), canonical)).reason, "GATED_REQUEST_MISMATCH");
    assert.equal((await adapter.execute(canonical, Object.freeze({ ...canonical, capabilityId: "motion.other" }))).reason, "GATED_REQUEST_MISMATCH");
    // A gated request may not widen the authorized scope: the adapter would
    // otherwise hand the actuator a scope the canonical request never carried.
    const widened = Object.freeze({ ...canonical, scope: Object.freeze(["arm.left", "plant.nuke"]) });
    assert.equal((await adapter.execute(widened, canonical)).reason, "GATED_REQUEST_MISMATCH");
    assert.equal(calls, 0);
});

test("L4 rejects missing physical limits, accessors, proxies, duplicate registrations, and over-bound batches", () => {
    assert.throws(() => validateEffectorDescriptor(physicalDescriptor({ physicalLimits: null })), /physicalLimits/);
    let trapCount = 0;
    const hostile = new Proxy({}, { ownKeys() { trapCount++; throw new Error("trap"); } });
    assert.throws(() => validateEffectorDescriptor(hostile), /plain data record/);
    assert.equal(trapCount, 0);
    const accessor = physicalDescriptor();
    Object.defineProperty(accessor, "effectorId", { enumerable: true, get() { throw new Error("getter"); } });
    assert.throws(() => validateEffectorDescriptor(accessor), /data property/);
    const hostileVerifiers = physicalDescriptor();
    Object.defineProperty(hostileVerifiers.preconditionVerifiers, "0", { get() { throw new Error("verifier getter"); } });
    assert.throws(() => validateEffectorDescriptor(hostileVerifiers), /preconditionVerifiers/);
    const same = physicalDescriptor();
    assert.throws(() => validateRegistrationBatch([same, same]), /duplicate/);
    assert.throws(() => validateRegistrationBatch(new Array(1)), /data properties/);
    const hostileBatch = [same];
    Object.defineProperty(hostileBatch, "0", { get() { throw new Error("batch getter"); } });
    assert.throws(() => validateRegistrationBatch(hostileBatch), /data properties/);
    assert.throws(() => validateRegistrationBatch(new Array(MAX_EFFECTORS + 1).fill(physicalDescriptor())), /bound/);
    assert.throws(() => validateRegistrationBatch(new Proxy([], { get() { trapCount++; throw new Error("trap"); } })), /bound/);
    assert.equal(trapCount, 0);
    assert.equal(MAX_ADAPTER_RATE_HZ, 20);
});

test("L4 checks range, cumulative window limits, rate, and one in-flight operation", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let now = 0;
    let release;
    let calls = 0;
    const adapter = createTestEffectorAdapter({
        descriptor,
        audit: auditSink(),
        now: () => now,
        invoke: async () => { calls++; await new Promise((resolve) => { release = resolve; }); return { ok: true }; },
        verify: async () => true
    });
    const first = adapter.execute(gatedRequest({ move: 3 }, "range-first"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.state.isInFlight(), true);
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "range-race"))).reason, "COMMAND_IN_FLIGHT");
    release();
    assert.equal((await first).outcome, OUTCOME.EXECUTED);
    assert.equal(calls, 1);
    now = 50;
    assert.equal((await adapter.execute(gatedRequest({ move: 3 }, "range-window"))).reason, "WINDOW_LIMIT_REFUSAL");
    now = 51;
    assert.equal((await adapter.execute(gatedRequest({ move: 11 }, "range-max"))).reason, "LIMIT_REFUSAL");
    assert.equal((await adapter.execute(gatedRequest({ force: 1 }, "range-extra"))).reason, "INVALID_GATED_REQUEST");
    assert.equal(calls, 1);
});

test("L4 sliding physical limit rejects a tumbling-window boundary burst", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let now = 950;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), now: () => now, invoke: async () => ({ ok: true }) });
    const first = await adapter.execute(gatedRequest({ move: 5 }, "sliding-first"));
    assert.equal(first.outcome, OUTCOME.UNVERIFIED);
    now = 1000;
    const second = await adapter.execute(gatedRequest({ move: 5 }, "sliding-second"));
    assert.equal(second.outcome, OUTCOME.REFUSED);
    assert.equal(second.reason, "WINDOW_LIMIT_REFUSAL");
});

test("L4 transport ambiguity is UNKNOWN_OUTCOME and never retried", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let calls = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), invoke: async () => { calls++; throw new Error("link lost"); } });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "transport-lost"))).outcome, OUTCOME.UNKNOWN_OUTCOME);
    assert.equal(calls, 1);
});

test("L4 refuses a Proxy request without executing its traps", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let traps = 0;
    let calls = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), invoke: async () => { calls++; } });
    const request = new Proxy({}, { get() { traps++; throw new Error("get trap"); }, getOwnPropertyDescriptor() { traps++; throw new Error("descriptor trap"); } });
    assert.equal((await adapter.execute(request)).outcome, OUTCOME.REFUSED);
    assert.equal(traps, 0);
    assert.equal(calls, 0);
});

test("L4 snapshots command data once and refuses accessor, inherited, extra, or nonnumeric physical fields", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let getterCalls = 0;
    let calls = 0;
    let delivered;
    const adapter = createTestEffectorAdapter({
        descriptor,
        audit: auditSink(),
        invoke: async (request) => { calls++; delivered = request; return "ok"; },
        verify: async () => true
    });
    const paramsWithGetter = {};
    Object.defineProperty(paramsWithGetter, "move", { enumerable: true, get() { getterCalls++; return 1; } });
    assert.equal((await adapter.execute(gatedRequest(paramsWithGetter, "accessor-param"))).reason, "INVALID_GATED_REQUEST");
    assert.equal(getterCalls, 0);
    assert.equal((await adapter.execute(gatedRequest({ move: 1, force: 1 }, "extra-param"))).reason, "INVALID_GATED_REQUEST");
    assert.equal((await adapter.execute(gatedRequest({ move: "1" }, "text-param"))).reason, "INVALID_GATED_REQUEST");
    const nonEnumerable = Object.defineProperty({ move: 1 }, "hidden", { value: 2 });
    assert.equal((await adapter.execute(gatedRequest(nonEnumerable, "hidden-param"))).reason, "INVALID_GATED_REQUEST");
    const inherited = Object.create({ move: 1 });
    assert.equal((await adapter.execute(gatedRequest(inherited, "inherited-param"))).reason, "INVALID_GATED_REQUEST");
    assert.equal(calls, 0);

    const callerParameters = { move: 2 };
    const request = gatedRequest(callerParameters, "snapshot-param");
    assert.equal((await adapter.execute(request)).outcome, OUTCOME.EXECUTED);
    callerParameters.move = 99;
    assert.equal(delivered.parameters.move, 2, "the transport receives the detached validated snapshot");
    assert.equal(Object.isFrozen(delivered.parameters), true);
    assert.equal(calls, 1);
});

test("L4 uses the captured Proxy brand check after util.types mutation", () => {
    const realIsProxy = utilTypes.isProxy;
    let traps = 0;
    try {
        utilTypes.isProxy = () => false;
        const proxy = new Proxy({}, { ownKeys() { traps++; throw new Error("trap"); } });
        assert.throws(() => validateEffectorDescriptor(proxy), /plain data record/);
        assert.equal(traps, 0);
    } finally {
        utilTypes.isProxy = realIsProxy;
    }
});

test("L4 synchronous audit failure prevents dispatch; successful command and refusal are audited", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let calls = 0;
    const blocked = createTestEffectorAdapter({ descriptor, audit() { throw new Error("ledger unavailable"); }, invoke: async () => { calls++; } });
    assert.equal((await blocked.execute(gatedRequest({ move: 1 }, "audit-blocked"))).reason, "AUDIT_UNAVAILABLE");
    assert.equal(calls, 0);

    const events = [];
    let now = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(events), now: () => now, invoke: async () => { calls++; return "sent"; }, verify: async () => true });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "audit-ok"))).outcome, OUTCOME.EXECUTED);
    now = 51;
    assert.equal((await adapter.execute(gatedRequest({ move: 20 }, "audit-limit"))).reason, "LIMIT_REFUSAL");
    assert.deepEqual(events.map((event) => event.eventType), ["embodiment.effector.command.start", "embodiment.effector.command.result", "embodiment.effector.limit.refusal"]);
    assert.equal(calls, 1);

    const falseAck = createTestEffectorAdapter({ descriptor, audit: () => false, invoke: async () => { calls++; } });
    assert.equal((await falseAck.execute(gatedRequest({ move: 1 }, "audit-false"))).reason, "AUDIT_UNAVAILABLE");
    const asyncAck = createTestEffectorAdapter({ descriptor, audit: () => Promise.resolve(true), invoke: async () => { calls++; } });
    assert.equal((await asyncAck.execute(gatedRequest({ move: 1 }, "audit-async"))).reason, "AUDIT_UNAVAILABLE");
    assert.equal(calls, 1);
});

test("L4 command events append through the canonical synchronous audit ledger", async () => {
    let clock = 100;
    const ledger = createAuditLedger({ clock: () => ++clock });
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    const adapter = createTestEffectorAdapter({
        descriptor, audit: (event) => ledger.append(event),
        invoke: async () => ({ ok: true }), verify: async () => true
    });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "ledger-audit"))).outcome, OUTCOME.EXECUTED);
    const entries = ledger.list({ source: "embodiment.effector" });
    assert.deepEqual(entries.map((event) => event.eventType), [
        "embodiment.effector.command.start", "embodiment.effector.command.result"
    ]);
    assert.equal(entries.every((event) => Number.isSafeInteger(event.timestampMs)), true);
});

test("L4 adapter invocation stays behind the existing gated actuator path", async () => {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ capabilityId: "motion.arm" }));
    let calls = 0;
    let requestKeys = [];
    const auditEvents = [];
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(auditEvents), isCanonicalRequest: h.isCanonicalExecutionRequest, invoke: async () => { calls++; return { ok: true }; }, verify: async () => true });
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left", invoke: (request, canonicalRequest) => { requestKeys = Reflect.ownKeys(request); return adapter.execute(request, canonicalRequest); }
    });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    const allowed = await h.execute({ intent, authSession: h.lane2.session("alice"), parameters: { move: 2 } });
    assert.equal(h.isCanonicalExecutionResult(allowed), true);
    assert.equal(allowed.state, "EXECUTED", JSON.stringify({ allowed, auditEvents }));
    assert.equal(calls, 1, JSON.stringify({ auditEvents, requestKeys }));
    const denied = await h.execute({ intent, authSession: h.lane2.session("mallory"), parameters: { move: 2 } });
    assert.equal(h.isCanonicalExecutionResult(denied), true);
    assert.equal(calls, 1, "authority denial never reaches the leaf adapter");
});

test("L4 proves 1000 separately gated effects through one canonical actuator binding", async () => {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    const descriptor = validateEffectorDescriptor(physicalDescriptor({
        capabilityId: "motion.arm",
        physicalLimits: { move: { min: -10, max: 10, windowMs: 60000, maxPerWindow: 1000 } }
    }));
    let calls = 0;
    let now = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), isCanonicalRequest: h.isCanonicalExecutionRequest, now: () => now, invoke: async () => { calls++; return { ok: true }; }, verify: async () => true });
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left", invoke: (request, canonicalRequest) => adapter.execute(request, canonicalRequest)
    });
    const session = h.lane2.session("alice");
    for (let i = 0; i < 1000; i++) {
        const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
        const result = await h.execute({ intent, authSession: session, parameters: { move: 1 } });
        assert.equal(result.state, "EXECUTED", `effect ${i + 1} must pass a fresh canonical gate`);
        now += 50;
    }
    assert.equal(calls, 1000);
    assert.equal(h.dispatcherState.inFlightCount(), 0);
});

test("L4 repeated hazard-class verification failures degrade the adapter", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let now = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), now: () => now, invoke: async () => "sent", verify: async () => false });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "hazard-first"))).outcome, OUTCOME.UNVERIFIED);
    now = 51;
    const second = await adapter.execute(gatedRequest({ move: 1 }, "hazard-second"));
    assert.equal(second.degraded, true);
    assert.equal(adapter.state.isDegraded(), true);
    now = 102;
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "hazard-third"))).reason, "CAPABILITY_DEGRADED");
});

test("L4 postcondition verifier receives no command-channel report", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ hazardClass: "DATA" }));
    let now = 0;
    let observation = false;
    let calls = 0;
    const adapter = createTestEffectorAdapter({
        descriptor,
        audit: auditSink(),
        now: () => now,
        invoke: async () => { calls++; return { commandSaysMoved: true }; },
        verify: async (evidence) => {
            assert.deepEqual(Object.keys(evidence), ["request"]);
            return observation;
        }
    });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "independent-1"))).outcome, OUTCOME.UNVERIFIED);
    now = 51;
    observation = true;
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "independent-2"))).postconditionVerified, true);
    assert.equal(calls, 2);
});

test("L4 an unreadable driver outcome fails closed instead of executing", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({
        hazardClass: "NONE",
        physicalLimits: { move: { min: -10, max: 10, windowMs: 1000, maxPerWindow: 50 } }
    }));
    let now = 0;
    let report;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), now: () => now, invoke: async () => report });
    const run = async (next) => {
        now += 51;
        report = next;
        return adapter.execute(gatedRequest({ move: 1 }, `unreadable-${now}`));
    };
    class Inherited { get outcome() { return OUTCOME.UNKNOWN_OUTCOME; } }
    const callable = () => {};
    callable.outcome = OUTCOME.UNKNOWN_OUTCOME;
    const callableAccessor = () => {};
    Object.defineProperty(callableAccessor, "outcome", { get() { return OUTCOME.UNKNOWN_OUTCOME; } });
    const cases = [
        // Unreadable descriptions cannot be command-channel data: fail closed.
        [{ get outcome() { return OUTCOME.UNKNOWN_OUTCOME; } }, OUTCOME.UNKNOWN_OUTCOME, "TRANSPORT_UNREADABLE"],
        [new Inherited(), OUTCOME.UNKNOWN_OUTCOME, "TRANSPORT_UNREADABLE"],
        [new Proxy({ outcome: OUTCOME.UNKNOWN_OUTCOME }, {}), OUTCOME.UNKNOWN_OUTCOME, "TRANSPORT_UNREADABLE"],
        [callableAccessor, OUTCOME.UNKNOWN_OUTCOME, "TRANSPORT_UNREADABLE"],
        // A readable own data property is honoured, even on a callable report.
        [callable, OUTCOME.UNKNOWN_OUTCOME, "TRANSPORT_UNKNOWN"],
        // No outcome described: the clean success path is unchanged.
        ["sent", OUTCOME.EXECUTED, ""],
        [{ ok: true }, OUTCOME.EXECUTED, ""]
    ];
    for (const [shape, outcome, reason] of cases) {
        const result = await run(shape);
        assert.equal(result.outcome, outcome);
        if (reason) assert.equal(result.reason, reason);
    }
});

test("L4 a driver-reported UNVERIFIED token never becomes EXECUTED", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ hazardClass: "NONE" }));
    const adapter = createTestEffectorAdapter({
        descriptor, audit: auditSink(), invoke: async () => ({ outcome: OUTCOME.UNVERIFIED })
    });
    const own = await adapter.execute(gatedRequest({ move: 1 }, "unverified-token"));
    assert.equal(own.outcome, OUTCOME.UNVERIFIED);
    assert.equal(own.reason, "TRANSPORT_UNVERIFIED");
    const dispatched = await dispatchRawActuatorReport(() => ({ outcome: OUTCOME.UNVERIFIED }));
    assert.equal(dispatched.state, "FAILED");
    assert.equal(dispatched.failureReason, "ACTUATOR_REJECTED_INVOCATION");
});

test("L4 deadman heartbeat loss latches stop and invokes safe-stop once", () => {
    let now = 0;
    let stops = 0;
    const deadman = createDeadman({ now: () => now, timeoutMs: 20, stop: () => { stops++; } });
    assert.equal(deadman.check(), true);
    now = 21;
    assert.equal(deadman.check(), false);
    assert.equal(deadman.check(), false);
    assert.equal(deadman.isStopped(), true);
    assert.equal(stops, 1);
});

test("L4 deadman uncertainty fails closed before transport", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ deadmanRequired: true }));
    let calls = 0;
    const adapter = createTestEffectorAdapter({
        descriptor,
        audit: auditSink(),
        deadman: { check() { throw new Error("heartbeat unavailable"); }, timeoutMs() { return 100; } },
        invoke: async () => { calls++; }
    });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "deadman-unknown"))).outcome, OUTCOME.STOPPED);
    assert.equal(calls, 0);
});

test("L4 deadman clock rollback and failed safe-stop remain explicit", () => {
    let now = 10;
    let stopCalls = 0;
    const deadman = createDeadman({ now: () => now, timeoutMs: 100, stop() { stopCalls++; throw new Error("interlock offline"); } });
    now = 9;
    assert.equal(deadman.check(), false);
    assert.equal(deadman.isStopped(), true);
    assert.equal(deadman.didStopSucceed(), false);
    assert.equal(stopCalls, 1);
    assert.throws(() => createDeadman({ now: () => NaN, timeoutMs: 100, stop() {} }), /clock/);
});

test("L4 monitors deadman heartbeat loss while transport is in flight", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ deadmanRequired: true }));
    let now = 0;
    let stopCalls = 0;
    let invocationStarted;
    const started = new Promise((resolve) => { invocationStarted = resolve; });
    const deadman = createDeadman({ now: () => now, timeoutMs: 100, stop() { stopCalls++; } });
    const adapter = createTestEffectorAdapter({
        descriptor, audit: auditSink(), deadman, now: () => now,
        invoke: async () => { invocationStarted(); return new Promise(() => {}); }
    });
    const resultPromise = adapter.execute(gatedRequest({ move: 1 }, "deadman-pending"));
    await started;
    now = 101;
    const result = await resultPromise;
    assert.equal(result.outcome, OUTCOME.UNKNOWN_OUTCOME);
    assert.equal(result.reason, "DEADMAN_STOP");
    assert.equal(stopCalls, 1);
});

test("L4 canonical actuator result maps explicit refusal to canonical FAILED", async () => {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ capabilityId: "motion.arm" }));
    const adapter = createTestEffectorAdapter({
        descriptor, audit: auditSink(), isCanonicalRequest: h.isCanonicalExecutionRequest,
        invoke: async () => ({ outcome: OUTCOME.REFUSED }), verify: async () => true
    });
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left", invoke: (request, canonicalRequest) => adapter.execute(request, canonicalRequest)
    });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    const result = await h.execute({ intent, authSession: h.lane2.session("alice"), parameters: { move: 2 } });
    assert.equal(result.state, "FAILED");
    assert.equal(result.actuatorReport.outcome, OUTCOME.REFUSED);
});

async function dispatchRawActuatorReport(invoke, signal = undefined) {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left", invoke
    });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    return h.execute({ intent, authSession: h.lane2.session("alice"), parameters: { move: 2 }, ...(signal === undefined ? {} : { signal }) });
}

async function dispatchWithActuatorReport(report) {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    const descriptor = validateEffectorDescriptor(physicalDescriptor({ capabilityId: "motion.arm" }));
    const adapter = createTestEffectorAdapter({
        descriptor, audit: auditSink(), isCanonicalRequest: h.isCanonicalExecutionRequest,
        invoke: async () => report, verify: async () => true
    });
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left", invoke: (request, canonicalRequest) => adapter.execute(request, canonicalRequest)
    });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    return h.execute({ intent, authSession: h.lane2.session("alice"), parameters: { move: 2 } });
}

test("L4 result-shaped actuator data cannot manufacture canonical verification", async () => {
    const result = await dispatchWithActuatorReport({
        ok: true, verified: true, verificationClaim: "actuator says ok", authorityGeneration: 99
    });
    assert.equal(result.state, "EXECUTED");
    assert.equal(result.verified, null);
    assert.equal(result.verificationClaim, null);
});

test("L4 ambiguous physical outcome never becomes EXECUTED at the canonical dispatcher", async () => {
    const result = await dispatchWithActuatorReport({ outcome: OUTCOME.UNKNOWN_OUTCOME, ok: true });
    assert.equal(result.state, "FAILED");
    assert.equal(result.failureReason, "ACTUATOR_REJECTED_INVOCATION");
    assert.equal(result.actuatorReport.outcome, OUTCOME.UNKNOWN_OUTCOME);
});

test("L4 an unreadable actuator outcome is unsupported and cannot become EXECUTED", async () => {
    class Inherited { get outcome() { return OUTCOME.UNKNOWN_OUTCOME; } }
    for (const unreadable of [
        () => ({ get outcome() { return OUTCOME.UNKNOWN_OUTCOME; } }),
        () => new Inherited(),
        () => new Proxy({ outcome: OUTCOME.UNKNOWN_OUTCOME }, {}),
        () => { const callable = () => {}; Object.defineProperty(callable, "outcome", { get() { return OUTCOME.UNKNOWN_OUTCOME; } }); return callable; }
    ]) {
        const result = await dispatchRawActuatorReport(unreadable);
        assert.equal(result.state, "FAILED");
        assert.equal(result.failureReason, "ACTUATOR_REJECTED_INVOCATION");
    }
    // A readable own data property is still honoured at the dispatcher.
    assert.equal((await dispatchRawActuatorReport(() => ({ outcome: OUTCOME.UNKNOWN_OUTCOME }))).state, "FAILED");
    assert.equal((await dispatchRawActuatorReport(() => ({ ok: true }))).state, "EXECUTED");
});

test("L4 actuator invocation receives a frozen brand-recognized gated request", async () => {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    await h.lane2.grantAuthority({ capabilityId: "motion.arm", subject: "alice", actions: ["move"], identityBinding: { principals: ["alice"] } });
    let seen = null;
    h.registerActuator({
        capabilityId: "motion.arm", operations: ["move"], capabilityIncarnationId: cap.incarnationId,
        actuatorId: "arm.left",
        invoke: (gatedRequest, canonicalRequest) => { seen = { gatedRequest, canonicalRequest }; return { ok: true }; }
    });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    const result = await h.execute({ intent, authSession: h.lane2.session("alice"), parameters: { move: 2 } });
    assert.equal(result.state, "EXECUTED");
    // The first argument is a canonical, frozen, brand-recognized request
    // context -- not an arbitrary projection an actuator must take on trust.
    assert.equal(h.isCanonicalExecutionRequest(seen.gatedRequest), true);
    assert.equal(Object.isFrozen(seen.gatedRequest), true);
    assert.equal(Reflect.ownKeys(seen.gatedRequest).length, 7);
    // It is bound to the artifact the dispatcher actually authorized.
    assert.equal(h.isCanonicalExecutionRequest(seen.canonicalRequest), true);
    for (const key of ["executionId", "intentId", "capabilityId", "operation", "principal", "scope", "parameters"]) {
        assert.equal(seen.gatedRequest[key], seen.canonicalRequest[key]);
    }
});

test("L4 a hostile thrown actuator value still produces a canonical FAILED result", async () => {
    const hostileProxy = new Proxy({}, {
        getPrototypeOf() { throw new Error("prototype trap"); },
        ownKeys() { throw new Error("ownKeys trap"); },
        getOwnPropertyNames() { throw new Error("ownPropertyNames trap"); },
        getOwnPropertyDescriptor() { throw new Error("descriptor trap"); }
    });
    const hostilePrototype = Object.create(new Proxy({}, { getPrototypeOf() { throw new Error("proto trap"); } }));
    // Falsy thrown values must not be skipped by a truthiness test: these are
    // all thrown values and must yield FAILED, not EXECUTED.
    for (const thrown of [hostileProxy, hostilePrototype, null, undefined, false, 0, ""]) {
        const result = await dispatchRawActuatorReport(() => { throw thrown; });
        assert.equal(result.state, "FAILED");
        assert.equal(result.failureReason, "ACTUATOR_REJECTED_INVOCATION");
    }
});

const { createCanonicalActuationFacade } = require("../../../src/action/bootstrap");

test("L4 the production dispatcher refuses hostile caller input with a typed refusal", async () => {
    // This exercises the REAL bootstrap dispatcher, not the test-harness
    // mirror: the mirror was correct while the production intake leaked a raw
    // trap error (external audit round 6).
    const facade = createCanonicalActuationFacade();
    assert.equal(typeof facade.execute, "function");
    const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() { throw new Error("probe"); },
        ownKeys() { throw new Error("ownKeys trap"); },
        get() { throw new Error("get trap"); }
    });
    await assert.rejects(
        () => facade.execute(hostile),
        (e) => typeof e.reasonCode === "string" && !/probe|trap/.test(String(e.message))
    );
    // A well-formed caller bag that survives intake must fail with a TYPED
    // dispatcher refusal -- never a ReferenceError/TypeError from the body.
    await assert.rejects(
        () => facade.execute({
            intent: { intentId: "i-1", capabilityId: "motion.arm", operation: "move", capabilityIncarnationId: "inc-1", createdAtMs: 0, scope: ["arm.left"] },
            authSession: { principal: "alice", sessionId: "s-1" },
            parameters: { move: 1 }
        }),
        (e) => typeof e.reasonCode === "string" && e instanceof Error && !(e instanceof ReferenceError) && !(e instanceof TypeError)
    );
});

test("L4 an unrecognized driver outcome token fails closed at both layers", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor({
        hazardClass: "NONE",
        physicalLimits: { move: { min: -10, max: 10, windowMs: 1000, maxPerWindow: 50 } }
    }));
    let now = 0;
    let report;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), now: () => now, invoke: async () => report });
    const run = async (next) => {
        now += 51;
        report = next;
        return adapter.execute(gatedRequest({ move: 1 }, `token-${now}`));
    };
    // Every token the adapter does not recognize as the canonical success token
    // is an ambiguous physical outcome: fail closed, never EXECUTED. Note that
    // an EXPLICITLY undefined token is a described token, not an absent one.
    for (const token of ["GARBAGE", 42, null, undefined, "ok", { weird: true }, Object.create(null)]) {
        const result = await run({ outcome: token });
        assert.equal(result.outcome, OUTCOME.UNKNOWN_OUTCOME);
        assert.equal(result.reason, "TRANSPORT_UNSUPPORTED_TOKEN");
    }
    assert.equal((await run({ outcome: OUTCOME.EXECUTED })).outcome, OUTCOME.EXECUTED);
    assert.equal((await run({ ok: true })).outcome, OUTCOME.EXECUTED);
    assert.equal((await run({})).outcome, OUTCOME.EXECUTED);
    // A nested/collection report cannot hide an ambiguous outcome either, even
    // behind a structure whose contents sanitization would silently drop.
    class OutcomeHolder { constructor() { this.outcome = OUTCOME.UNKNOWN_OUTCOME; } }
    for (const nested of [
        { wrapped: { outcome: OUTCOME.UNKNOWN_OUTCOME } },
        { wrapped: { outcome: "partial" } },
        [{ outcome: OUTCOME.UNKNOWN_OUTCOME }],
        { list: [{ outcome: OUTCOME.REFUSED }] },
        new Map([["x", { outcome: OUTCOME.UNKNOWN_OUTCOME }]]),
        new Set([{ outcome: OUTCOME.UNKNOWN_OUTCOME }]),
        new OutcomeHolder(),
        Object.defineProperty({}, "outcome", { value: OUTCOME.UNKNOWN_OUTCOME, enumerable: false }),
        { [Symbol("hidden")]: { outcome: OUTCOME.UNKNOWN_OUTCOME } },
        Object.defineProperty({}, "child", { get() { return { outcome: OUTCOME.UNKNOWN_OUTCOME }; } })
    ]) {
        const result = await run(nested);
        assert.equal(result.outcome, OUTCOME.UNKNOWN_OUTCOME);
        assert.equal(["TRANSPORT_UNSUPPORTED_TOKEN", "TRANSPORT_UNKNOWN"].includes(result.reason), true);
    }
    // ...while a nested EXECUTED token or no outcome at all is still clean.
    assert.equal((await run({ wrapped: { outcome: OUTCOME.EXECUTED } })).outcome, OUTCOME.EXECUTED);
    // Same closed vocabulary at the canonical dispatcher.
    for (const token of ["GARBAGE", 42, null, undefined, Object.create(null)]) {
        const result = await dispatchRawActuatorReport(() => ({ outcome: token }));
        assert.equal(result.state, "FAILED");
        assert.equal(result.failureReason, "ACTUATOR_REJECTED_INVOCATION");
    }
    for (const nested of [[{ outcome: OUTCOME.UNKNOWN_OUTCOME }], { wrapped: { outcome: "partial" } }, new Map([["x", { outcome: OUTCOME.UNKNOWN_OUTCOME }]]), new Date(0)]) {
        const result = await dispatchRawActuatorReport(() => nested);
        assert.equal(result.state, "FAILED");
        assert.equal(result.failureReason, "ACTUATOR_REJECTED_INVOCATION");
    }
    assert.equal((await dispatchRawActuatorReport(() => ({ outcome: OUTCOME.EXECUTED }))).state, "EXECUTED");
    assert.equal((await dispatchRawActuatorReport(() => ({ ok: true }))).state, "EXECUTED");
    assert.equal((await dispatchRawActuatorReport(() => ({}))).state, "EXECUTED");
    assert.equal((await dispatchRawActuatorReport(() => [1, 2, 3])).state, "EXECUTED");
    assert.equal((await dispatchRawActuatorReport(() => ({ nested: { outcome: OUTCOME.EXECUTED } }))).state, "EXECUTED");
});

test("L4 hostile caller fields cannot leak an arbitrary exception out of the dispatcher", async () => {
    const h = await makeActuationHarness({ scopeBindings: { "motion.arm": { move: () => ["arm.left"] } } });
    const cap = await h.lane2.registerCapability({ id: "motion.arm", operations: ["move"] });
    await h.lane2.registry.observeAvailability("motion.arm", "AVAILABLE", { generation: 1, incarnationId: cap.incarnationId });
    const intent = h.lane2.admit(JSON.stringify({ schemaVersion: 1, capabilityId: "motion.arm", operation: "move", arguments: {} }));
    const authSession = h.lane2.session("alice");
    const withThrowingGetter = (key) => {
        const request = { intent, authSession };
        Object.defineProperty(request, key, { enumerable: true, get() { throw new Error(`${key} trap`); } });
        return request;
    };
    const cases = [
        withThrowingGetter("parameters"),
        withThrowingGetter("timeoutMs"),
        withThrowingGetter("signal"),
        withThrowingGetter("metadata"),
        new Proxy({ intent, authSession }, { get() { throw new Error("proxy get trap"); }, ownKeys() { throw new Error("ownKeys trap"); } })
    ];
    for (const request of cases) {
        // A hostile caller field is refused with a TYPED canonical refusal: the
        // caller's own exception text must never leak through the dispatcher.
        await assert.rejects(
            () => h.execute(request),
            (e) => typeof e.reasonCode === "string" && !/trap/.test(String(e.message))
        );
    }
});

test("L4 a hostile AbortSignal cannot reject or distort the canonical dispatcher", async () => {
    const hostileSignals = [
        { aborted: false, get addEventListener() { throw new Error("signal getter trap"); } },
        new Proxy({}, { get() { throw new Error("signal proxy trap"); }, has() { throw new Error("signal has trap"); } }),
        { aborted: false, addEventListener() { throw new Error("attach trap"); }, removeEventListener() { throw new Error("detach trap"); } }
    ];
    for (const signal of hostileSignals) {
        const result = await dispatchRawActuatorReport(() => ({ ok: true }), signal);
        // A caller's broken cancellation plumbing is not authority: the
        // authorized command still returns a canonical result instead of
        // rejecting the dispatcher.
        assert.equal(result.state, "EXECUTED");
    }
});

test("L4 audit clock failure is contained and blocks transport", async () => {
    const descriptor = validateEffectorDescriptor(physicalDescriptor());
    let calls = 0;
    const adapter = createTestEffectorAdapter({ descriptor, audit: auditSink(), now() { throw new Error("clock unavailable"); }, invoke: async () => { calls++; } });
    assert.equal((await adapter.execute(gatedRequest({ move: 1 }, "clock-unknown"))).reason, "AUDIT_UNAVAILABLE");
    assert.equal(calls, 0);
});

test("L4 calibration is detached, finite, and expired calibration fails closed", () => {
    const record = validateCalibration({
        calibrationRef: "cal-1", appliedAt: 10, validUntil: 100,
        offsets: { x: 2 }, scale: { x: 3 }
    }, { nowMs: 50 });
    assert.deepEqual({ ...applyCalibration({ x: 4 }, record, { nowMs: 50 }) }, { x: 14 });
    const events = [];
    auditCalibrationChange(auditSink(events), "arm.left", record.calibrationRef, 51);
    assert.equal(events[0].eventType, "embodiment.effector.calibration.change");
    assert.throws(() => auditCalibrationChange(() => { throw new Error("disk full"); }, "arm.left", record.calibrationRef, 51), /audit failed/);
    assert.throws(() => validateCalibration({ ...record, validUntil: 50 }, { nowMs: 50 }), /expired/);
});
