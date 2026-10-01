const test = require("node:test");
const assert = require("node:assert/strict");

const ContextItem = require("../../src/ai/context/ContextItem");
const ContextPipeline = require("../../src/ai/context/Pipeline");
const { makeRegistry, descriptor } = require("../capability/helpers");

test("F-CTX-003: stale context is excluded and unknown freshness remains explicit", async () => {
    const stale = ContextItem.invalidate(ContextItem.create({
        source: "memory", kind: "memory", content: "obsolete deployment fact",
        freshness: { state: "known", version: "v1", observedAt: 1 }
    }), { version: "v2" });
    const unknown = ContextItem.create({
        source: "memory", kind: "memory", content: "unverified deployment fact"
    });
    const result = await ContextPipeline.select({
        messages: [{ role: "user", content: "deployment fact" }],
        includeMind: false,
        memoryFn: async () => [stale, unknown]
    });
    const text = result.messages.map(m => m.content).join("\n");
    assert.doesNotMatch(text, /obsolete deployment fact/);
    assert.match(text, /unverified deployment fact/);
    assert.equal(result.diagnostics.freshness.staleExcluded, 1);
    assert.equal(result.diagnostics.freshness.unknown, 1);
});

test("F-CTX-004: conflicting facts are exposed as conflicting, not collapsed", async () => {
    const result = await ContextPipeline.select({
        messages: [{ role: "user", content: "camera status" }],
        includeMind: false,
        memoryFn: async () => [
            ContextItem.create({ source: "a", kind: "memory", content: "camera is online", fact: { key: "camera.status", value: "online" } }),
            ContextItem.create({ source: "b", kind: "memory", content: "camera is offline", fact: { key: "camera.status", value: "offline" } })
        ]
    });
    assert.deepEqual(result.diagnostics.facts, [{
        key: "camera.status", state: "conflicting", values: ["online", "offline"]
    }]);
});

test("F-CAP-006: canonical registry exposes relation, dependency, and removal impact truth", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "tool.camera", provides: ["cap.capture"], verifiedBy: ["check.camera"] }));
    register(descriptor({ id: "tool.workflow", dependencies: ["tool.camera"], composes: ["cap.capture"] }));
    const view = registry.getIntelligenceView("tool.workflow");
    assert.deepEqual(view.relations.composes, ["cap.capture"]);
    assert.deepEqual(view.dependencies, ["tool.camera"]);
    assert.deepEqual(view.dependents, []);
    assert.deepEqual(registry.getDependents("tool.camera"), ["tool.workflow"]);
    assert.deepEqual(registry.getRelations("tool.camera", "provides"), ["cap.capture"]);
});

test("F-CAP-007: intelligence view joins existing feedback evidence without positive fallback", () => {
    const { register, registry } = makeRegistry();
    register(descriptor({ id: "tool.camera" }));
    const unknown = registry.getIntelligenceView("tool.camera");
    assert.equal(unknown.feedback.state, "unknown");
    assert.equal(unknown.feedback.toolStats, null);

    const observed = registry.getIntelligenceView("tool.camera", {
        toolStats: { reliability: name => name === "camera" ? 0.75 : null },
        autonomyRegistry: { get: id => ({ id, trust: 0.8 }) },
        selfModel: { getCapabilityOutcome: id => ({ id, outcome: "mixed" }) }
    });
    assert.equal(observed.feedback.state, "observed");
    assert.equal(observed.feedback.toolStats.reliability, 0.75);
    assert.equal(observed.feedback.autonomy.trust, 0.8);
    assert.equal(observed.feedback.selfModel.outcome, "mixed");
});
