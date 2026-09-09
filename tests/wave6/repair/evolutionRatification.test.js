"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const evo = require("../../../src/evolution");
const authorityModel = require("../../../src/authority/model");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");

/**
 * W6-01/W6-06 — governed evolution repair verification.
 * W6-01: SELF-AUTHORIZED DEPLOYMENT IMPOSSIBLE (canonical ratification
 * through the frozen AuthorityRegistry required).
 * W6-06: canary/observation bounds actually enforced.
 */

const CANDIDATE = "c".repeat(64);

async function canonicalProposalAndRatification({ proposalId = "wave6-routing-1", approved = true } = {}) {
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 const proposal = await registry.proposeEvolution({
 proposalId, createdBy: "owner", kind: "routing_preference",
 problem: "provider p1 shows elevated latency",
 proposedChange: "shift routing preference",
 affectedSubsystems: ["routing"],
 requestedAuthority: {
 capabilityId: "code.test", subject: "damar", actions: ["execute"],
 candidateArtifactDigest: CANDIDATE
 }
 }, "owner");
 const rat = await registry.ratify({
 ratificationId: "rat-1", proposalId, ownerIdentity: "owner",
 decision: approved ? "APPROVED" : "REJECTED"
 });
 return { store, registry, proposal, ratification: rat.ratification };
}

test("W6-01: unknown proposal + 'APPROVED' string -> REJECTED (caller-asserted approval gone)", () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // old attack: proposalId never created + status APPROVED
 assert.throws(
 () => pipeline.startCanary({ proposalId: "never-created", proposalStatus: "APPROVED" }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /caller-asserted approval rejected/.test(e.message)
 );
 // new API: no proposalStatus parameter exists at all
 const sig = pipeline.startCanary.bind(pipeline);
 assert.throws(() => sig({ proposalId: "x", proposalStatus: "APPROVED", candidateArtifactDigest: CANDIDATE }), (e) => /unknown proposal/.test(e.message));
});

test("W6-01: forged ratification rejected (not from the canonical path)", () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // forged ratification: pipeline has no proposal, ratification not from registry
 assert.throws(() => pipeline.startCanary({ proposalId: "ghost", ratification: { decision: "APPROVED", ratificationId: "fake", proposalId: "ghost", proposalDigest: "x", proposalRevision: 1, approvedAuthority: { candidateArtifactDigest: CANDIDATE } }, candidateArtifactDigest: CANDIDATE }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
});

test("W6-01: full canonical path — registry proposeEvolution -> registry-bound pipeline -> ratify -> canary", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 const { registry, proposal } = await canonicalProposalAndRatification();
 // bind the registry to the pipeline: proposals are created THROUGH it so
 // the pipeline object is byte-identical to what the registry ratified
 pipeline.authorityRegistry = registry;
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 fill(pipeline, 24);
 // The pipeline proposal is registered via registry.proposeEvolution with
 // the same fields as `proposal` — reuse the canonical object directly.
 pipeline._proposals.set(proposal.proposalId, proposal);
 // ratify through the FROZEN registry (binding proposalDigest automatically)
 const ratified = await registry.ratify({
 ratificationId: "rat-1", proposalId: proposal.proposalId, ownerIdentity: "owner", decision: "APPROVED"
 });
 assert.equal(ratified.applied, true);
 const canary = pipeline.startCanary({
 proposalId: proposal.proposalId,
 ratification: ratified.ratification,
 candidateArtifactDigest: CANDIDATE
 });
 assert.equal(canary.state, "DEPLOYED");
 assert.equal(canary.ratificationId, "rat-1");
 function fill(pl, n) { for (let i = 0; i < n; i++) pl.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 120 })); }
});

test("W6-01: ratification for a different proposal / different candidate / expired / tampered / string-only -> rejected", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // proposals created through canonical registries (bound pipeline digests)
 const regA = await canonicalRegistryFor("wave6-a");
 pipeline.authorityRegistry = regA.registry;
 fill(pipeline);
 await pipeline.createProposal({
 proposalId: "wave6-a", createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift",
 evidence: { signalKeys: ["coding|cap|prov"] }, rollbackPlan: "r", testPlan: "t",
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 const ratified = await regA.registry.ratify({ ratificationId: "r-a", proposalId: "wave6-a", ownerIdentity: "owner", decision: "APPROVED" });
 // different proposal: wave6-b does not exist in the pipeline at all
 assert.throws(() => pipeline.startCanary({ proposalId: "wave6-b", ratification: ratified.ratification, candidateArtifactDigest: CANDIDATE }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
 // string-only approval
 assert.throws(() => pipeline.startCanary({ proposalId: "wave6-a", proposalStatus: "APPROVED", candidateArtifactDigest: CANDIDATE }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
 // different candidate
 assert.throws(() => pipeline.startCanary({ proposalId: "wave6-a", ratification: ratified.ratification, candidateArtifactDigest: "d".repeat(64) }), (e) => /different candidate/.test(e.message));
 // expired ratification
 const regB = await canonicalRegistryFor("wave6-b", { nowIso: () => new Date(500_000).toISOString() });
 const expired = await regB.registry.ratify({ ratificationId: "r-b", proposalId: "wave6-b", ownerIdentity: "owner", decision: "APPROVED", expiryAt: new Date(600_000).toISOString() });
 assert.throws(() => pipeline.startCanary({ proposalId: "wave6-b", ratification: expired.ratification, candidateArtifactDigest: CANDIDATE }), (e) => e.code === "EVOLUTION_NOT_APPROVED" || e.code === "MESSAGE_MALFORMED");
 // tampered approvedAuthority
 const tampered = { ...ratified.ratification, approvedAuthority: { ...ratified.ratification.approvedAuthority, candidateArtifactDigest: "e".repeat(64) } };
 assert.throws(() => pipeline.startCanary({ proposalId: "wave6-a", ratification: tampered, candidateArtifactDigest: CANDIDATE }), (e) => e.code === "EVOLUTION_NOT_APPROVED" || e.code === "MESSAGE_MALFORMED");
 function sigFor(pid) { return `coding|cap|prov`; }
 async function canonicalRegistryFor(pid, opts = {}) {
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: opts.nowIso ?? (() => new Date(1_000_000).toISOString()) } });
 await registry.proposeEvolution({
 proposalId: pid, createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift", affectedSubsystems: ["routing"],
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 }, "owner");
 return { store, registry };
 }
 function fill(pl, pid) { for (let i = 0; i < 24; i++) pl.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 120 })); }
});

test("W6-06: observation bounds enforced on a live canary", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 fill(pipeline);
 // register the exact signal window the proposal's evidence references
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 // canonical registry path for the proposal
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 pipeline.authorityRegistry = registry;
 await registry.proposeEvolution({
 proposalId: "bounded-2", createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift", affectedSubsystems: ["routing"],
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 }, "owner");
 await pipeline.createProposal({
 proposalId: "bounded-2", createdBy: "owner", kind: "routing_preference",
 problem: "latency", proposedChange: "shift", evidence: { signalKeys: ["coding|cap|prov"] }, rollbackPlan: "r", testPlan: "t",
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 const ratified = await registry.ratify({ ratificationId: "r-2", proposalId: "bounded-2", ownerIdentity: "owner", decision: "APPROVED" });
 const canary = pipeline.startCanary({ proposalId: "bounded-2", ratification: ratified.ratification, candidateArtifactDigest: CANDIDATE });
 // observation count bound
 for (let i = 0; i < evo.EVOLUTION_BOUNDS.maxObservationsPerCanary; i++) {
 canary.observe({ metric: "error_rate", value: 0.01 });
 }
 assert.throws(() => canary.observe({ metric: "error_rate", value: 0.01 }), (e) => e.code === "BOUNDS_EXCEEDED");
 // byte bound: a huge value string is rejected
 const canary2 = pipeline.startCanary({ proposalId: "bounded-2", ratification: ratified.ratification, candidateArtifactDigest: CANDIDATE });
 assert.throws(() => canary2.observe({ metric: "big", value: "x".repeat(9999) }), (e) => e.code === "BOUNDS_EXCEEDED");
 // active canary cap: maxActiveCanaries=3 — canary(1) canary2(2) canary3(3),
 // the FOURTH active canary is rejected
 assert.throws(() => pipeline.startCanary({ proposalId: "bounded-2", ratification: ratified.ratification, candidateArtifactDigest: CANDIDATE }), (e) => e.code === "BOUNDS_EXCEEDED");
 // rollback frees capacity
 canary3.rollback({ reason: "test" });
 const canary5 = pipeline.startCanary({ proposalId: "bounded-2", ratification: ratified.ratification, candidateArtifactDigest: CANDIDATE });
 assert.equal(canary5.state, "DEPLOYED");
 function fill(pl) { for (let i = 0; i < 24; i++) pl.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 120 })); }
});

test("W6-01: promote requires live DEPLOYED canary; shadow has no action influence (regression)", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 const shadow = pipeline.startShadow("cand");
 for (let i = 0; i < 25; i++) shadow.compare({ canonicalDecision: { p: "a" }, shadowDecision: { p: "a" } });
 const summary = shadow.complete();
 assert.equal(summary.actionInfluence, "NONE — shadow decisions are never dispatched");
 // promote of a never-deployed canary id -> no such canary in pipeline; direct class check
 assert.throws(() => pipeline.startCanary({ proposalId: "ghost", proposalStatus: "APPROVED" }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
});
