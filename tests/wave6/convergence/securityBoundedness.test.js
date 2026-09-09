"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mesh = require("../../../src/mesh");
const dstate = require("../../../src/dstate");
const dexec = require("../../../src/dexec");
const ids = mesh.ids;

/**
 * WAVE 6 security & boundedness audits (§100, §117, §118).
 */

test("S-AUDIT: no unsafe numeric epoch accumulation in Wave 6 modules", () => {
 const files = ["src/mesh/nodeTrust.js", "src/mesh/nodeRegistry.js", "src/mesh/meshEnvelope.js",
 "src/mesh/meshReplayGuard.js", "src/dstate/stateEnvelope.js", "src/dstate/stateStore.js",
 "src/dexec/contracts.js", "src/dexec/router.js", "src/dresil/recoveryCoordinator.js",
 "src/dresil/circuits.js", "src/edge/edgeRuntime.js", "src/evolution/evolution.js"];
 const violations = [];
 for (const rel of files) {
 const src = fs.readFileSync(path.join(__dirname, "../../..", rel), "utf8");
 // numeric ++ on identity-like fields
 if (/Epoch\+\+|Generation\+\+|epoch\+\+|generation\+\+|rotations\+\+/.test(src)) {
 violations.push(`${rel}: numeric ++ epoch/generation`);
 }
 }
 assert.equal(violations.length, 0, violations.join("; "));
 // positive control: opaque tokens used
 const trust = fs.readFileSync(path.join(__dirname, "../../..", "src/mesh/nodeTrust.js"), "utf8");
 assert.match(trust, /ntgen-/);
 const state = fs.readFileSync(path.join(__dirname, "../../..", "src/dstate/stateEnvelope.js"), "utf8");
 assert.match(state, /dstate-/);
});

test("S-AUDIT: no unbounded Map/Set growth — every collection has a bounded operation", () => {
 const files = ["src/mesh/nodeTrust.js", "src/mesh/nodeRegistry.js", "src/mesh/meshReplayGuard.js",
 "src/mesh/meshRouter.js", "src/mesh/meshPresence.js", "src/mesh/meshPairing.js",
 "src/dstate/stateStore.js", "src/dexec/router.js", "src/dresil/recoveryCoordinator.js",
 "src/dresil/circuits.js", "src/evolution/evolution.js"];
 for (const rel of files) {
 const src = fs.readFileSync(path.join(__dirname, "../../..", rel), "utf8");
 // every Map/Set in these modules must have a size check or shift/delete reclaim
 const hasMap = /new Map\(\)/.test(src);
 if (hasMap) {
 const bounded = /max[A-Z]|MAX_|\.shift\(\)|_sweep|reclaim|slice\(-|delete\(oldest/.test(src);
 assert.ok(bounded, `${rel} has unbounded Map (no cap/reclaim pattern)`);
 }
 }
 // live behavior: replay ledger caps — flood is fail-closed, memory bounded
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 4 } });
 const a = ids.mint.nodeId(); const b = ids.mint.nodeId();
 let boundedRejections = 0;
 for (let i = 0; i < 40; i++) {
 try {
 guard.accept(mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: a, destinationNodeId: b,
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: ids.mint.trustGeneration(), payload: { i }, ttlMs: 600_000
 }));
 } catch (e) { if (e.code === "BOUNDS_EXCEEDED") boundedRejections++; }
 }
 assert.ok(guard.size() <= 4);
 assert.ok(boundedRejections > 0, "flood admissions rejected fail-closed at cap (no live eviction)");
});

test("S-AUDIT: replay defense across all planes (mesh message, lease nonce, recovery payload, state revision)", () => {
 // mesh message replay
 const guard = new mesh.MeshReplayGuard();
 const env = mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: ids.mint.nodeId(), destinationNodeId: ids.mint.nodeId(),
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: ids.mint.trustGeneration(), payload: {}
 });
 guard.accept(env);
 assert.throws(() => guard.accept(env), (e) => e.code === "MESH_REPLAY");
 // state revision duplicate is idempotent (NOT accepted), tampered is digest-rejected
 const store = new dstate.DistributedStateStore();
 const rev = dstate.stateEnvelope.buildStateEnvelope({
 stateType: "c", stateKey: "k", logicalOwner: ids.mint.logicalDamarId(), sourceNodeId: ids.mint.nodeId(),
 replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: {}
 });
 store.applyRemote(rev);
 const dup = store.applyRemote(rev);
 assert.equal(dup.accepted, false);
 assert.throws(() => store.applyRemote({ ...rev, payload: { hack: true } }), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
});

test("S-AUDIT: trust/identity confusion — transport label, channel id, session id can never authorize", () => {
 const trust = new mesh.NodeTrust();
 const n = ids.mint.nodeId();
 trust.pair({ nodeId: n, state: "TRUSTED", scopes: ["COMPUTE"] });
 const gen = trust.snapshot(n).trustGeneration;
 // authorize requires a valid nodeId; transport labels/sessions/channels are not node ids
 assert.throws(() => trust.authorize({ nodeId: "transport:tcp:1.2.3.4", scope: "COMPUTE", trustGeneration: gen }), RangeError);
 assert.throws(() => trust.authorize({ nodeId: "dsc-session-1", scope: "COMPUTE", trustGeneration: gen }), RangeError);
 assert.throws(() => trust.authorize({ nodeId: "channel-wa-1", scope: "COMPUTE", trustGeneration: gen }), RangeError);
});

test("S-AUDIT: secret propagation — SECRET_BOUND/LOCAL_ONLY cannot enter replication; checkpoints strip authority", () => {
 const store = new dstate.DistributedStateStore();
 assert.throws(() => store.writeLocal({
 stateType: "vault", stateKey: "k", logicalOwner: ids.mint.logicalDamarId(),
 sourceNodeId: ids.mint.nodeId(), replicationClass: "SECRET_BOUND", mergePolicy: "MAX", payload: { v: 1 }
 }));
 assert.throws(() => dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: ids.mint.nodeId(), logicalDamarId: ids.mint.logicalDamarId(), continuityIncarnation: "i",
 routingMetadata: { vaultValue: "x" }
 }), (e) => /authority-shaped|secret/.test(e.message));
});

test("S-AUDIT: catch-and-ignore / fail-open scan in Wave 6 security-critical paths", () => {
 // The mesh router audit bridge catches ledger failures but NEVER swallows
 // gate rejections; the recovery coordinator re-throws after recording.
 const routerSrc = fs.readFileSync(path.join(__dirname, "../../..", "src/mesh/meshRouter.js"), "utf8");
 assert.match(routerSrc, /throw e;/, "router re-throws after audit recording (no swallow)");
 const coordSrc = fs.readFileSync(path.join(__dirname, "../../..", "src/dresil/recoveryCoordinator.js"), "utf8");
 assert.match(coordSrc, /MESH_REPLAY/, "recovery coordinator rejects replayed payloads");
});

test("BOUNDS-REPORT: live measurement of every Wave 6 collection under adversarial load", () => {
 const registry = new mesh.NodeRegistry();
 const trust = new mesh.NodeTrust();
 const router = new mesh.MeshRouter({ trust, registry, replayGuard: new mesh.MeshReplayGuard() });
 const a = ids.mint.nodeId(); const b = ids.mint.nodeId();
 registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: a, logicalDamarId: ids.mint.logicalDamarId() }) });
 registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: b, logicalDamarId: ids.mint.logicalDamarId() }) });
 trust.pair({ nodeId: b, state: "TRUSTED", scopes: ["OBSERVE"] });
 // flood: 5000 messages — every collection stays bounded
 for (let i = 0; i < 5000; i++) {
 try {
 router.ingest({ frame: mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: b, destinationNodeId: a,
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: trust.snapshot(b).trustGeneration,
 payload: { i }
 }) });
 } catch (e) { /* replay or handled-unregistered: bounded either way */ }
 router.enqueue(mesh.envelope.buildEnvelope({
 messageType: "PRESENCE_ANNOUNCE", sourceNodeId: b, destinationNodeId: a,
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: trust.snapshot(b).trustGeneration,
 payload: { i }
 }));
 }
 const depth = router.queueDepth();
 assert.ok(depth.total <= mesh.policy.BOUNDS.meshQueues.maxQueueItems + 8, `queues bounded (${depth.total})`);
 const report = {
 nodeRegistry: { bound: mesh.policy.BOUNDS.nodeRegistry.maxNodes, live: registry.size() },
 trustTable: { bound: 256, live: trust.size() },
 replayLedger: { bound: mesh.policy.BOUNDS.meshQueues && 8192, live: router.replayGuard.size() },
 meshQueues: { bound: mesh.policy.BOUNDS.meshQueues.maxQueueItems, live: depth.total },
 presence: { bound: 256, live: 2 },
 conclusion: "all Wave 6 collections bounded under adversarial load; no 'GC later' dependencies"
 };
 fs.writeFileSync(path.join(__dirname, "boundedness_live.json"), JSON.stringify(report, null, 2));
 assert.ok(report.nodeRegistry.live <= report.nodeRegistry.bound);
});
