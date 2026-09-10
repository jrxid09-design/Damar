"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const evo = require("../../../src/evolution");
const authorityModel = require("../../../src/authority/model");
const { sha256Hex } = require("../../../src/mesh/canonical");
const CANDIDATE = sha256Hex({ candidate: "wave6-test" });

/**
 * WAVE 6 L7 — governed evolution.
 * Laws: SELF-IMPROVEMENT != SELF-AUTHORIZATION; PROPOSAL != APPROVAL;
 * LEARNED BEHAVIOR != POLICY CHANGE; canary requires APPROVED; rollback always.
 */

function sigKey(seed) { return `coding|cap-${seed}|prov-${seed}`; }

function fillExperiences(pipeline, { successes = 18, failures = 2, seed = "x" } = {}) {
 for (let i = 0; i < successes; i++) {
 pipeline.recordExperience(evo.buildExperienceRecord({
 taskType: "coding", selectedCapability: `cap-${seed}`, selectedProvider: `prov-${seed}`,
 result: "succeeded", verification: "verified", latencyMs: 100 + i, confidence: 0.9
 }));
 }
 for (let i = 0; i < failures; i++) {
 pipeline.recordExperience(evo.buildExperienceRecord({
 taskType: "coding", selectedCapability: `cap-${seed}`, selectedProvider: `prov-${seed}`,
 result: "failed", failureReason: "provider timeout", latencyMs: 5000
 }));
 }
}

test("L7: experience records — bounded, secret-shaped fields rejected, digest forgery detected", () => {
 const rec = evo.buildExperienceRecord({ taskType: "coding", result: "succeeded", confidence: 0.9 });
 assert.match(rec.recordId, /^dexp-[0-9a-f]{24}$/);
 // secret-shaped fields rejected
 assert.throws(() => evo.buildExperienceRecord({ taskType: "coding", routingDecision: { apiKey: "sk-..." } }), (e) => /secret-shaped/.test(e.message));
 assert.throws(() => evo.buildExperienceRecord({ taskType: "coding", userCorrection: null, routingDecision: { password: "hunter2" } }), (e) => /secret-shaped/.test(e.message));
 // bad confidence rejected
 assert.throws(() => evo.buildExperienceRecord({ taskType: "x", result: "succeeded", confidence: 5 }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L7: learning signals — recommendations only, never policy change", () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 fillExperiences(pipeline, { seed: "a" });
 const rec = pipeline.experiences.recommendation(sigKey("a"));
 assert.equal(rec.kind, "RECOMMENDATION");
 assert.ok(rec.reliability >= 0.85 && rec.reliability <= 0.95);
 assert.match(rec.law, /LEARNED BEHAVIOR != POLICY CHANGE/);
 // recommendation exposes no apply/set methods
 assert.equal(rec.apply, undefined);
 assert.equal(rec.enact, undefined);
});

test("L7: proposals — built via FROZEN authority builder, DRAFT status, evidence poisoning rejected", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 fillExperiences(pipeline, { seed: "b" });
 const proposal = await pipeline.createProposal({
 proposalId: "wave6-routing-pref-b", createdBy: "evolution-pipeline",
 problem: "provider prov-b shows elevated latency",
 proposedChange: "shift coding routing preference toward alternative provider",
 evidence: { signalKeys: [sigKey("b")] },
 rollbackPlan: "restore previous routing weights", testPlan: "shadow 100 comparisons"
 });
 assert.equal(proposal.status, "DRAFT", "PROPOSAL != APPROVAL");
 assert.equal(proposal.kind, "routing_preference");
 assert.match(proposal.law, /EVOLUTION PROPOSAL != EVOLUTION APPROVAL/);
 // poisoned evidence: unknown signal window
 await assert.rejects(() => pipeline.createProposal({
 proposalId: "poisoned-1", createdBy: "attacker", problem: "x", proposedChange: "y",
 evidence: { signalKeys: ["fabricated|cap-x|prov-x"] }
 }), (e) => /poisoned or fabricated/.test(e.message));
 // proposal without evidence at all
 await assert.rejects(() => pipeline.createProposal({
 proposalId: "no-evidence", createdBy: "attacker", problem: "x", proposedChange: "y", evidence: null
 }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L7: shadow evaluation — divergence measured, zero action influence", () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 const shadow = pipeline.startShadow("candidate-router-1");
 for (let i = 0; i < 25; i++) {
 shadow.compare({
 canonicalDecision: { provider: "prov-a" },
 shadowDecision: { provider: i % 5 === 0 ? "prov-b" : "prov-a" },
 outcome: "observed"
 });
 }
 const summary = shadow.complete();
 assert.equal(summary.actionInfluence, "NONE — shadow decisions are never dispatched");
 assert.ok(summary.divergenceRate <= 0.2);
 assert.equal(summary.evidenceFor, "SUFFICIENT");
 // completed shadow cannot accept more comparisons
 assert.throws(() => shadow.compare({ canonicalDecision: {}, shadowDecision: {} }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L7: canary requires APPROVED proposal — self-authorization structurally impossible", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // R2-01: startCanary is async and resolves approval LIVE from the canonical
 // registry — caller-asserted ratification objects are not an API at all
 await assert.rejects(() => pipeline.startCanary({ proposalId: "p1" }), (e) => e.code === "EVOLUTION_NOT_APPROVED");

 // inline proposal objects are REJECTED: the proposal must exist in the
 // pipeline (registered via the frozen registry) — no direct-object bypass
 await assert.rejects(() => pipeline.startCanary({ proposalId: "p2", proposal: { proposalId: "p2", digest: "d".repeat(64), revision: 1 }, ratification: { decision: "APPROVED", ratificationId: "r1", proposalId: "p2", proposalDigest: "d".repeat(64), proposalRevision: 1, approvedAuthority: { candidateArtifactDigest: CANDIDATE }, approvedAuthorityDigest: sha256Hex({ candidateArtifactDigest: CANDIDATE }) }, candidateArtifactDigest: CANDIDATE }), (e) => /unknown proposal|caller-asserted/.test(e.message));
 // canonical path: registry-bound pipeline + registry ratification
 const { AuthorityRegistry } = require("../../../src/authority/registry");
 const { createMemoryAuthorityStore } = require("../../../src/authority/store");
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 // R2-01: canary approval resolves at USE time from the bound canonical
 // registry's owner state (getCurrentRatification), never a caller object
 pipeline.authorityRegistry = registry;
 // register the exact signal window the proposal's evidence references
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 for (let i = 0; i < 23; i++) pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 120 }));
 await registry.proposeEvolution({
 proposalId: "canary-e2e", createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift", affectedSubsystems: ["routing"],
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 }, "owner");
 await pipeline.createProposal({
 proposalId: "canary-e2e", createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift", evidence: { signalKeys: ["coding|cap|prov"] }, rollbackPlan: "r", testPlan: "t",
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 const ratified = await registry.ratify({ ratificationId: "r-e2e", proposalId: "canary-e2e", ownerIdentity: "owner", decision: "APPROVED" });
 assert.equal(ratified.applied, true);
 // R2-01: approval resolves LIVE from the canonical registry — no
 // caller-supplied ratification object is accepted by the API
 const canary = await pipeline.startCanary({ proposalId: "canary-e2e", candidateArtifactDigest: CANDIDATE, scope: { node: "dnode-x", capability: "routing" } });
 assert.equal(canary.state, "DEPLOYED");
 canary.observe({ metric: "error_rate", value: 0.01 });
 // rollback always available
 const rb = canary.rollback({ reason: "error rate drift" });
 assert.equal(rb.state, "ROLLED_BACK");
 // promoted canary also enforces TTL
 const canary2 = await pipeline.startCanary({ proposalId: "canary-e2e", candidateArtifactDigest: CANDIDATE, ttlMs: 1000 });
 canary2.observe({ metric: "error_rate", value: 0 });
 assert.equal(canary2.expiresAtMs > canary2.deployedAtMs, true);
 const promoted = canary2.promote();
 assert.equal(promoted.state, "PROMOTED");
 // post-terminal operations rejected
 assert.throws(() => canary2.rollback({ reason: "late" }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L7: single failure does not overreact; metrics poisoning guarded by signal bounds", () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "t", selectedCapability: "c1", selectedProvider: "p1", result: "failed" }));
 const rec = pipeline.experiences.recommendation("t|c1|p1");
 assert.ok(rec.samples === 1 && rec.failure === 1);
 // one failure is data, not action: recommendation only
 assert.equal(rec.kind, "RECOMMENDATION");
 // bounded windows: flooding experiences does not grow signal table unbounded
 for (let i = 0; i < 100; i++) {
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: `t${i}`, selectedCapability: "c", selectedProvider: "p", result: "succeeded" }));
 }
 assert.ok(pipeline.experiences.size() <= evo.EXPERIENCE_DEFAULTS.maxSignalWindows);
});

test("L7: pipeline requires the frozen authority model — no parallel evolution authority", () => {
 assert.throws(() => new evo.EvolutionPipeline({ authorityModel: null }), TypeError);
 assert.throws(() => new evo.EvolutionPipeline({ authorityModel: { buildEvolutionProposal: "not-a-function" } }), TypeError);
});
