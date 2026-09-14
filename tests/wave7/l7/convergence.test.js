const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createLongHorizonCycle } = require("../../../src/cognition/longhorizon");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

function fakeRegistry(descriptors = {}) {
    const map = new Map(Object.entries(descriptors));
    return {
        get: (id) => (map.has(id) ? { id, ...map.get(id) } : null),
        has: (id) => map.has(id),
        getAvailability: () => { throw new Error("unused"); }
    };
}

test("W7-L7 convergence 1: OFF mode complete path — zero footprint", async () => {
    const lh = await createLongHorizonCycle({ mode: "off" });
    assert.equal(lh.mode, "off");
    const result = await lh.cycle();
    assert.equal(result, null, "OFF cycle() adalah no-op, tidak mengembalikan apa pun");
    assert.equal(lh.lanes, undefined, "OFF tidak membangun lane apa pun");
});

test("W7-L7 convergence 2: SHADOW mode complete path — runs but zero decision influence", async () => {
    const lh = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: fakeRegistry() });
    const result = await lh.cycle();
    assert.equal(result.decisionInfluence, false);
    assert.equal(result.projection, undefined, "SHADOW tidak menghasilkan projection governed");
});

test("W7-L7 convergence 3: GOVERNED mode complete path — advisory projection only", async () => {
    const lh = await createLongHorizonCycle({ mode: "governed", capabilityRegistry: fakeRegistry() });
    const result = await lh.cycle();
    assert.equal(result.decisionInfluence, "ADVISORY_ONLY");
    assert.ok(result.projection);
    assert.equal(result.projection.decisionInfluence, "ADVISORY_ONLY");
});

test("W7-L7 repair: GOVERNED mode's projection never mutates attention scheduling state (independent audit AUD3-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const lh = await createLongHorizonCycle({ mode: "governed", capabilityRegistry: registry });

    const { targetId } = lh.lanes.attention.ingestSignal(
        { sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e1" } }, "REASON"
    );

    await lh.cycle();
    await lh.cycle(); // generating the advisory projection twice must not change anything

    assert.equal(lh.lanes.attention.getTarget(targetId).state, "QUEUED",
        "proyeksi GOVERNED tidak boleh memindahkan target ke RUNNING sekadar dengan membacanya");

    const started = lh.lanes.attention.pick();
    assert.equal(started.targetId, targetId,
        "pick() nyata sesudahnya harus tetap memilih target yang sama -- kredit tidak boleh terkuras oleh proyeksi read-only");
});

test("W7-L7 convergence 4/5/6: no import of action/authority/actuation anywhere in this module tree", async () => {
    const dir = path.join(__dirname, "../../../src/cognition/longhorizon");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(content, /require\(["'].*\/(authority|action)\//,
            `${file} tidak boleh mengimpor authority/action (ACC->Tool / ACC->authProof / ACC->AuthorityDecision)`);
    }
});

test("W7-L7 convergence 7: restart mid-plan — no task resumes EXECUTING through the composed cycle", async () => {
    const store = createMemoryAccStore();
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const lh1 = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, stores: { goals: store } });
    const g = lh1.lanes.goals.proposeGoal({
        title: "t", kind: "OWNER_ASSIGNED", origin: { kind: "OWNER", ref: "o1", evidenceRef: null },
        successCondition: { kind: "WORLD_BELIEF", subject: { entityId: "e1" }, attribute: "status", expectedValue: "done" }
    });
    const p = lh1.lanes.goals.createPlan({ goalRef: g.goalId, steps: [] });
    const t = lh1.lanes.goals.createTask({ planRef: p.planId, order: 1, intentTemplate: {} });
    lh1.lanes.goals.transitionTask(t.taskId, "ready");
    lh1.lanes.goals.transitionTask(t.taskId, "formIntent");
    lh1.lanes.goals.transitionTask(t.taskId, "awaitAuthority");
    lh1.lanes.goals.transitionTask(t.taskId, "execute");
    await lh1.lanes.goals.persist();

    const lh2 = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, stores: { goals: store } });
    assert.equal(lh2.lanes.goals.getTask(t.taskId).state, "PENDING");
});

test("W7-L7 convergence 20: legacy cognition owners cannot become canonical here", async () => {
    const dir = path.join(__dirname, "../../../src/cognition/longhorizon");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(content, /require\(["'].*\/(consciousness|autonomy)\//,
            `${file} tidak boleh mengimpor consciousness/autonomy legacy`);
        assert.doesNotMatch(content, /require\(["'].*\/world\/WorldModel/,
            `${file} tidak boleh mengimpor src/world/WorldModel legacy`);
    }
});

test("W7-L7 convergence 21: L1-R1 closure — downgrade and eviction audit events generated at the composition boundary", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" }, "cap.y": { kind: "tool" } });
    const auditEvents = [];
    const fakeLedger = { append: (e) => auditEvents.push(e) };
    let t = 1000;
    const clock = { nowMs: () => t };
    const lh = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, clock, auditLedger: fakeLedger });

    lh.lanes.selfModel.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: t });
    await lh.cycle();

    t += 1000;
    lh.lanes.selfModel.ingestAvailability({ capabilityId: "cap.x", availability: "UNAVAILABLE", generation: 2, observedAtMs: t });
    await lh.cycle();

    assert.ok(auditEvents.some(e => e.eventType === "cognition.selfmodel.downgrade"),
        "penurunan selfBelief harus terekam ke Audit Ledger");
});

test("W7-L7 convergence 24: cycle() never raw-throws when auditLedger is a revoked Proxy or has a throwing append -- 'audit failure never blocks cognition' held even for the type-check guard itself (independent audit W7R52-P2-1)", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    let t = 1000;
    const clock = { nowMs: () => t };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const lh = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, clock, auditLedger: revoked.proxy });

    lh.lanes.selfModel.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: t });
    await assert.doesNotReject(() => lh.cycle());

    t += 1000;
    lh.lanes.selfModel.ingestAvailability({ capabilityId: "cap.x", availability: "UNAVAILABLE", generation: 2, observedAtMs: t });
    await assert.doesNotReject(() => lh.cycle(), "a revoked-Proxy auditLedger must never abort the cycle, even while emitting a downgrade event");

    const throwingLedger = { get append() { throw new Error("x"); } };
    const lh2 = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, clock, auditLedger: throwingLedger });
    lh2.lanes.selfModel.ingestAvailability({ capabilityId: "cap.x", availability: "AVAILABLE", generation: 1, observedAtMs: t });
    await assert.doesNotReject(() => lh2.cycle());
});

test("W7-L7 convergence 25: constructing the composed cycle never raw-throws when capabilityRegistry, a per-lane store, or the injected stores/bounds objects are revoked Proxies -- each guard fails closed to its own established default (independent audit W7R52-P2-2)", async () => {
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    const { createSelfModel } = require("../../../src/cognition/selfmodel");
    const { createWorldModel } = require("../../../src/cognition/worldmodel");
    const { createGoalEngine } = require("../../../src/cognition/goals");
    const { createProspectiveMemory } = require("../../../src/cognition/prospective");

    await assert.rejects(() => createSelfModel({ capabilityRegistry: rev() }), (err) => err.reason === "INVALID_PORT");
    await assert.doesNotReject(() => createWorldModel({ store: rev() }));
    await assert.doesNotReject(() => createGoalEngine({ store: rev() }));
    await assert.doesNotReject(() => createProspectiveMemory({ store: rev() }));

    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    await assert.doesNotReject(() => createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, stores: rev() }));
    await assert.doesNotReject(() => createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry, bounds: rev() }));
});

test("W7-L7 repair: audit events emitted in one cycle are capped at MAX_AUDIT_EVENTS_PER_CYCLE (Codex P2 round 8)", async () => {
    const { BOUNDS } = require("../../../src/cognition/longhorizon/bounds");
    const N = 6;
    const descriptors = {};
    for (let i = 0; i < N; i++) descriptors[`cap.${i}`] = { kind: "tool" };
    const registry = fakeRegistry(descriptors);
    const auditEvents = [];
    const fakeLedger = { append: (e) => auditEvents.push(e) };
    let t = 1000;
    const clock = { nowMs: () => t };
    const lh = await createLongHorizonCycle({
        mode: "shadow", capabilityRegistry: registry, clock, auditLedger: fakeLedger,
        bounds: { ...BOUNDS, MAX_AUDIT_EVENTS_PER_CYCLE: 2 }
    });

    for (const id of Object.keys(descriptors)) {
        lh.lanes.selfModel.ingestAvailability({ capabilityId: id, availability: "AVAILABLE", generation: 1, observedAtMs: t });
    }
    await lh.cycle(); // all N become USABLE (baseline)

    t += 60_000; // past AVAILABILITY_TTL_MS -> all N go STALE -> UNKNOWN (a downgrade each)
    await lh.cycle();

    assert.ok(auditEvents.length <= 2, "audit ledger tidak boleh menerima lebih dari MAX_AUDIT_EVENTS_PER_CYCLE event per siklus");
});

test("W7-L7 convergence 22: no persisted cognition state can restore execution permission — no authority-shaped field anywhere in the projection", async () => {
    const { AUTHORITY_SHAPED_KEYS } = require("../../../src/cognition/longhorizon");
    const lh = await createLongHorizonCycle({ mode: "governed", capabilityRegistry: fakeRegistry() });
    const result = await lh.cycle();
    const serialized = JSON.stringify(result);
    for (const key of AUTHORITY_SHAPED_KEYS) {
        assert.equal(serialized.includes(`"${key}"`), false, `hasil cycle tidak boleh membawa '${key}'`);
    }
});

test("W7-L7 convergence 23: composed lanes keep their own bounds under the shared cycle", async () => {
    const registry = fakeRegistry({ "cap.x": { kind: "tool" } });
    const lh = await createLongHorizonCycle({ mode: "shadow", capabilityRegistry: registry });
    for (let i = 0; i < 10; i++) {
        lh.lanes.attention.ingestSignal({ sourceKind: "SYSTEM", sourceId: `s${i}`, subjectRef: { entityId: `e${i}` } }, "MAINTAIN");
    }
    assert.ok(lh.lanes.attention.bounds.MAX_QUEUED_TARGETS > 0, "batas L5 tetap berlaku lewat komposisi L7");
});
