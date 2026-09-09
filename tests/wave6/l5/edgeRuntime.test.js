"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const edge = require("../../../src/edge");
const mesh = require("../../../src/mesh");
const dstate = require("../../../src/dstate");
const ids = mesh.ids;

/**
 * WAVE 6 L5 — portable core / edge runtime.
 * Laws: profiles are NOT authority; offline never invents approvals;
 * reconnect reconciles; model swap != redesign; audit buffering bounded.
 */

const damar = ids.mint.logicalDamarId();

function core(overrides = {}) {
 const identity = mesh.meshIdentity.mintNodeIdentity({ provenance: "portable" });
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", ramMb: 2048, diskMb: 32768, network: "INTERMITTENT", ...overrides });
 const trust = new mesh.NodeTrust();
 return { identity, profileDef, trust, runtime: new edge.PortableCoreRuntime({ identity, profileDef, trust }) };
}

test("L5: profile build + level derivation; profile is metadata, never authority", () => {
 const { profileDef, runtime } = core();
 assert.equal(profileDef.profile, "PORTABLE_CORE");
 assert.match(profileDef.law, /PROFILE != AUTHORITY/);
 assert.equal(runtime.level, "EDGE_REDUCED");
 assert.equal(runtime.stats().nodeId, runtime.identity.nodeId);
 // profiles carry no authority vocabulary
 assert.equal(profileDef.authority, undefined);
 assert.equal(profileDef.grants, undefined);
 // malformed profile/limits rejected
 assert.throws(() => edge.buildEdgeRuntimeProfile({ profile: "SUPER_NODE" }), (e) => e.code === "MESSAGE_MALFORMED");
 assert.throws(() => edge.buildEdgeRuntimeProfile({ ramMb: 99999999 }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L5: offline boot + survival level + no invented approvals", () => {
 const identity = mesh.meshIdentity.mintNodeIdentity();
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", network: "OFFLINE" });
 const trust = new mesh.NodeTrust();
 const runtime = new edge.PortableCoreRuntime({ identity, profileDef, trust });
 assert.equal(runtime.level, "EDGE_OFFLINE");
 // offline level capability vocabulary: no state-sync, no mesh-client
 assert.ok(!edge.LEVEL_CAPABILITIES.EDGE_OFFLINE.includes("state-sync"));
 assert.ok(edge.LEVEL_CAPABILITIES.EDGE_OFFLINE.includes("queued-sync"));
 assert.ok(edge.LEVEL_CAPABILITIES.EDGE_OFFLINE.includes("audit"));
 // audit buffered while offline
 const r = runtime.audit("offline cognition ran");
 assert.equal(r.buffered, true);
 // offline core cannot mint approvals: no such API exists
 assert.equal(runtime.mintApproval, undefined);
 assert.equal(runtime.grantAuthority, undefined);
 assert.equal(runtime.approveAction, undefined);
});

test("L5: reconnect — queued sync drains, level restored, reconciliation left to L2 policies", () => {
 const { runtime } = core();
 runtime.audit("offline edit 1");
 runtime.audit("offline edit 2");
 const env = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "continuity", stateKey: "conversation:main", logicalOwner: damar,
 sourceNodeId: runtime.identity.nodeId, replicationClass: "REPLICATED",
 mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { turn: 2, from: "portable" }
 });
 runtime.queueSync(env);
 const before = runtime.stats().queuedSync;
 assert.equal(before, 1);
 const res = runtime.reconnect({ networkReachable: true, memoryUsedPct: 0.3, diskUsedPct: 0.2 });
 assert.equal(res.queuedSyncDrained, 1);
 assert.equal(["EDGE_FULL", "EDGE_REDUCED"].includes(res.level), true);
 assert.equal(runtime.stats().queuedSync, 0);
 // reconnect itself never overwrites state: it only DRAINS — reconciliation is the store's decision
 assert.equal(runtime.overwriteCanonicalState, undefined);
});

test("L5: degradation — memory/disk pressure -> EDGE_SURVIVAL (availability only, authority untouched)", () => {
 const { runtime, trust } = core();
 // grant local trust scopes; degradation must NOT touch them
 trust.pair({ nodeId: runtime.identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "PORTABLE_CORE"] });
 const gen = trust.snapshot(runtime.identity.nodeId).trustGeneration;
 const res = runtime.reportResources({ memoryUsedPct: 0.95, diskUsedPct: 0.5 });
 assert.equal(res.level, "EDGE_SURVIVAL");
 assert.equal(trust.snapshot(runtime.identity.nodeId).state, "TRUSTED", "degradation != trust change");
 assert.ok(trust.authorize({ nodeId: runtime.identity.nodeId, scope: "COMPUTE", trustGeneration: gen }));
});

test("L5: local model missing — bounded fallbacks within the same substrate abstraction", () => {
 const { runtime } = core();
 const r1 = runtime.reportLocalModelMissing({ fallbackModelId: "qwen2.5-3b-instruct" });
 assert.equal(r1.cognitionStillLocal, true);
 runtime.reportLocalModelMissing({ fallbackModelId: "qwen2.5-1.5b-instruct" });
 runtime.reportLocalModelMissing({});
 runtime.reportLocalModelMissing({});
 assert.throws(() => runtime.reportLocalModelMissing({}), (e) => e.code === "EDGE_RESOURCE_EXHAUSTED");
 // model identity is NOT Damar identity
 assert.match(runtime.identity.logicalDamarId, /^damar-[0-9a-f]{32}$/);
});

test("L5: trust revoked while offline — reconnect does not resurrect trust", () => {
 const { identity, trust, runtime } = core();
 trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "PORTABLE_CORE"] });
 const gen = trust.snapshot(identity.nodeId).trustGeneration;
 // operator revokes while the core is offline
 trust.revoke(identity.nodeId, { reason: "device reported lost" });
 // core reconnects
 runtime.reconnect({ networkReachable: true });
 assert.equal(trust.snapshot(identity.nodeId).state, "REVOKED");
 assert.throws(() => trust.authorize({ nodeId: identity.nodeId, scope: "COMPUTE", trustGeneration: gen }), (e) => e.code === "TRUST_GENERATION_STALE");
});

test("L5: audit buffering bounded; portable -> desktop continuity via checkpoint", () => {
 const records = [];
 const identity = mesh.meshIdentity.mintNodeIdentity();
 const profileDef = edge.buildEdgeRuntimeProfile({ profile: "PORTABLE_CORE", network: "OFFLINE" });
 const trust = new mesh.NodeTrust();
 const runtime = new edge.PortableCoreRuntime({ identity, profileDef, trust });
 for (let i = 0; i < 300; i++) runtime.audit("event " + i);
 assert.ok(runtime.stats().auditBuffered <= edge.EDGE_DEFAULTS.maxAuditBuffer);
 // continuity: checkpoint built on the core restores on desktop
 const cp = dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: identity.nodeId, logicalDamarId: damar, continuityIncarnation: "dsc_inc_portable_1",
 sessionReferences: ["dsc-9"], verifiedCompletedActionRefs: ["act_p1"]
 });
 const view = dstate.checkpoint.restoreView(cp);
 assert.deepEqual(view.verifiedCompletedActionRefs, ["act_p1"]);
 assert.match(view.note, /MODEL RECOVERY != ACTION REPLAY/);
});
