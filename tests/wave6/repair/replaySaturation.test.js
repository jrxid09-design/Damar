"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * W6-04 — replay saturation fail-closed.
 * A still-valid consumed message MUST NOT become replayable when an attacker
 * floods unique IDs. Live entries are NEVER evicted; saturation rejects new
 * admissions (fail-closed), expiry cleans up legitimately.
 */

function env(i, { ttlMs = 60_000, nowMs = 1_000_000 } = {}) {
 return mesh.envelope.buildEnvelope({
 messageType: "ECHO", sourceNodeId: ids.mint.nodeId(), destinationNodeId: ids.mint.nodeId(),
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: ids.mint.trustGeneration(),
 payload: { i }, ttlMs, nowMs
 });
}

test("W6-04: capacity=2, A+B accepted, C rejected (fail-closed), replay of live A still rejected", () => {
 let now = 1_000_000;
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 2 }, nowMs: () => now });
 const A = env(1, { nowMs: now }), B = env(2, { nowMs: now }), C = env(3, { nowMs: now });
 assert.ok(guard.accept(A).accepted);
 assert.ok(guard.accept(B).accepted);
 // attacker floods a unique C: saturated with LIVE entries -> fail-closed
 assert.throws(() => guard.accept(C), (e) => e.code === "BOUNDS_EXCEEDED");
 // CRITICAL: replay of still-live A must STILL be rejected
 assert.throws(() => guard.accept(A), (e) => e.code === "MESH_REPLAY");
 assert.throws(() => guard.accept(B), (e) => e.code === "MESH_REPLAY");
 // memory bounded
 assert.ok(guard.size() <= 2);
});

test("W6-04: after legitimate expiry, cleanup reclaims and new admissions work", () => {
 let now = 1_000_000;
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 2 }, nowMs: () => now });
 const A = env(1, { nowMs: now, ttlMs: 1000 }), B = env(2, { nowMs: now, ttlMs: 1000 });
 guard.accept(A); guard.accept(B);
 now += 1001; // all entries legitimately expired
 // sweep happens on next accept; expired entries reclaimed
 const fresh = env(3, { nowMs: now });
 assert.ok(guard.accept(fresh).accepted);
 assert.ok(guard.size() <= 2);
 // but an expired A replay is rejected by the ROUTER expiry gate anyway;
 // at guard level the expired entry was swept so accept would succeed —
 // that is safe because the router rejects expired envelopes before the guard.
 assert.ok(!guard.seen(A));
});

test("W6-04: attacker unique-ID flood -> memory bounded, no live eviction", () => {
 let now = 2_000_000;
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 16 }, nowMs: () => now });
 const A = env(0, { nowMs: now, ttlMs: 600_000 }); // long-lived live entry
 guard.accept(A);
 let rejected = 0;
 for (let i = 1; i <= 200; i++) {
 try {
 guard.accept(env(i, { nowMs: now, ttlMs: 600_000 }));
 } catch (e) { rejected++; }
 }
 assert.equal(guard.size(), 16, "bounded");
 assert.equal(rejected, 200 - 15, "flood admissions rejected once saturated");
 // the ORIGINAL live A still cannot be replayed
 assert.throws(() => guard.accept(A), (e) => e.code === "MESH_REPLAY");
});

test("W6-04: delayed valid replay near expiry boundary rejected while entry live", () => {
 let now = 3_000_000;
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 16 }, nowMs: () => now });
 const msg = env(9, { nowMs: now, ttlMs: 3_000 });
 guard.accept(msg);
 now += 2_999; // still within validity
 assert.throws(() => guard.accept(msg), (e) => e.code === "MESH_REPLAY");
 now += 2; // expired
 // swept on next operation — safe because router rejects expired envelopes upstream
 assert.ok(!guard.seen(msg));
});

test("W6-04: trust-generation rotation under saturated cache — revocation not blocked", () => {
 let now = 4_000_000;
 const trust = new mesh.NodeTrust({ nowMs: () => now });
 const guard = new mesh.MeshReplayGuard({ config: { maxEntries: 2 }, nowMs: () => now });
 const victim = ids.mint.nodeId();
 trust.pair({ nodeId: victim, state: "TRUSTED", scopes: ["COMPUTE"] });
 // saturate the guard with unrelated live entries
 guard.accept(env(1, { nowMs: now, ttlMs: 600_000 }));
 guard.accept(env(2, { nowMs: now, ttlMs: 600_000 }));
 // capture the CURRENT generation BEFORE revocation
 const oldGen = trust.snapshot(victim).trustGeneration;
 // revocation is a LOCAL trust-plane operation — the saturated replay cache
 // cannot block it (it never routes through the mesh queue)
 const snap = trust.revoke(victim, { reason: "operator" });
 assert.equal(snap.state, "REVOKED");
 // the rotated generation makes all old messages stale regardless of the cache
 assert.ok(trust.isStaleGeneration(victim, oldGen));
});

test("W6-04: control/revocation messages are not silently dropped by queues under saturation", () => {
 const registry = new mesh.NodeRegistry();
 const trust = new mesh.NodeTrust();
 const router = new mesh.MeshRouter({ trust, registry, replayGuard: new mesh.MeshReplayGuard() });
 const local = ids.mint.nodeId(); const remote = ids.mint.nodeId();
 registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: local, logicalDamarId: ids.mint.logicalDamarId() }) });
 registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: remote, logicalDamarId: ids.mint.logicalDamarId() }) });
 trust.pair({ nodeId: remote, state: "TRUSTED", scopes: ["OBSERVE", "ADMINISTRATIVE_HOST"] });
 const caps = mesh.policy.BOUNDS.meshQueues;
 for (let i = 0; i < caps.maxQueueItems + 5; i++) {
 router.enqueue(mesh.envelope.buildEnvelope({
 messageType: "PRESENCE_ANNOUNCE", sourceNodeId: remote, destinationNodeId: local,
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: trust.snapshot(remote).trustGeneration,
 payload: { i }
 }));
 }
 // CONTROL enqueue must still succeed under telemetry saturation
 const control = mesh.envelope.buildEnvelope({
 messageType: "CONTROL_REVOCATION", sourceNodeId: remote, destinationNodeId: local,
 logicalDamarId: ids.mint.logicalDamarId(), trustGeneration: trust.snapshot(remote).trustGeneration,
 payload: { revoke: true }
 });
 router.enqueue(control);
 const drained = router.drain({ max: caps.maxQueueItems + 10 });
 assert.ok(drained.some(e => e.messageType === "CONTROL_REVOCATION"), "control never dropped");
});
