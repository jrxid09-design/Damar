"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PandawaSkillBridge } = require("../../src/services/pandawaSkillBridge");
const { PandawaWorktreeIsolation, safePath } = require("../../src/services/pandawaWorktreeIsolation");
const { PandawaSurfaceContinuity } = require("../../src/services/pandawaSurfaceContinuity");
const { createPandawaSessionRegistry } = require("../../src/runtime/interactionBus/pandawaSessions");

test("P10: skills are descriptive, bounded, and do not grant capability", async () => {
    const bridge = new PandawaSkillBridge({ maxSkills: 2 });
    const skill = bridge.register({ ownerEntity: "Janaka", skillId: "review-code", origin: "CURATED", maturity: "EXPERIMENTAL", requiredCapabilities: ["filesystem.read"], procedure: "inspect and report", metadata: { domain: "engineering" } });
    assert.equal(skill.ownerEntity, "pandawa:janaka");
    assert.equal(skill.capabilityGrant, null);
    const candidate = bridge.observe({ skillId: "review-code", result: "ok", success: true, evidenceRefs: ["test:1"] });
    const proposal = await bridge.propose(candidate.candidateId);
    assert.equal(proposal.authority, null);
    const denied = await bridge.promote(candidate.candidateId);
    assert.equal(denied.promoted, false);
    assert.throws(() => bridge.register({ ownerEntity: "Janaka", skillId: "poison", procedure: "x", metadata: { authority: "owner" } }), /AUTHORITY_FIELD_REJECTED/);
});

test("P10: learned skill promotion requires sandbox validation", async () => {
    const bridge = new PandawaSkillBridge();
    bridge.register({ ownerEntity: "Sadewa", skillId: "verify-source", origin: "LEARNED", procedure: "compare sources" });
    const candidate = bridge.observe({ skillId: "verify-source", result: "verified", success: true });
    const promoted = await bridge.promote(candidate.candidateId, { validator: { validate: async () => ({ ok: true }) } });
    assert.equal(promoted.promoted, true);
    assert.equal(promoted.skill.capabilityGrant, null);
});

test("P11: worktree isolation bounds paths, ownership, and lifecycle", () => {
    const isolation = new PandawaWorktreeIsolation({ root: "C:/Workspace/isolated" });
    const record = isolation.create({ taskId: "task-1", ownerEntity: "Janaka", baseCommit: "abc", worktreePath: "C:/Workspace/isolated/task-1" });
    assert.equal(record.state, "CREATED");
    assert.equal(isolation.transition(record.worktreeId, "REVIEW").authority, null);
    assert.throws(() => safePath("C:/Workspace/isolated", "C:/Workspace/other"), /PATH_ESCAPE/);
    assert.throws(() => isolation.create({ taskId: "task-2", ownerEntity: "Bima", worktreePath: "C:/Workspace/isolated/task-1" }), /PATH_CONFLICT/);
});

test("P12: surface switches preserve entity/session but clear authority", () => {
    const sessions = createPandawaSessionRegistry();
    const continuity = new PandawaSurfaceContinuity({ sessions });
    const first = continuity.bind({ sessionId: "ses-janaka", target: "Arjuna", surface: "voice", channel: "voice" });
    const next = continuity.switch({ sessionId: first.sessionId, target: "Janaka", surface: "pandawa", channel: "console" });
    assert.equal(first.targetEntity, "pandawa:janaka");
    assert.equal(next.targetEntity, first.targetEntity);
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(next.authorityContextRef, null);
});

test("P13: forged identities and surface authority claims fail closed", () => {
    const sessions = createPandawaSessionRegistry();
    const continuity = new PandawaSurfaceContinuity({ sessions });
    assert.throws(() => continuity.bind({ sessionId: "x", target: "pandawa:fake", surface: "voice" }), /PANDAWA/);
    assert.throws(() => continuity.bind({ sessionId: "x", target: "Janaka", surface: "unknown", authorityContextRef: "owner" }), /SURFACE_INVALID/);
});
