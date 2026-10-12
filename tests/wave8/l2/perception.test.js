"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPerception, BOUNDS } = require("../../../src/cognition/perception");
const { createRuntimeCore } = require("../../../src/integration/canonicalRuntimeComposition");

function makePorts(overrides = {}) {
    const events = [];
    const attentionCalls = [];
    const capabilityRegistry = {
        has: (id) => id === "sensor.camera",
        get: () => Object.freeze({ id: "sensor.camera", kind: "sensor", source: "camera", sensitivity: "PRIVATE" }),
        getAvailability: () => Object.freeze({ availability: "AVAILABLE" })
    };
    const selfModel = { unknowns: () => Object.freeze([{ subject: "unknown:temperature", probeCost: "CHEAP" }]) };
    const worldModel = { openContradictions: () => Object.freeze([{ contradictionSetId: "contradiction:1" }]), hypotheses: () => Object.freeze([{ hypothesisId: "hypothesis:1" }]) };
    const attentionPort = {
        current: null, pending: [],
        ingestSignal(signal) { attentionCalls.push("ingestSignal"); this.current = signal.subjectRef.questionRef; this.pending.push(this.current); return { targetId: this.current }; },
        pick() { attentionCalls.push("pick"); const targetId = this.pending.shift(); return targetId ? { targetId, priorityClass: "P4_BACKGROUND" } : null; },
        peekTopTarget() { attentionCalls.push("peekTopTarget"); const targetId = this.pending[0] ?? this.current; return targetId ? { targetId, priorityClass: "P4_BACKGROUND" } : null; },
        toGovernorPriority(priority) { attentionCalls.push("toGovernorPriority"); return priority; }, complete() { attentionCalls.push("complete"); }, overloadState: () => "NORMAL"
    };
    const trustedResultAdapter = { verifyCompletion: ({ outcome }) => outcome === "SUCCESS" || outcome === "DENIED" };
    const store = {
        values: new Map(),
        async getKv(key) { return this.values.get(key) ?? null; },
        async putKv(key, value) { this.values.set(key, value); }
    };
    const auditLedger = { append(event) { events.push(event); return { ignored: true }; } };
    return { options: { capabilityRegistry, selfModel, worldModel, attentionPort, trustedResultAdapter, store, auditLedger,
        clock: { nowMs: () => 10_000 }, ...overrides }, events, store, attentionCalls };
}

async function ready(options) {
    const lane = await createPerception(options);
    lane.openQuestion({ questionRef: "unknown:temperature", question: "What is the room temperature?" });
    return lane;
}

test("W8-L2: cited questions, descriptor-derived probes, budgets, and no dispatch", async () => {
    const f = makePorts();
    const lane = await ready(f.options);
    const scheduled = lane.scheduleProbe({ questionRef: "unknown:temperature", probeId: "p-1", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(scheduled.state, "SCHEDULED");
    assert.equal(scheduled.request.class, "INTERACTIVE");
    assert.equal(scheduled.request.gain, 0.5);
    assert.equal(scheduled.request.privacyClass, "PRIVATE");
    assert.equal(scheduled.request.authorityRequired, true);
    assert.equal(scheduled.request.dispatch, null);
    assert.equal(lane.getQuestion("unknown:temperature").attempts, 1);
    assert.ok(f.events.some(e => e.eventType === "cognition.perception.probe_classified"));
    assert.ok(f.events.some(e => e.eventType === "cognition.perception.probe_schedule_requested"));
    for (const api of ["ingestSignal", "pick", "peekTopTarget", "toGovernorPriority"]) assert.ok(f.attentionCalls.includes(api), `W7-L5 ${api} participates in the lane`);
});

test("W8-L2: uncited refs, hostile inputs, and unknown capabilities fail closed", async () => {
    const f = makePorts();
    const lane = await ready(f.options);
    let ownKeysRuns = 0;
    assert.throws(() => lane.openQuestion(new Proxy({}, { ownKeys() { ownKeysRuns++; return []; } })), { reason: "INVALID_RECORD" });
    assert.equal(ownKeysRuns, 0);
    let getterRuns = 0;
    assert.throws(() => lane.openQuestion({ get questionRef() { getterRuns++; return "unknown:temperature"; } }), { reason: "INVALID_RECORD" });
    assert.equal(getterRuns, 0);
    assert.throws(() => lane.openQuestion({ questionRef: "free-floating", question: "anything" }), { reason: "UNKNOWN_QUESTION" });
    assert.equal(lane.openQuestion({ questionRef: "hypothesis:1", question: "Test this hypothesis" }).sourceKind, "HYPOTHESIS");
    assert.throws(() => lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p", capabilityId: "missing", deadline: 20_000 }), { reason: "UNKNOWN_CAPABILITY" });
    assert.throws(() => lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p-extra", capabilityId: "sensor.camera", deadline: 20_000, gain: 1, class: "LOCAL" }), { reason: "INVALID_RECORD" });
    assert.ok(f.events.some(e => e.eventType === "cognition.perception.probe_refused"), "malformed caller fields are audited");
});

test("W8-L2: hard attention overload and exhausted limits defer; refusal does not create an alternate path", async () => {
    const f = makePorts({ attentionPort: { ...makePorts().options.attentionPort, overloadState: () => "HARD" } });
    const lane = await ready(f.options);
    const result = lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p-1", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(result.state, "DEFERRED");
    assert.equal(result.reason, "BUDGET_EXHAUSTED");
    assert.equal(lane.probeCounts().inFlight, 0);
    assert.equal(lane.getQuestion("unknown:temperature").state, "OPEN");
    assert.equal(lane.getQuestion("unknown:temperature").lastRefusal, "BUDGET_EXHAUSTED");
});

test("W8-L2: denied, expired, and successful results have closed states and preserve L1 Observation", async () => {
    let now = 10_000;
    const f = makePorts({ clock: { nowMs: () => now } });
    const lane = await ready(f.options);
    lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p-deny", capabilityId: "sensor.camera", deadline: 20_000 });
    const denied = lane.probeResult({ probeId: "p-deny", outcome: "DENIED" });
    assert.equal(denied.state, "BLOCKED");
    assert.equal(denied.observation, null);

    // A denied question stays blocked; a separately cited unknown can be opened.
    f.options.selfModel.unknowns = () => Object.freeze([{ subject: "unknown:humidity", probeCost: "CHEAP" }]);
    lane.openQuestion({ questionRef: "unknown:humidity", question: "What is the humidity?" });
    lane.proposeProbe({ questionRef: "unknown:humidity", probeId: "p-expire", capabilityId: "sensor.camera", deadline: 11_000 });
    now = 12_000;
    assert.equal(lane.probeResult({ probeId: "p-expire" }).state, "EXPIRED");

    now = 13_000;
    f.options.selfModel.unknowns = () => Object.freeze([{ subject: "unknown:pressure", probeCost: "CHEAP" }]);
    lane.openQuestion({ questionRef: "unknown:pressure", question: "What is the pressure?" });
    lane.proposeProbe({ questionRef: "unknown:pressure", probeId: "p-ok", capabilityId: "sensor.camera", deadline: 30_000 });
    const observation = { tier: "T4", sensor: { sensorId: "camera-1" }, frame: { kind: "ROOM", ref: "room-1", transformRef: null }, quality: 0.8 };
    const result = lane.probeResult({ probeId: "p-ok", observation });
    assert.deepEqual(result.observation, observation);
    assert.equal(result.sensoriumBridgeRequired, true);

    now = 14_000;
    f.options.selfModel.unknowns = () => Object.freeze([{ subject: "unknown:empty-frame", probeCost: "CHEAP" }]);
    lane.openQuestion({ questionRef: "unknown:empty-frame", question: "What was sampled?" });
    lane.proposeProbe({ questionRef: "unknown:empty-frame", probeId: "p-null-frame", capabilityId: "sensor.camera", deadline: 30_000 });
    const nullableObservation = { tier: "T4", sensor: { sensorId: "camera-1" }, frame: null, quality: null };
    assert.deepEqual(lane.probeResult({ probeId: "p-null-frame", observation: nullableObservation }).observation, nullableObservation);
});

test("W8-L2: questions recover durably while in-flight probes never recover", async () => {
    const f = makePorts();
    const lane = await ready(f.options);
    lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p-live", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(await lane.persist(), true);
    const restored = await createPerception(f.options);
    assert.equal(restored.getQuestion("unknown:temperature").state, "OPEN");
    assert.equal(restored.getProbe("p-live"), null);
});

test("W8-L2: hostile persisted snapshots are rejected without invoking accessors or restoring partial state", async () => {
    let reads = 0;
    const store = {
        async getKv() { return { schemaVersion: "perception.v1", questions: [
            { questionRef: "valid-looking", question: "ok", sourceKind: "UNKNOWN", probeCost: "CHEAP", state: "OPEN", createdAtMs: 1, attempts: 0, accruedCost: 0 },
            { get questionRef() { reads++; return "hostile"; } }
        ] }; },
        async putKv() { throw new Error("unused"); }
    };
    const f = makePorts({ store });
    const lane = await createPerception(f.options);
    assert.equal(reads, 0);
    assert.equal(lane.perceptionColdStart, true);
    assert.equal(lane.openQuestions().length, 0);
    assert.ok(f.events.some(event => event.eventType === "cognition.perception.store_unreadable"));
});

test("W8-L2: audit sink failure fails closed before state mutation and return values are ignored", async () => {
    const f = makePorts({ auditLedger: { append() { throw new Error("sink unavailable"); } } });
    const lane = await createPerception(f.options);
    assert.throws(() => lane.openQuestion({ questionRef: "unknown:temperature", question: "Temperature?" }), { reason: "AUDIT_UNAVAILABLE" });
    assert.equal(lane.openQuestions().length, 0);
    assert.deepEqual(f.attentionCalls, [], "failed audit does not mutate the attention owner");
    const g = makePorts({ auditLedger: { append() { return { get then() { throw new Error("must not be read"); } }; } } });
    const lane2 = await ready(g.options);
    assert.equal(lane2.openQuestions().length, 1);
    await assert.rejects(createPerception({ ...g.options, auditLedger: null }), { reason: "AUDIT_UNAVAILABLE" });
    const rejected = makePorts({ auditLedger: { append() { return false; } } });
    const lane3 = await createPerception(rejected.options);
    assert.throws(() => lane3.openQuestion({ questionRef: "unknown:temperature", question: "Temperature?" }), { reason: "AUDIT_UNAVAILABLE" });
    assert.equal(lane3.openQuestions().length, 0);

    const gated = makePorts({ auditLedger: { append(event) {
        if (event.eventType === "cognition.perception.authorization_allowed") throw new Error("durability failed");
    } } });
    const lane4 = await ready(gated.options);
    gated.attentionCalls.length = 0;
    assert.throws(() => lane4.scheduleProbe({ questionRef: "unknown:temperature", probeId: "audit-gated", capabilityId: "sensor.camera", deadline: 20_000 }), { reason: "AUDIT_UNAVAILABLE" });
    assert.equal(lane4.probeCounts().inFlight, 0);
    assert.ok(!gated.attentionCalls.includes("pick"), "audit failure precedes attention selection");
});

test("W8-L2: caller assertions cannot complete a probe when no trusted result adapter is bound", async () => {
    let now = 10_000;
    const f = makePorts({ clock: { nowMs: () => now } });
    delete f.options.trustedResultAdapter;
    const lane = await ready(f.options);
    lane.proposeProbe({ questionRef: "unknown:temperature", probeId: "p-forged", capabilityId: "sensor.camera", deadline: 20_000 });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps++; throw new Error("must not inspect"); } });
    assert.throws(() => lane.probeResult({ probeId: "p-forged", outcome: "SUCCESS", observation: hostile }), { reason: "PROBE_UNAVAILABLE" });
    assert.equal(traps, 0);
    assert.equal(lane.getProbe("p-forged").state, "SCHEDULED");
    assert.ok(f.events.some(event => event.eventType === "cognition.perception.probe_result_refused"));
    now = 21_000;
    assert.equal(lane.probeResult({ probeId: "p-forged", outcome: "SUCCESS", observation: hostile }).state, "EXPIRED");
    assert.equal(lane.getProbe("p-forged").state, "EXPIRED");
});

test("W8-L2: descriptor ambiguity escalates to Authority and closing a question cancels its requests", async () => {
    const f = makePorts({ capabilityRegistry: {
        has: () => true,
        get: () => Object.freeze({ id: "sensor.camera", kind: "unclassified", source: "unknown" }),
        getAvailability: () => Object.freeze({ availability: "AVAILABLE" })
    } });
    const lane = await ready(f.options);
    const probe = lane.scheduleProbe({ questionRef: "unknown:temperature", probeId: "p-ambiguous", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(probe.request.class, "WORLD_CHANGING");
    assert.equal(probe.request.authorityRequired, true);
    lane.closeQuestion("unknown:temperature");
    assert.equal(lane.getProbe("p-ambiguous").state, "CANCELLED");
    assert.throws(() => lane.probeResult({ probeId: "p-ambiguous", outcome: "SUCCESS", observation: {} }), { reason: "PROBE_UNAVAILABLE" });
});

test("W8-L2: descriptor operation/effect and privacy metadata override benign local labels", async () => {
    const cases = [
        { source: "local", operations: ["control"], effect: "physical", privacyClass: "PRIVATE", expected: "WORLD_CHANGING" },
        { source: "local", operation: "read", privacyClass: "PRIVATE", expected: "INTERACTIVE" },
        { source: "local", operation: "read", dataSensitivity: "SENSITIVE", expected: "INTERACTIVE" },
        { source: "local", operation: "read", expected: "LOCAL" }
    ];
    for (const [index, entry] of cases.entries()) {
        const descriptor = { id: entry.expected === "LOCAL" ? "local.filesystem" : "sensor.camera", kind: "read", ...entry };
        delete descriptor.expected;
        const f = makePorts({ capabilityRegistry: {
            has: () => true,
            get: () => descriptor,
            getAvailability: () => ({ availability: "AVAILABLE" })
        } });
        const lane = await ready(f.options);
        const result = lane.scheduleProbe({ questionRef: "unknown:temperature", probeId: `class-${index}`, capabilityId: "sensor.camera", deadline: 20_000 });
        assert.equal(result.request.class, entry.expected);
        assert.equal(result.request.privacyClass, entry.privacyClass || entry.dataSensitivity ? "PRIVATE" : "PUBLIC");
        assert.equal(result.request.authorityRequired, entry.expected !== "LOCAL");
    }
});

test("W8-L2: citation search finds upstream records beyond the safe-clone array bound", async () => {
    const unknowns = Array.from({ length: 256 }, (_, i) => Object.freeze({ subject: `unknown:${i}`, probeCost: "CHEAP" }));
    const contradictions = Array.from({ length: 4096 }, (_, i) => Object.freeze({ contradictionSetId: `contradiction:${i}` }));
    const hypotheses = Array.from({ length: 4096 }, (_, i) => Object.freeze({ hypothesisId: `hypothesis:${i}` }));
    const f = makePorts({ selfModel: { unknowns: () => Object.freeze(unknowns) },
        worldModel: { openContradictions: () => Object.freeze(contradictions), hypotheses: () => Object.freeze(hypotheses) } });
    const lane = await createPerception(f.options);
    const question = lane.openQuestion({ questionRef: "unknown:255", question: "What is the final value?" });
    assert.equal(question.sourceKind, "UNKNOWN");
    assert.equal(question.probeCost, "CHEAP");
    assert.equal(lane.openQuestion({ questionRef: "contradiction:4095", question: "What contradicts the record?" }).sourceKind, "CONTRADICTION");
    assert.equal(lane.openQuestion({ questionRef: "hypothesis:4095", question: "Is the hypothesis true?" }).sourceKind, "HYPOTHESIS");
    assert.throws(() => lane.openQuestion({ questionRef: "challenger:forged", question: "Forged contradiction" }), { reason: "UNKNOWN_QUESTION" });
});

test("W8-L2: probe identity uses the frozen questionRef/probeId pair and ambiguous legacy lookup fails closed", async () => {
    const refs = ["temperature", "humidity", "pressure", "light", "noise"];
    const f = makePorts({ selfModel: { unknowns: () => Object.freeze(refs.map(ref => ({ subject: `unknown:${ref}`, probeCost: "CHEAP" }))) },
        capabilityRegistry: { has: () => true, get: () => ({ id: "files.local", kind: "read", source: "local" }), getAvailability: () => ({ availability: "AVAILABLE" }) } });
    const lane = await createPerception(f.options);
    for (const ref of refs) lane.openQuestion({ questionRef: `unknown:${ref}`, question: `${ref}?` });
    const first = lane.scheduleProbe({ questionRef: "unknown:temperature", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    const duplicate = lane.scheduleProbe({ questionRef: "unknown:temperature", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(duplicate, first);
    const second = lane.scheduleProbe({ questionRef: "unknown:humidity", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.notEqual(second, first);
    const third = lane.scheduleProbe({ questionRef: "unknown:pressure", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    const fourth = lane.scheduleProbe({ questionRef: "unknown:light", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    const fifth = lane.scheduleProbe({ questionRef: "unknown:noise", probeId: "shared", capabilityId: "sensor.camera", deadline: 20_000 });
    assert.equal(fifth.state, "DEFERRED");
    assert.equal(lane.probeCounts().inFlight, 4);
    assert.equal(lane.getProbe("shared"), null);
    assert.equal(lane.getProbe("shared", "unknown:temperature"), first);
    assert.equal(lane.getProbe("shared", "unknown:humidity"), second);
    assert.throws(() => lane.probeResult({ probeId: "shared" }), { reason: "PROBE_UNAVAILABLE" });
    assert.equal(lane.probeResult({ probeId: "shared", questionRef: "unknown:temperature", outcome: "DENIED" }).state, "BLOCKED");
    assert.equal(lane.probeCounts().inFlight, 3);
    assert.equal(lane.getProbe("shared", "unknown:pressure"), third);
    assert.equal(lane.getProbe("shared", "unknown:light"), fourth);
});

test("W8-L2: activity expires stale probes and the probe cap cannot be reset by minute rollover", async () => {
    let now = 59_999;
    const refs = Array.from({ length: 9 }, (_, index) => `unknown:cycle-${index}`);
    const f = makePorts({ clock: { nowMs: () => now }, selfModel: { unknowns: () => Object.freeze(refs.map(subject => ({ subject, probeCost: "CHEAP" }))) },
        capabilityRegistry: { has: () => true, get: () => ({ id: "local.filesystem", kind: "read", source: "local" }), getAvailability: () => ({ availability: "AVAILABLE" }) } });
    const lane = await createPerception(f.options);
    for (const ref of refs) lane.openQuestion({ questionRef: ref, question: ref });
    for (let i = 0; i < 4; i++) {
        lane.scheduleProbe({ questionRef: refs[i], probeId: `expired-${i}`, capabilityId: "local.filesystem", deadline: now + 1 });
    }
    now += 2;
    assert.equal(lane.probeCounts().inFlight, 0, "read activity reaps expired requests");
    assert.equal(lane.getProbe("expired-0").state, "EXPIRED");
    for (let i = 0; i < 4; i++) {
        lane.scheduleProbe({ questionRef: refs[i + 4], probeId: `denied-${i}`, capabilityId: "local.filesystem", deadline: now + 10_000 });
        lane.probeResult({ probeId: `denied-${i}`, outcome: "DENIED" });
        now += 60_001;
    }
    const refused = lane.scheduleProbe({ questionRef: refs[8], probeId: "beyond-lifetime-cap", capabilityId: "local.filesystem", deadline: now + 10_000 });
    assert.equal(refused.state, "DEFERRED", "wall-clock minute changes do not reset the strict cap");
});

test("W8-L2: published bounds match the frozen contract", () => {
    assert.deepEqual(BOUNDS, { MAX_QUESTIONS: 1024, MAX_PROBES_PER_CYCLE: 8, MAX_INTERACTIVE_PROBES_PER_HOUR: 4, MAX_ATTEMPTS_PER_QUESTION: 3, MAX_CONCURRENT_PROBES: 4, MAX_QUESTION_CHARS: 1024 });
});

test("W8-L2 integration: lane is opt-in, composed from canonical cognition owners, and shares the configured audit sink", async () => {
    const disabled = await createRuntimeCore({});
    assert.equal(disabled.perceptionLane, null);
    disabled.shutdown();

    const auditEvents = [];
    const core = await createRuntimeCore({
        enableCognition: true,
        cognitionMode: "shadow",
        cognitionCapabilityRegistry: { get: () => null, has: () => false, getAvailability: () => "UNKNOWN" },
        cognitionAuditLedger: { append(event) { auditEvents.push(event); return { ignored: true }; } }
    });
    try {
        assert.ok(core.perceptionLane);
        assert.equal(typeof core.perceptionLane.openQuestion, "function");
        assert.equal(typeof core.perceptionLane.probeResult, "function");
        assert.equal(core.perceptionLane.lanes, undefined, "composition exposes the L2 surface, not a second copy of sibling lanes");
        assert.throws(() => core.perceptionLane.openQuestion({ questionRef: "uncited", question: "uncited" }), { reason: "UNKNOWN_QUESTION" });
    } finally {
        assert.ok(auditEvents.some(event => event.eventType === "cognition.perception.question_refused"));
        core.shutdown();
    }
});
