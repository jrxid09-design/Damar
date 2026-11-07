"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../src/services/pandawaIdentity");
const orchestration = require("../../src/services/pandawaOrchestrator");
const colony = require("../../src/services/pandawaColony");
const memory = require("../../src/services/pandawaMemoryScope");

test("P4: role-aware graphs remain bounded and non-authoritative", () => {
    const graph = orchestration.createWorkGraph({ type: "PARALLEL", objective: "review security architecture", bounds: { maxWidth: 3 } });
    assert.equal(graph.type, "PARALLEL");
    assert.ok(graph.nodes.every(n => identity.isPandawa(n.ownerEntity)));
    assert.ok(graph.nodes.length <= 3);
    assert.equal(graph.authorityContext, null);
    assert.throws(() => orchestration.createWorkGraph({ type: "DIRECT", objective: "x", members: ["not-pandawa"] }), /PANDAWA_ENTITY_INVALID/);
});

test("P4: sequential and review graphs preserve dependencies", () => {
    const graph = orchestration.createWorkGraph({ type: "REVIEW_CHAIN", objective: "review implementation", members: ["janaka", "werkudara", "sadewa"] });
    assert.equal(graph.depth, "L3");
    assert.ok(graph.nodes.slice(1).every(n => n.dependencies.length > 0));
    assert.equal(graph.authorityContext, null);
});

test("P4: execution isolates failed workers and returns proposals", async () => {
    const graph = orchestration.createWorkGraph({ type: "PARALLEL", objective: "analyze data", members: ["nakula", "sadewa"] });
    const result = await orchestration.runGraph(graph, { execute: async node => { if (node.ownerEntity.endsWith("sadewa")) throw new Error("peer unavailable"); return "proposal"; } });
    assert.equal(result.results.length, 2);
    assert.equal(result.results.find(r => r.producingEntity.endsWith("sadewa")).epistemic, "UNKNOWN");
    assert.equal(result.authority, null);
});

test("P5: colony is a bounded target with scoped workspace and member interaction", () => {
    const c = colony.createColony({ sessionId: "s1", objective: "review architecture", members: ["Janaka", "Bima"] });
    assert.equal(c.targetEntity, "pandawa:colony");
    assert.deepEqual(c.members, ["pandawa:janaka", "pandawa:werkudara"]);
    assert.equal(colony.resolveMemberTarget(c, "Werkudara, explain" ).sessionId, "s1");
    assert.equal(c.workspace.temporary, true);
    assert.equal(c.authority, null);
});

test("P5: disputes preserve uncertainty and consensus cannot authorize", () => {
    const c = colony.createColony({ sessionId: "s2", objective: "decide" });
    colony.recordMemberOutput(c, { entity: "janaka", result: "yes" });
    colony.recordMemberOutput(c, { entity: "werkudara", result: "no", epistemic: "DISPUTED" });
    colony.createDispute(c, { issue: "choice", positions: ["yes", "no"], resolutionState: "UNRESOLVED" });
    const synthesis = colony.synthesize(c, { result: "not enough evidence" });
    assert.equal(synthesis.epistemic, "UNKNOWN");
    assert.equal(synthesis.authority, null);
});

test("P6: namespaces are canonical and direct cross-memory reads are denied", () => {
    assert.equal(memory.namespaceFor("Arjuna"), "pandawa:janaka");
    assert.equal(memory.canRead({ requesterEntity: "janaka", sourceEntity: "janaka" }), true);
    assert.equal(memory.canRead({ requesterEntity: "janaka", sourceEntity: "sadewa" }), false);
    assert.equal(memory.canRead({ requesterEntity: "janaka", sourceEntity: "sadewa", projected: true }), true);
    assert.throws(() => memory.namespaceFor("pandawa:fake"), /PANDAWA_ID_INVALID/);
});

test("P6: handoff projection is bounded, provenance-bearing, and secret-safe", () => {
    const p = memory.createContextProjection({ sourceEntity: "janaka", targetEntity: "werkudara", sessionId: "s3", objective: "review", facts: ["bounded fact"], evidence: ["artifact:1"] });
    assert.equal(p.sourceScope, "pandawa:janaka");
    assert.equal(p.targetScope, "pandawa:werkudara");
    assert.equal(p.authority, null);
    assert.throws(() => memory.createContextProjection({ sourceEntity: "janaka", targetEntity: "werkudara", objective: "x", facts: ["apiKey=secret"] }), /PANDAWA_CONTEXT_SECRET_REJECTED/);
});

test("P6: workspace promotion is governed, never automatic", async () => {
    const ws = memory.createWorkspace({ sessionId: "s4", objective: "temporary" });
    let call = null;
    const result = await memory.proposePromotion(ws, { entity: "sadewa", governor: { propose: async value => { call = value; return { status: "pending" }; } } });
    assert.equal(result.status, "pending");
    assert.equal(call.writer, "pandawa:sadewa");
    assert.equal(call.kind, "memory");
});

test('P5: review graph executes synthesis only after dependencies', async () => {
    const graph = orchestration.createWorkGraph({ type: 'REVIEW_CHAIN', objective: 'review', members: ['janaka', 'werkudara'] });
    const seen = []; const result = await orchestration.runGraph(graph, { execute: async node => { seen.push(node.ownerEntity); return node.objective; } });
    assert.equal(result.results.length, 3);
    assert.equal(seen.at(-1), 'pandawa:puntadewa');
});