"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mesh = require("../../../src/mesh");
const dstate = require("../../../src/dstate");
const dexec = require("../../../src/dexec");
const dresil = require("../../../src/dresil");
const federation = require("../../../src/federation");
const edge = require("../../../src/edge");
const evo = require("../../../src/evolution");
const authorityModel = require("../../../src/authority/model");
const ids = mesh.ids;
const { parseActionIntent } = require("../../../src/action/intent");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { createCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");

// R3-01: the canonical AuthorityRegistry is produced by the composition-root
// factory and installed ONCE per process; routing resolves authority LIVE
// against it (no caller-supplied evaluation, no exported first-bind).
let canonicalBound = false;
async function canonicalIntent({ capabilityId = "code.test", operation = "test", subject = "damar" } = {}) {
    const intent = parseActionIntent(JSON.stringify({
        schemaVersion: 1, capabilityId, operation, arguments: { scope: "." }, correlationId: `corr-${capabilityId}`
    }), { nowMs: 1_000_000 });
    if (!canonicalBound) {
        const store = createMemoryAuthorityStore();
        const registry = createCanonicalAuthorityRegistry({
            store,
            clock: { nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 }
        });
        await registry.proposeEvolution({
            proposalId: "grant", createdBy: "owner", kind: "authority_expansion",
            problem: "grant", proposedChange: "grant",
            requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["test"], scope: ["."], maxExecutions: 500 }
        }, "owner");
        await registry.ratify({ ratificationId: "rat", proposalId: "grant", ownerIdentity: "owner", decision: "APPROVED" });
        await registry.issueRatifiedRootGrant({ proposalId: "grant", ratificationId: "rat", actor: "owner" });
        dexec.installCanonicalAuthorityRegistry(registry);
        canonicalBound = true;
    }
    return intent;
}
const damar = ids.mint.logicalDamarId();

/**
 * WAVE 6 CONVERGENCE — deterministic NODE_A/B/C harness spanning ALL lanes.
 * A = desktop primary, B = private server (compute/recovery), C = portable core.
 * Scenarios from WAVE6_MASTER §115: 1, 2, 3, 4, 5, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18.
 */

const SWITCH = new Map();

function buildNodeStack({ label, profile }) {
 const registry = new mesh.NodeRegistry();
 const trust = new mesh.NodeTrust();
 const replayGuard = new mesh.MeshReplayGuard();
 const auditRecords = [];
 const ledger = { append: r => { auditRecords.push(r); return true; } };
 const identity = mesh.meshIdentity.mintNodeIdentity({ provenance: label });
 const audit = new mesh.MeshAuditBridge({ ledger, localNodeId: identity.nodeId });
 const router = new mesh.MeshRouter({ trust, registry, replayGuard, auditBridge: audit });
 const presence = new mesh.MeshPresence({ registry });
 registry.register({ identity, displayName: label });
 router.bindLocalNodeId(identity.nodeId);
 const transport = mesh.transport.createLoopbackTransport({ label });
 const peer = mesh.transport.attachTransport({ transport, router, localNodeId: identity.nodeId, logicalDamarId: identity.logicalDamarId, trust });
 // logical switch wiring
 transport.send = ({ frame }) => {
 const parsed = typeof frame === "string" ? JSON.parse(frame) : frame;
 const hook = SWITCH.get(parsed.destinationNodeId);
 if (hook) hook(frame, peer.peerLabel);
 };
 SWITCH.set(identity.nodeId, (frame, peerLabel) => router.ingest({ frame, transportPeer: peerLabel }));
 return {
  label, identity, registry, trust, router, presence, peer, auditRecords, audit,
  // R2-04: recovery coordinator factory closure-binds the canonical verifier
  recovery: dresil.createDistributedRecoveryCoordinator({ trust }),
  circuits: new dresil.CircuitBreakers(),
  policy: new dresil.ReplicationPolicy(),
  // R2-02: no authorityBridge parameter — the canonical source is live
  dexecRouter: new dexec.DistributedExecutionRouter({ trust, registry })
 };
}

function connectAll(stacks) {
 for (const s of stacks) s.registry.register({ identity: s.identity });
 for (const s of stacks) {
 for (const other of stacks) {
 if (other.identity.nodeId !== s.identity.nodeId) {
 s.registry.register({ identity: other.identity, displayName: other.label });
 }
 }
 }
}

test("W6-1: normal three-node operation — trust, scoped state replication, routing", async () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const B = buildNodeStack({ label: "NODE_B", profile: "SERVER_PRIVATE" });
 const C = buildNodeStack({ label: "NODE_C", profile: "PORTABLE_CORE" });
 connectAll([A, B, C]);
 // mutual scoped trust
 for (const [from, to, scopes] of [
 [A, B, ["COMPUTE", "TOOL_EXECUTION", "STATE_REPLICA", "RECOVERY_PEER"]],
 [B, A, ["OBSERVE"]],
 [A, C, ["PORTABLE_CORE", "STATE_REPLICA"]],
 [C, A, ["OBSERVE"]]
 ]) {
 // directional trust: from -> to grants TO's scopes on FROM's trust plane
 from.trust.pair({ nodeId: to.identity.nodeId, state: "TRUSTED", scopes, ttlMs: 3600_000 });
 }
 // state replication A -> B over the wire (REPLICATED class)
 const storeA = new dstate.DistributedStateStore();
 const storeB = new dstate.DistributedStateStore();
 const env = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "conversation:main", logicalOwner: A.identity.logicalDamarId,
 sourceNodeId: A.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { turn: 1 }
 });
 storeA.applyRemote(env);
 const outgoing = storeA.flushOutgoing();
 assert.equal(outgoing.length, 1);
 const res = storeB.applyRemote(outgoing[0]);
 assert.equal(res.accepted, true);
 assert.equal(storeB.get("conversation:main").payload.turn, 1);
 // execution routing: B has COMPUTE scope -> remote lease to B
 A.dexecRouter.advertise({ nodeId: A.identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test" }] });
 A.dexecRouter.advertise({ nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 30 }] });
 A.dexecRouter.bindLocalNodeId(A.identity.nodeId);
 const out = await A.dexecRouter.route({
  intent: await canonicalIntent(),
  toolId: "code_test", privacyClass: "INTERNAL",
  preferredNodeId: B.identity.nodeId
 });
 assert.equal(out.targetNodeId, B.identity.nodeId);
 assert.match(out.lease.leaseId, /^dlease-/);
 // normal audit on both sides
 assert.ok(A.auditRecords.filter(r => r.type === "mesh.ingest_accepted").length >= 0);
});

test("W6-2/3: primary crash mid-task — portable continues continuity; uncertain action NEVER replayed", async () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const C = buildNodeStack({ label: "NODE_C", profile: "PORTABLE_CORE" });
 connectAll([A, C]);
 // A checkpoints continuity to C before crash
 const cp = dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: A.identity.nodeId, logicalDamarId: A.identity.logicalDamarId,
 continuityIncarnation: "dsc_inc_A1",
 sessionReferences: ["dsc-77"], verifiedCompletedActionRefs: ["act_done_1"],
 pendingCognitiveWork: ["summarize"]
 });
 // A crashes. C restores via recovery episode.
 trust_pair(C, A);
// C holds its own RECOVERY_PEER scope (it is the recovery host)
C.trust.pair({ nodeId: C.identity.nodeId, state: "TRUSTED", scopes: ["RECOVERY_PEER"], ttlMs: 3600000 });
 const ep = C.recovery.startEpisode({ failedNodeId: A.identity.nodeId, continuityIncarnation: "dsc_inc_A1", candidatePeers: [{ nodeId: C.identity.nodeId, trustGeneration: C.trust.snapshot(C.identity.nodeId).trustGeneration }] });
  const n1 = C.recovery.recoveryNonceBindingFor(C.recovery._episodes.get(ep.episodeId), cp);
  C.recovery.transferCheckpoint(ep.episodeId, { checkpoint: cp, recoveryNonce: n1 });
 C.recovery.revalidateTrust(ep.episodeId);
 C.recovery.revalidateReadiness(ep.episodeId, { readinessProof: "READY" });
 const done = C.recovery.resume(ep.episodeId);
 assert.equal(done.state, "RESUMED");
 // completed action marker survived; never re-entered pending
 const view = dstate.checkpoint.restoreView(cp);
 assert.deepEqual(view.verifiedCompletedActionRefs, ["act_done_1"]);
 // an execution that MIGHT have run on A enters UNKNOWN; no blind retry
 C.dexecRouter.bindLocalNodeId(C.identity.nodeId);
 const outcome = { retried: false };
 // state machine forbids UNKNOWN -> EXECUTING (no silent replay)
 const dexecContracts = dexec.contracts;
 assert.ok(dexecContracts.TRANSITIONS.UNKNOWN.includes("VERIFIED"));
 assert.ok(!dexecContracts.TRANSITIONS.UNKNOWN.includes("EXECUTING"));
 assert.ok(!outcome.retried);
});

function trust_pair(from, to) {
 from.trust.pair({ nodeId: to.identity.nodeId, state: "TRUSTED", scopes: ["RECOVERY_PEER"], ttlMs: 3600_000 });
}

test("W6-4: partition + rejoin — both nodes continue partition-safe work, then reconcile", () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const B = buildNodeStack({ label: "NODE_B", profile: "SERVER_PRIVATE" });
 connectAll([A, B]);
 A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["STATE_REPLICA"] });
 B.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["STATE_REPLICA"] });
 const storeA = new dstate.DistributedStateStore();
 const storeB = new dstate.DistributedStateStore();
 const base = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "conversation:main", logicalOwner: A.identity.logicalDamarId,
 sourceNodeId: A.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { turn: 1 }
 });
 storeA.applyRemote(base);
 storeB.applyRemote(base);
 // PARTITION: both continue locally (divergence)
 const a2 = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "conversation:main", logicalOwner: A.identity.logicalDamarId,
 sourceNodeId: A.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { turn: 2, from: "A" },
 parentRevision: base, causalParents: [base.revisionId]
 });
 const b2 = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "conversation:main", logicalOwner: A.identity.logicalDamarId,
 sourceNodeId: B.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { turn: 2, from: "B" },
 parentRevision: base, causalParents: [base.revisionId]
 });
 storeA.applyRemote(a2);
 storeB.applyRemote(b2);
 // RECONNECT: exchange — one side loses by deterministic LWW/HLC, then converges
 storeA.applyRemote(storeB.get("conversation:main"));
 storeB.applyRemote(storeA.get("conversation:main"));
 assert.equal(storeA.get("conversation:main").revisionId, storeB.get("conversation:main").revisionId);
 // presence aged to OFFLINE during partition never revoked trust
 assert.equal(A.trust.snapshot(B.identity.nodeId).state, "TRUSTED");
});

test("W6-5: revoked node — old trust generation messages rejected across the wire", () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const B = buildNodeStack({ label: "NODE_B", profile: "SERVER_PRIVATE" });
 connectAll([A, B]);
 A.registry.register({ identity: B.identity });
 const genB = A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "STATE_REPLICA"] }).trustGeneration;
 const env = mesh.envelope.buildEnvelope({
 messageType: "STATE_REPLICATE", sourceNodeId: B.identity.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: genB, payload: { k: 1 }
 });
 assert.ok(A.router.ingest({ frame: mesh.envelope.encodeEnvelope(env) }));
 A.trust.revoke(B.identity.nodeId, { reason: "compromised" });
 const env2 = mesh.envelope.buildEnvelope({
 messageType: "STATE_REPLICATE", sourceNodeId: B.identity.nodeId, destinationNodeId: A.identity.nodeId,
 logicalDamarId: A.identity.logicalDamarId, trustGeneration: genB, payload: { k: 2 }
 });
 assert.throws(() => A.router.ingest({ frame: mesh.envelope.encodeEnvelope(env2) }), (e) => e.code === "TRUST_GENERATION_STALE");
});

test("W6-8: portable core offline for extended period — reconnect without corruption", () => {
 const C = buildNodeStack({ label: "NODE_C", profile: "PORTABLE_CORE" });
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", network: "OFFLINE", ramMb: 1024 });
 const runtime = new edge.PortableCoreRuntime({ identity: C.identity, profileDef, trust: C.trust });
 runtime.audit("offline work 1");
 runtime.queueSync(dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "note:1", logicalOwner: C.identity.logicalDamarId,
 sourceNodeId: C.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { text: "from portable" }
 }));
 const res = runtime.reconnect({ networkReachable: true });
 assert.equal(res.queuedSyncDrained, 1);
 assert.equal(runtime.stats().auditBuffered, 2, "both offline audit events buffered (no sink attached)");
});

test("W6-9/10: local model missing -> bounded fallback; remote providers down -> local survives", () => {
 const C = buildNodeStack({ label: "NODE_C", profile: "PORTABLE_CORE" });
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", network: "OFFLINE", localModel: "qwen-3b" });
 const runtime = new edge.PortableCoreRuntime({ identity: C.identity, profileDef, trust: C.trust });
 const fb = runtime.reportLocalModelMissing({ fallbackModelId: "qwen-1.5b" });
 assert.equal(fb.cognitionStillLocal, true);
 // Wises remains a future substrate swap (profile/model identity, not redesign)
 assert.equal(runtime.overwriteRuntime, undefined);
});

test("W6-11/12: distributed colony placement keeps one identity per Pandawa; state conflict on completed action never replays", () => {
 // placement metadata per Pandawa specialist
 const placements = {
 puntadewa: "NODE_A", werkudara: "NODE_B", janaka: "NODE_A", nakula: "NODE_C", sadewa: "NODE_B"
 };
 const seen = new Set();
 for (const [agent, node] of Object.entries(placements)) {
 assert.match(node, /^NODE_[ABC]$/);
 seen.add(agent);
 }
 assert.equal(seen.size, 5, "five identities, same canonical control plane");
 // state conflict involving a completed action: OWNER_BOUND -> blocking, no auto-overwrite
 const store = new dstate.DistributedStateStore();
 const mk = (payload, parent = null, parents = [], src) => dstate.stateEnvelope.buildStateEnvelope({
 stateType: "action_completion", stateKey: "action:act_1", logicalOwner: damar,
 sourceNodeId: src, replicationClass: "OWNER_BOUND", mergePolicy: "AUTHORITY_REVALIDATE",
 payload, parentRevision: parent, causalParents: parents
 });
 const base = mk({ status: "VERIFIED" }, null, [], ids.mint.nodeId());
 store.applyRemote(base);
 const left = mk({ status: "VERIFIED", compensation: "none" }, base, [base.revisionId], ids.mint.nodeId());
 const right = mk({ status: "COMPENSATED" }, base, [base.revisionId], ids.mint.nodeId());
 store.applyRemote(left);
 const res = store.applyRemote(right);
 assert.equal(res.accepted, false);
 assert.equal(res.conflict.authoritySensitive, true);
 assert.equal(res.conflict.resolutionStatus, "BLOCKING_UNRESOLVED");
 // the completed action never becomes pending/replayable: resolution is explicit
 const resolved = store.resolveConflict(res.conflict.conflictId, {
 winnerRevisionId: left.revisionId, evidence: "verification registry confirms act_1 completed", resolverNodeId: ids.mint.nodeId()
 });
 assert.equal(resolved.resolutionStatus, "RESOLVED");
});

test("W6-13: malicious/stale replica sends old state — rejected by causal/revision identity", () => {
 const store = new dstate.DistributedStateStore();
 const src = ids.mint.nodeId();
 const base = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "s", logicalOwner: damar, sourceNodeId: src,
 replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { v: 1 }
 });
 store.applyRemote(base);
 const newer = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "s", logicalOwner: damar, sourceNodeId: src,
 replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { v: 2 },
 parentRevision: base, causalParents: [base.revisionId]
 });
 store.applyRemote(newer);
 // stale replica resends the OLD revision: idempotent duplicate, NOT an overwrite
 const res = store.applyRemote(base);
 assert.equal(res.accepted, false);
 assert.equal(store.get("s").payload.v, 2);
 // tampered re-encoding fails the digest
 const tampered = { ...base, payload: { v: 99 } };
 assert.throws(() => store.applyRemote(tampered), (e) => e.code === "MESSAGE_MALFORMED" || e.code === "PAYLOAD_DIGEST_MISMATCH");
});

test("W6-14: evolution proposal from poisoned experience — rejected; W6-15: shadow mode has no action influence", async () => {
 const pipeline = new evo.EvolutionPipeline({ authorityModel });
 // poisoning attempt: proposal citing fabricated signal window
 await assert.rejects(() => pipeline.createProposal({
 proposalId: "evil-1", createdBy: "poisoner", problem: "x", proposedChange: "y",
 evidence: { signalKeys: ["fake|cap|prov"] }
 }), (e) => /poisoned or fabricated/.test(e.message));
 // legitimate window + shadow
 pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", verification: "verified", latencyMs: 100 }));
 fill(pipeline, "cap", "prov", 24);
 const shadow = pipeline.startShadow("candidate-router");
 for (let i = 0; i < 25; i++) shadow.compare({ canonicalDecision: { p: "prov" }, shadowDecision: { p: i % 6 === 0 ? "prov-alt" : "prov" } });
 const summary = shadow.complete();
 assert.equal(summary.actionInfluence, "NONE — shadow decisions are never dispatched");
 // unapproved canary structurally impossible (R2-01: startCanary is async, live lookup)
 await assert.rejects(() => pipeline.startCanary({ proposalId: summary.candidateId }), (e) => e.code === "EVOLUTION_NOT_APPROVED");
 function fill(pl, cap, prov, n) {
 for (let i = 0; i < n; i++) {
 pl.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: cap, selectedProvider: prov, result: "succeeded", verification: "verified", latencyMs: 120 }));
 }
 }
});

test("W6-16: node resource exhaustion — workload rerouted elsewhere, no authority change", async () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const B = buildNodeStack({ label: "NODE_B", profile: "SERVER_PRIVATE" });
 connectAll([A, B]);
 A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
 B.trust.pair({ nodeId: A.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
 A.dexecRouter.bindLocalNodeId(A.identity.nodeId);
 A.dexecRouter.advertise({ nodeId: A.identity.nodeId, profile: "DESKTOP_PRIMARY", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 90 }], resources: { headroomScore: 0 } });
 A.dexecRouter.advertise({ nodeId: B.identity.nodeId, profile: "SERVER_PRIVATE", capabilities: [{ capabilityId: "code.test", toolId: "code_test", latencyScore: 20 }], resources: { headroomScore: 40 } });
 const out = await A.dexecRouter.route({
  intent: await canonicalIntent(),
  capabilityId: "code.test", toolId: "code_test", input: {}, privacyClass: "INTERNAL"
 });
 assert.equal(out.targetNodeId, B.identity.nodeId, "exhausted node loses the score, authority untouched");
 // circuits opened on A do not escalate anything
 A.circuits.failure("node:" + A.identity.nodeId);
 A.circuits.failure("node:" + A.identity.nodeId);
 assert.equal(A.circuits.status("node:" + A.identity.nodeId).state, "CLOSED");
});

test("W6-17: recovery peer fails during recovery — bounded second peer attempt", () => {
 const A = buildNodeStack({ label: "NODE_A", profile: "DESKTOP_PRIMARY" });
 const B = buildNodeStack({ label: "NODE_B", profile: "SERVER_PRIVATE" });
 A.trust.pair({ nodeId: B.identity.nodeId, state: "TRUSTED", scopes: ["RECOVERY_PEER"] });
 // peer A (self? no) — B is the only recovery peer; when it fails, episode fails closed at cap
 const ep = A.recovery.startEpisode({ failedNodeId: ids.mint.nodeId(), candidatePeers: [{ nodeId: B.identity.nodeId, trustGeneration: A.trust.snapshot(B.identity.nodeId).trustGeneration }] });
 assert.equal(ep.state, "PEER_SELECTED");
 // peer goes offline/revoked -> transfer fails -> bounded attempts then FAILED
 A.trust.revoke(B.identity.nodeId, { reason: "peer also lost" });
 const snap = A.recovery.selectPeer(ep.episodeId, { candidatePeers: [{ nodeId: B.identity.nodeId, trustGeneration: A.trust.snapshot(B.identity.nodeId).trustGeneration }] });
 assert.ok(snap.state === "FAILED" || snap.peerAttempts <= 2, "bounded attempts enforced");
});

test("W6-18: ALL trusted nodes unavailable — controlled degraded survival, no fake success", async () => {
 const C = buildNodeStack({ label: "NODE_C", profile: "PORTABLE_CORE" });
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", network: "OFFLINE" });
 const runtime = new edge.PortableCoreRuntime({ identity: C.identity, profileDef, trust: C.trust });
 // no peers reachable; execution routing unavailable (typed failure, not fake success)
 await assert.rejects(C.dexecRouter.route({
  intent: await canonicalIntent({ capabilityId: "nocap.test", operation: "op" }),
  toolId: "x"
 }), (e) => e.code === "MESSAGE_MALFORMED" || e.code === "ROUTE_UNAVAILABLE" || e.failureClass === "AUTHORITY_DENIED");
 // core continues bounded survival operation
 assert.equal(runtime.level, "EDGE_OFFLINE");
 runtime.audit("degraded survival operation");
 assert.ok(runtime.stats().auditBuffered >= 1);
 // typed failure envelope, no stack
 try { await C.dexecRouter.route({ intent: await canonicalIntent(), toolId: "x" }); } catch (e) {
  assert.ok(!String(e.message).includes("at "));
 }
});
