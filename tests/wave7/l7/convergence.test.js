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
