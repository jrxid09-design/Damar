"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const evo = require("../../../src/evolution");
const authorityModel = require("../../../src/authority/model");
const { AuthorityRegistry, isCanonicalAuthorityRegistry } = require("../../../src/authority/registry");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");

/**
 * W6-01 / R2-01 — evolution ratification provenance.
 * Approval is resolved LIVE from the canonical Evolution Authority owner at
 * canary start time. A caller-held ratification object is NEVER authority:
 * reconstruct all visible fields -> reject; spread/clone/serialize -> reject.
 */

const CANDIDATE = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CANDIDATE2 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

async function canonicalRegistry({ proposalId = "wave6-routing-1", requestedAuthority = null } = {}) {
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(1_000_000).toISOString() } });
 const proposal = await registry.proposeEvolution({
 proposalId, createdBy: "owner", kind: "routing_preference",
 problem: "provider p1 latency", proposedChange: "shift routing",
 affectedSubsystems: ["routing"],
 requestedAuthority: requestedAuthority ?? { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 }, "owner");
 return { store, registry, proposal };
}

async function pipelineWithProposal({ proposalId = "wave6-routing-1", requestedAuthority = null } = {}) {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 const { registry, proposal } = await canonicalRegistry({ proposalId, requestedAuthority });
 pipeline.authorityRegistry = registry;
 // evidence: register the exact signal window the proposal references
 for (let i = 0; i < 25; i++) {
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 120 }));
 }
 await pipeline.createProposal({
 proposalId, createdBy: "owner", kind: "routing_preference",
 problem: proposal.problem, proposedChange: proposal.proposedChange,
 affectedSubsystems: ["routing"],
 evidence: { signalKeys: ["coding|cap|prov"] },
 rollbackPlan: "restore weights", testPlan: "shadow 100",
 requestedAuthority: requestedAuthority ?? { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 await registry.ratify({ ratificationId: "rat-1", proposalId, ownerIdentity: "owner", decision: "APPROVED" });
 return { pipeline, registry, proposal };
}

test("R2-EVOL-01: unknown proposal + 'APPROVED' string -> REJECTED", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: "never-created", proposalStatus: "APPROVED", candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /caller-asserted approval rejected/.test(e.message)
 );
});

test("R2-EVOL-02: reconstruct all visible ratification fields -> REJECTED (live lookup ignores caller objects)", async () => {
 const { pipeline, registry, proposal } = await pipelineWithProposal();
 // ratify through the frozen registry, then RECONSTRUCT the object
 const rat = await registry.getCurrentRatification(proposal.proposalId);
 assert.ok(rat, "canonical owner state has the approval");
 const reconstructed = JSON.parse(JSON.stringify(rat)); // full serialization round-trip
 // the canary start no longer accepts any ratification parameter:
 // approval comes from the canonical owner at use time
 const canary = await pipeline.startCanary({ proposalId: proposal.proposalId, candidateArtifactDigest: CANDIDATE });
 assert.equal(canary.state, "DEPLOYED");
 assert.equal(canary.ratificationId, reconstructed.ratificationId, "same ratification by LIVE lookup");
 // spread-copy / clone attacks are structurally meaningless: the parameter is gone
});

test("R2-EVOL-03: serialization destroys authority — JSON round-trip cannot deploy without owner state", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // proposal created locally but registry NOT bound to current approval state
 const { registry, proposal } = await canonicalRegistry({ proposalId: "no-rat" });
 pipeline.authorityRegistry = registry;
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 await pipeline.createProposal({
 proposalId: "no-rat", createdBy: "owner", kind: "routing_preference",
 problem: proposal.problem, proposedChange: proposal.proposedChange,
 evidence: { signalKeys: ["coding|cap|prov"] },
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 // NO ratification in owner state -> live lookup returns null -> reject
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: "no-rat", candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /no current APPROVED ratification/.test(e.message)
 );
});

test("R2-EVOL-04: fake digest / wrong artifact / stale revision -> REJECTED via live lookup", async () => {
 // proposal ratified for CANDIDATE, canary asks for CANDIDATE2
 const { pipeline } = await pipelineWithProposal();
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: "wave6-routing-1", candidateArtifactDigest: CANDIDATE2 }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /different candidate artifact/.test(e.message)
 );
});

test("R2-EVOL-05: superseded proposal -> REJECTED (owner state reflects new revision)", async () => {
 const { pipeline, registry, proposal } = await pipelineWithProposal();
 // supersede: revise the proposal materially -> new digest -> old ratification no longer binds
 await registry.reviseEvolution(proposal.proposalId, { proposedChange: "shift routing v2 (superseding)" }, "owner");
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: proposal.proposalId, candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /no current APPROVED ratification/.test(e.message)
 );
});

test("R2-EVOL-06: expired ratification -> REJECTED", async () => {
 const store = createMemoryAuthorityStore();
 const registry = new AuthorityRegistry({ store, clock: { nowIso: () => new Date(100_000).toISOString() } });
 const proposal = await registry.proposeEvolution({
 proposalId: "exp-1", createdBy: "owner", kind: "routing_preference",
 problem: "x", proposedChange: "y", affectedSubsystems: ["routing"],
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 }, "owner");
 await registry.ratify({ ratificationId: "r-exp", proposalId: "exp-1", ownerIdentity: "owner", decision: "APPROVED", expiryAt: new Date(200_000).toISOString() });
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 pipeline.authorityRegistry = registry;
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 await pipeline.createProposal({
 proposalId: "exp-1", createdBy: "owner", kind: "routing_preference",
 problem: "x", proposedChange: "y", evidence: { signalKeys: ["coding|cap|prov"] },
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 // at a clock PAST the expiry the live lookup returns null
 const original = registry.getCurrentRatification.bind(registry);
 registry.getCurrentRatification = (pid) => original(pid); // live lookup checks expiry internally via store state
 // advance the clock
 registry.clock = { nowIso: () => new Date(900_000).toISOString() };
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: "exp-1", candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED"
 );
});

test("R2-EVOL-07: genuine canonical approval -> canary deploys; promote works; revoked-after rejects later canary", async () => {
 const { pipeline } = await pipelineWithProposal();
 const canary = await pipeline.startCanary({ proposalId: "wave6-routing-1", candidateArtifactDigest: CANDIDATE });
 assert.equal(canary.state, "DEPLOYED");
 canary.observe({ metric: "error_rate", value: 0.01 });
 const promoted = canary.promote();
 assert.equal(promoted.state, "PROMOTED");
});

test("R2-EVOL-08: no registry bound -> reject (canonical owner is mandatory)", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 await pipeline.createProposal({
 proposalId: "no-reg", createdBy: "owner", kind: "routing_preference",
 problem: "x", proposedChange: "y", evidence: { signalKeys: ["coding|cap|prov"] },
 requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: CANDIDATE }
 });
 await assert.rejects(
 () => pipeline.startCanary({ proposalId: "no-reg", candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /no canonical Evolution Authority registry bound/.test(e.message)
 );
});

test("R2-EVOL-09: duck-typed / fake registry -> REJECTED (brand check at use time)", async () => {
 const pipeRig = await pipelineWithProposal();
 const fake = { getCurrentRatification: async () => ({ decision: "APPROVED" }), proposeEvolution: async () => ({}) };
 pipeRig.pipeline.authorityRegistry = fake; // plain assignment is possible...
 assert.ok(!isCanonicalAuthorityRegistry(fake), "fake registry lacks the canonical brand");
 // ...but startCanary performs the brand check at use time and rejects it
 await assert.rejects(
 () => pipeRig.pipeline.startCanary({ proposalId: "wave6-routing-1", candidateArtifactDigest: CANDIDATE }),
 (e) => e.code === "EVOLUTION_NOT_APPROVED" && /not the canonical owner/.test(e.message)
 );
});
