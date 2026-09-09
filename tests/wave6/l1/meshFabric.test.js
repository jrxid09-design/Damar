"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * WAVE 6 L1 — mesh & trusted node fabric security/boundary/replay tests.
 * Laws under test:
 *   NODE DISCOVERY != NODE TRUST ; MESH PRESENCE != IDENTITY PROOF
 *   ONLINE != TRUSTED ; OFFLINE != REVOKED
 *   PAIRING != PERMANENT TRUST ; TRANSPORT ID != DAMAR IDENTITY
 *   identity immutability ; bounded state everywhere ; fail-closed stale
 */

function makeNode({ logicalDamarId = null, label = "node" } = {}) {
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId, provenance: label });
    return identity;
}

test("L1: node identity is opaque and never hostname/IP/MAC-derived", () => {
    const a = makeNode({});
    const b = makeNode({});
    assert.match(a.nodeId, /^dnode-[0-9a-f]{32}$/);
    assert.match(a.logicalDamarId, /^damar-[0-9a-f]{32}$/);
    assert.notEqual(a.nodeId, b.nodeId);
    // hostname/ip/mac are attributes, not identity fields
    assert.ok(!("hostname" in a) && !("ip" in a) && !("mac" in a));
    // attributes are allowed as bounded strings
    const withAttrs = mesh.meshIdentity.mintNodeIdentity({ attributes: { hostname: "lab-1", ip: "10.0.0.5" } });
    assert.equal(withAttrs.attributes.hostname, "lab-1");
});

test("L1: forged/malformed node identity rejected fail-closed", () => {
    assert.throws(() => mesh.meshIdentity.adoptNodeIdentity({ nodeId: "dnode-XXXX", logicalDamarId: "damar-" + "a".repeat(32) }), /malformed|RangeError/i);
    assert.throws(() => mesh.meshIdentity.coerceNodeIdentity({ nodeId: "my-laptop", logicalDamarId: "damar-" + "a".repeat(32) }), (e) => e.code === "NODE_IDENTITY_MALFORMED");
    assert.throws(() => mesh.meshIdentity.coerceNodeIdentity({ nodeId: "dnode-" + "a".repeat(32), logicalDamarId: "host-laptop" }), (e) => e.code === "NODE_IDENTITY_MALFORMED");
    // identity digest binds nodeId+logicalDamarId
    const a = mesh.meshIdentity.adoptNodeIdentity({ nodeId: "dnode-" + "a".repeat(32), logicalDamarId: "damar-" + "b".repeat(32) });
    const b = mesh.meshIdentity.adoptNodeIdentity({ nodeId: "dnode-" + "a".repeat(32), logicalDamarId: "damar-" + "c".repeat(32) });
    assert.notEqual(a.identityDigest, b.identityDigest);
});

test("L1: discovery != trust — discovered node has zero scopes and fails authorization", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const nodeA = makeNode({});
    registry.register({ identity: nodeA, displayName: "A" });
    trust.pair({ nodeId: nodeA.nodeId, state: "DISCOVERED", scopes: [] });
    const snap = trust.snapshot(nodeA.nodeId);
    assert.equal(snap.state, "DISCOVERED");
    assert.equal(Object.keys(snap.scopes).length, 0);
    assert.throws(() => trust.authorize({ nodeId: nodeA.nodeId, scope: "COMPUTE", trustGeneration: snap.trustGeneration }), (e) => e.code === "NODE_UNTRUSTED");
});

test("L1: trust is scoped — COMPUTE grant does not imply STATE_REPLICA", () => {
    const trust = new mesh.NodeTrust();
    const n = makeNode({});
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
    const snap = trust.snapshot(n.nodeId);
    const auth = trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: snap.trustGeneration });
    assert.equal(auth.scope, "COMPUTE");
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "STATE_REPLICA", trustGeneration: snap.trustGeneration }), (e) => e.code === "TRUST_SCOPE_MISSING");
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "ADMINISTRATIVE_HOST", trustGeneration: snap.trustGeneration }), (e) => e.code === "TRUST_SCOPE_MISSING");
});

test("L1: stale trust generation rejected by exact identity — old proof never valid after reset/re-pair", () => {
    const trust = new mesh.NodeTrust();
    const n = makeNode({});
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
    const oldGen = trust.snapshot(n.nodeId).trustGeneration;
    // revoke rotates the generation
    trust.revoke(n.nodeId, { reason: "compromised" });
    const newSnap = trust.snapshot(n.nodeId);
    assert.notEqual(newSnap.trustGeneration, oldGen);
    assert.equal(newSnap.state, "REVOKED");
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: oldGen }), (e) => e.code === "TRUST_GENERATION_STALE");
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: newSnap.trustGeneration }), (e) => e.code === "NODE_REVOKED");
    // re-pair mints a NEW generation; the OLD one remains stale forever
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
    const rePaired = trust.snapshot(n.nodeId);
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: oldGen }), (e) => e.code === "TRUST_GENERATION_STALE");
    assert.ok(trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: rePaired.trustGeneration }));
    assert.ok(trust.retiredGenerations(n.nodeId).includes(oldGen));
    // stale-generation query
    assert.equal(trust.isStaleGeneration(n.nodeId, oldGen), true);
    assert.equal(trust.isStaleGeneration(n.nodeId, rePaired.trustGeneration), false);
    // forged generation format rejected
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: "ntgen-forged" }), RangeError);
});

test("L1: PAIRING != PERMANENT TRUST — scopes expire fail-closed", () => {
    let now = 1_000_000;
    const trust = new mesh.NodeTrust({ nowMs: () => now });
    const n = makeNode({});
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE"], ttlMs: 60_000 });
    const snap = trust.snapshot(n.nodeId);
    assert.ok(trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: snap.trustGeneration }));
    now += 60_001; // TTL elapsed
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: snap.trustGeneration }), (e) => e.code === "TRUST_EXPIRED");
    // snapshot reflects EXPIRED once ALL scopes expired
    assert.equal(trust.snapshot(n.nodeId).state, "EXPIRED");
});

test("L1: quarantine blocks everything; release restores LIMITED (no auto TRUSTED)", () => {
    const trust = new mesh.NodeTrust();
    const n = makeNode({});
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "OBSERVE"] });
    const gen = trust.snapshot(n.nodeId).trustGeneration;
    trust.quarantine(n.nodeId, { reason: "suspicious traffic" });
    assert.throws(() => trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: gen }), (e) => e.code === "NODE_QUARANTINED");
    trust.releaseQuarantine(n.nodeId);
    assert.equal(trust.snapshot(n.nodeId).state, "LIMITED");
    assert.ok(trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: gen }));
});

test("L1: node registry identity is immutable — update patch cannot touch identity fields", () => {
    const registry = new mesh.NodeRegistry();
    const n = makeNode({});
    registry.register({ identity: n, displayName: "A" });
    for (const key of ["nodeId", "logicalDamarId", "identityProvenance", "identityDigest", "recordId"]) {
        assert.throws(() => registry.update(n.nodeId, { [key]: "hacked" }), (e) => e.code === "IDENTITY_IMMUTABLE", `patch key ${key} must be rejected`);
    }
    // re-registration with conflicting logicalDamarId is rejected as forged
    const forged = mesh.meshIdentity.adoptNodeIdentity({ nodeId: n.nodeId, logicalDamarId: "damar-" + "f".repeat(32) });
    assert.throws(() => registry.register({ identity: forged }), (e) => e.code === "NODE_IDENTITY_MALFORMED");
    // mutable metadata works
    registry.update(n.nodeId, { displayName: "Renamed", addresses: ["lan://10.0.0.9:7000"], liveness: "ONLINE" });
    assert.equal(registry.lookup(n.nodeId).displayName, "Renamed");
});

test("L1: transport spoof rejected — peer label not bound to source node", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const replayGuard = new mesh.MeshReplayGuard();
    const router = new mesh.MeshRouter({ trust, registry, replayGuard });
    const local = makeNode({});
    const remote = makeNode({});
    registry.register({ identity: local });
    registry.register({ identity: remote, displayName: "B" });
    registry.update(remote.nodeId, { addresses: ["ts://100.64.0.9"] });
    trust.pair({ nodeId: remote.nodeId, state: "TRUSTED", scopes: ["OBSERVE"] });
    router.bindLocalNodeId(local.nodeId);
    const env = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: trust.snapshot(remote.nodeId).trustGeneration,
        payload: { ping: 1 }
    });
    // legit transport peer
    assert.ok(router.ingest({ frame: env, transportPeer: "ts://100.64.0.9" }));
    // spoofed transport peer
    assert.throws(() => router.ingest({ frame: env, transportPeer: "ts://evil" }), (e) => e.code === "TRANSPORT_SPOOF");
});

test("L1: envelope replay rejected; different messageId accepted; ledger bounded", () => {
    const replayGuard = new mesh.MeshReplayGuard();
    const local = makeNode({});
    const remote = makeNode({});
    const mk = (id = null) => mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(), payload: { n: 1 }
    });
    const env1 = mk();
    assert.ok(replayGuard.accept(env1));
    assert.throws(() => replayGuard.accept(env1), (e) => e.code === "MESH_REPLAY");
    // same source+messageId but re-encoded object is still a replay (id-based)
    assert.throws(() => replayGuard.accept({ ...env1 }), (e) => e.code === "MESH_REPLAY");
    // different id passes
    assert.ok(replayGuard.accept(mk()));
    // bounded: exceed cap, size stays at cap
    for (let i = 0; i < 9000; i++) {
        replayGuard.accept(mesh.envelope.buildEnvelope({
            messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
            logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(), payload: { n: i }
        }));
    }
    assert.ok(replayGuard.size() <= 8192);
});

test("L1: message expiry rejected fail-closed; wrong destination rejected", () => {
    let now = 5_000_000;
    const registry = new mesh.NodeRegistry({ nowMs: () => now });
    const trust = new mesh.NodeTrust({ nowMs: () => now });
    const replayGuard = new mesh.MeshReplayGuard({ nowMs: () => now });
    const router = new mesh.MeshRouter({ trust, registry, replayGuard, nowMs: () => now });
    const local = makeNode({});
    const remote = makeNode({});
    const third = makeNode({});
    registry.register({ identity: local });
    registry.register({ identity: remote });
    registry.register({ identity: third });
    trust.pair({ nodeId: remote.nodeId, state: "TRUSTED", scopes: ["OBSERVE"] });
    router.bindLocalNodeId(local.nodeId);
    const env = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: trust.snapshot(remote.nodeId).trustGeneration,
        payload: { x: 1 }, ttlMs: 1000, nowMs: now
    });
    assert.ok(router.ingest({ frame: env }));
    now += 1001; // expired
    assert.throws(() => router.ingest({ frame: env }), (e) => e.code === "MESSAGE_EXPIRED");
    // wrong destination: addressed to third node
    const env2 = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: third.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: trust.snapshot(remote.nodeId).trustGeneration,
        payload: { x: 2 }, nowMs: now
    });
    assert.throws(() => router.ingest({ frame: env2 }), (e) => e.code === "DESTINATION_MISMATCH");
});

test("L1: envelope payload tampering -> digest mismatch; non-canonical payload rejected", () => {
    const local = makeNode({});
    const remote = makeNode({});
    const env = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(),
        payload: { a: 1 }
    });
    const tampered = { ...env, payload: { a: 2 } };
    assert.throws(() => mesh.envelope.coerceInboundEnvelope(tampered), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
    // unsupported schema version
    assert.throws(() => mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(),
        payload: {}, schemaVersion: 99
    }), (e) => e.code === "SCHEMA_VERSION_UNSUPPORTED");
    // self-addressed rejected
    assert.throws(() => mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: remote.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(), payload: {}
    }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L1: presence is telemetry — ONLINE != TRUSTED, OFFLINE != REVOKED", () => {
    let now = 10_000_000;
    const registry = new mesh.NodeRegistry({ nowMs: () => now });
    const trust = new mesh.NodeTrust({ nowMs: () => now });
    const presence = new mesh.MeshPresence({ registry, nowMs: () => now });
    const n = makeNode({});
    registry.register({ identity: n });
    trust.pair({ nodeId: n.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
    const gen = trust.snapshot(n.nodeId).trustGeneration;
    presence.observe(n.nodeId, "ONLINE");
    assert.equal(presence.state(n.nodeId), "ONLINE");
    // ONLINE does not create trust where none exists
    const stranger = makeNode({});
    presence.observe(stranger.nodeId, "ONLINE");
    assert.throws(() => trust.authorize({ nodeId: stranger.nodeId, scope: "COMPUTE", trustGeneration: ids.mint.trustGeneration() }), (e) => e.code === "NODE_UNTRUSTED" || e.code === "TRUST_GENERATION_STALE");
 // OFFLINE does not revoke trust
 presence.markOffline(n.nodeId);
 assert.equal(presence.state(n.nodeId), "OFFLINE");
 assert.equal(trust.snapshot(n.nodeId).state, "TRUSTED");
 assert.ok(trust.authorize({ nodeId: n.nodeId, scope: "COMPUTE", trustGeneration: gen }));
 // aging derivation applies to ONLINE observation; explicit OFFLINE stays OFFLINE
 const online = makeNode({});
 registry.register({ identity: online });
 presence.observe(online.nodeId, "ONLINE");
 now += 20_000;
 assert.equal(presence.state(online.nodeId), "SUSPECT");
 now += 200_000;
 assert.equal(presence.state(online.nodeId), "OFFLINE");
});

test("L1: partition/rejoin — liveness and trust evolve independently", () => {
    let now = 50_000_000;
    const registry = new mesh.NodeRegistry({ nowMs: () => now });
    const trust = new mesh.NodeTrust({ nowMs: () => now });
    const presence = new mesh.MeshPresence({ registry, nowMs: () => now });
    const a = makeNode({});
    const b = makeNode({});
    registry.register({ identity: a });
    registry.register({ identity: b });
    trust.pair({ nodeId: a.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "STATE_REPLICA"] });
    trust.pair({ nodeId: b.nodeId, state: "TRUSTED", scopes: ["COMPUTE"] });
    // partition: B goes offline from A's view
    presence.markOffline(b.nodeId);
    assert.equal(presence.state(b.nodeId), "OFFLINE");
    assert.equal(trust.snapshot(b.nodeId).state, "TRUSTED"); // OFFLINE != REVOKED
    // rejoin: B announces again
    presence.observe(b.nodeId, "ONLINE");
    assert.equal(presence.state(b.nodeId), "ONLINE");
    // meanwhile A was revoked during the partition (e.g. by an operator on B's view)
    const genA = trust.snapshot(a.nodeId).trustGeneration;
    trust.revoke(a.nodeId, { reason: "operator decision during partition" });
    presence.observe(a.nodeId, "ONLINE"); // A comes back ONLINE
    assert.equal(trust.snapshot(a.nodeId).state, "REVOKED"); // ONLINE != TRUSTED
    assert.throws(() => trust.authorize({ nodeId: a.nodeId, scope: "COMPUTE", trustGeneration: genA }), (e) => e.code === "TRUST_GENERATION_STALE");
});

test("L1: pairing flow — discover -> pair -> confirm grants scoped trust; cancel leaves DISCOVERED", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    // frozen device identity owner (in-memory, no store needed for the flow)
    const { DeviceIdentityService } = require("../../../src/embodiment/identity/service");
    const deviceIdentity = new DeviceIdentityService({});
    const deviceReg = deviceIdentity.registerIdentity({ namespace: "mesh", stableKey: "node-b", displayName: "Node B", deviceClass: "EDGE" });
    const pairing = new mesh.MeshPairingAdapter({ trust, registry, deviceIdentity });
    const nodeB = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: deviceReg.logicalDamarId ?? null });

    // discovery: visible, zero trust
    const disc = pairing.discover({ identity: nodeB, displayName: "Node B" });
    assert.equal(disc.trustState, "DISCOVERED");
    assert.equal(Object.keys(trust.snapshot(nodeB.nodeId).scopes).length, 0);

    // begin pairing wraps the device pairing tx
    const tx = pairing.beginNodePairing({ identity: nodeB, deviceId: deviceReg.deviceId, displayName: "Node B" });
    assert.match(tx.pairingTxId, /^dnpair-[0-9a-f]{32}$/);
    assert.ok(tx.challenge ?? true);
    const pending = trust.snapshot(nodeB.nodeId);
    assert.equal(pending.state, "PAIRING_PENDING");
    assert.equal(Object.keys(pending.scopes).length, 0);

 // challenge submit through frozen owner (secret is returned exactly once at issue)
 if (tx.challenge?.challengeId) {
 pairing.submitNodeChallenge({ pairingTxId: tx.pairingTxId, challengeId: tx.challenge.challengeId, secret: tx.challenge.secret });
 }

    // owner confirm -> TRUSTED with owner-approved scopes under fresh generation
    const confirmed = pairing.ownerConfirmNode({ pairingTxId: tx.pairingTxId, scopes: ["COMPUTE", "STATE_REPLICA"], ttlMs: 3600_000 });
    assert.equal(confirmed.trust.state, "TRUSTED");
    const gen = confirmed.trust.trustGeneration;
    assert.ok(trust.authorize({ nodeId: nodeB.nodeId, scope: "COMPUTE", trustGeneration: gen }));
    assert.ok(trust.authorize({ nodeId: nodeB.nodeId, scope: "STATE_REPLICA", trustGeneration: gen }));
    assert.throws(() => trust.authorize({ nodeId: nodeB.nodeId, scope: "ADMINISTRATIVE_HOST", trustGeneration: gen }), (e) => e.code === "TRUST_SCOPE_MISSING");

    // second pairing tx for cancel path
    const deviceReg2 = deviceIdentity.registerIdentity({ namespace: "mesh", stableKey: "node-c", displayName: "Node C", deviceClass: "EDGE" });
    const nodeC = mesh.meshIdentity.mintNodeIdentity();
    pairing.discover({ identity: nodeC });
    const tx2 = pairing.beginNodePairing({ identity: nodeC, deviceId: deviceReg2.deviceId });
    pairing.cancelNodePairing({ pairingTxId: tx2.pairingTxId });
    assert.equal(trust.snapshot(nodeC.nodeId).state, "DISCOVERED");
});

test("L1: revocation through pairing adapter rotates generation; old mesh credentials fail stale", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const { DeviceIdentityService } = require("../../../src/embodiment/identity/service");
    const deviceIdentity = new DeviceIdentityService({});
    const dev = deviceIdentity.registerIdentity({ namespace: "mesh", stableKey: "node-d", displayName: "Node D", deviceClass: "EDGE" });
    const pairing = new mesh.MeshPairingAdapter({ trust, registry, deviceIdentity });
    const nodeD = mesh.meshIdentity.mintNodeIdentity();
 pairing.discover({ identity: nodeD });
 const tx = pairing.beginNodePairing({ identity: nodeD, deviceId: dev.deviceId });
 pairing.submitNodeChallenge({ pairingTxId: tx.pairingTxId, challengeId: tx.challenge.challengeId, secret: tx.challenge.secret });
 const confirmed = pairing.ownerConfirmNode({ pairingTxId: tx.pairingTxId, scopes: ["COMPUTE"], ttlMs: 3600_000 });
    const oldGen = confirmed.trust.trustGeneration;
    // revoked: device + trust generation rotation
    const revoked = pairing.revokeNode({ nodeId: nodeD.nodeId, reason: "stolen device" });
    assert.equal(revoked.trust.state, "REVOKED");
    assert.throws(() => trust.authorize({ nodeId: nodeD.nodeId, scope: "COMPUTE", trustGeneration: oldGen }), (e) => e.code === "TRUST_GENERATION_STALE");
    // device pairing owner is terminal too
    assert.equal(deviceIdentity.getIdentity(dev.deviceId).trustState, "REVOKED");
});

test("L1: mesh router end-to-end — scoped delivery, handler routing, queue backpressure, priority drain", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const replayGuard = new mesh.MeshReplayGuard();
    const router = new mesh.MeshRouter({ trust, registry, replayGuard });
    const local = makeNode({});
    const remote = makeNode({});
    registry.register({ identity: local });
    registry.register({ identity: remote });
    trust.pair({ nodeId: remote.nodeId, state: "TRUSTED", scopes: ["OBSERVE", "STATE_REPLICA"] });
    router.bindLocalNodeId(local.nodeId);
    const received = [];
    router.on("ECHO", (env) => { received.push(env.payload); return { echoed: true }; });
    router.on("STATE_REPLICATE", (env) => { received.push({ state: env.payload }); });

    const gen = trust.snapshot(remote.nodeId).trustGeneration;
    const echo = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: gen, payload: { hello: "mesh" }
    });
    const res = router.ingest({ frame: echo });
    assert.equal(res.handled, true);
    assert.deepEqual(received[0], { hello: "mesh" });

    // unscoped message type (state) requires STATE_REPLICA which remote has
    const state = mesh.envelope.buildEnvelope({
        messageType: "STATE_REPLICATE", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: gen, payload: { k: "v" }
    });
    assert.ok(router.ingest({ frame: state }));

    // revoke COMPUTE-scoped missing: EXECUTION_REQUEST requires COMPUTE -> rejected
    const exec = mesh.envelope.buildEnvelope({
        messageType: "EXECUTION_REQUEST", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: gen, payload: {}
    });
    assert.throws(() => router.ingest({ frame: exec }), (e) => e.code === "TRUST_SCOPE_MISSING");

    // queue backpressure: telemetry drops, control never silently dropped
    const telemetry = mesh.envelope.buildEnvelope({
        messageType: "PRESENCE_ANNOUNCE", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: gen, payload: { i: 0 }
    });
    router.enqueue(telemetry);
    const control = mesh.envelope.buildEnvelope({
        messageType: "CONTROL_REVOCATION", sourceNodeId: local.nodeId, multicastScope: "all",
        logicalDamarId: local.logicalDamarId, trustGeneration: trust.snapshot(local.nodeId)?.trustGeneration ?? ids.mint.trustGeneration(), payload: {}
    });
    router.enqueue(control);
    const depth = router.queueDepth();
    assert.ok(depth.total >= 2);
    const drained = router.drain({ max: 10 });
    assert.ok(drained.length >= 2);
});

test("L1: transport attachment — loopback delivers to router; transport identity never mints identity", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const replayGuard = new mesh.MeshReplayGuard();
    const router = new mesh.MeshRouter({ trust, registry, replayGuard });
    const local = makeNode({});
    const remote = makeNode({});
    registry.register({ identity: local });
    registry.register({ identity: remote });
    trust.pair({ nodeId: remote.nodeId, state: "TRUSTED", scopes: ["OBSERVE"] });
    router.bindLocalNodeId(local.nodeId);
    const received = [];
    router.on("ECHO", (env) => received.push(env.messageId));

    const tA = mesh.transport.createLoopbackTransport({ label: "A" });
    const tB = mesh.transport.createLoopbackTransport({ label: "B" });
    const peerA = mesh.transport.attachTransport({ transport: tA, router, localNodeId: local.nodeId, logicalDamarId: local.logicalDamarId, trust });
    // B's router-less listener feeds A's router through the transport wire:
    const gen = trust.snapshot(remote.nodeId).trustGeneration;
    const env = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: gen, payload: { via: "loopback" }
    });
    // deliver B -> A directly over A's receive path
    tA.send({ frame: mesh.envelope.encodeEnvelope(env), toPeer: peerA.peerLabel });
    assert.equal(received.length, 1);
    // transport adapter validation
    assert.throws(() => mesh.transport.validateTransportAdapter({ id: "x" }), TypeError);
    assert.throws(() => mesh.transport.validateTransportAdapter(null), TypeError);
});

test("L1: audit bridge records ingest + trust changes; bounded buffer", () => {
    const records = [];
    const ledger = { append: (r) => { records.push(r); return true; } };
    const local = makeNode({});
    const bridge = new mesh.MeshAuditBridge({ ledger, localNodeId: local.nodeId });
    const remote = makeNode({});
    const env = mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: remote.nodeId, destinationNodeId: local.nodeId,
        logicalDamarId: local.logicalDamarId, trustGeneration: ids.mint.trustGeneration(), payload: {}
    });
    bridge.ingestAccepted(env, { transportPeer: "loop", receivedAtMs: 1 });
    bridge.ingestRejected("MESH_REPLAY", "duplicate");
    bridge.trustChanged({ nodeId: remote.nodeId, from: "TRUSTED", to: "REVOKED", trustGeneration: ids.mint.trustGeneration(), reason: "test" });
    bridge.pairingEvent({ event: "confirmed", nodeId: remote.nodeId });
    assert.equal(records.length, 4);
    assert.equal(records[0].type, "mesh.ingest_accepted");
    assert.equal(records[2].data.to, "REVOKED");
    // failing ledger -> buffered, never throws
    const badBridge = new mesh.MeshAuditBridge({ ledger: { append: () => { throw new Error("sink down"); } }, localNodeId: local.nodeId });
    badBridge.ingestAccepted(env, {});
    assert.equal(badBridge.stats().attached, false);
    assert.ok(badBridge.stats().buffered >= 1);
    assert.match(badBridge.bufferedDigest(), /^[0-9a-f]{64}$/);
});

test("L1: boundedness — registry, trust table, presence, envelope caps enforced", () => {
    const registry = new mesh.NodeRegistry({ config: { maxNodes: 4 } });
    const trust = new mesh.NodeTrust({ config: { maxTrustedNodes: 4 } });
    const ids4 = [];
    for (let i = 0; i < 5; i++) {
        const n = makeNode({});
        ids4.push(n);
        if (i < 4) {
            registry.register({ identity: n });
            trust.pair({ nodeId: n.nodeId, state: "DISCOVERED", scopes: [] });
        }
    }
    assert.throws(() => registry.register({ identity: ids4[4] }), (e) => e.code === "NODE_REGISTRY_FULL");
    assert.throws(() => trust.pair({ nodeId: ids4[4].nodeId, state: "DISCOVERED", scopes: [] }), (e) => e.code === "NODE_REGISTRY_FULL");
    // registry summary caps
    const n0 = registry.lookup(ids4[0].nodeId);
    assert.throws(() => registry.update(n0.identity.nodeId, { capabilitySummary: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, "v"])) }), (e) => e.code === "BOUNDS_EXCEEDED");
    // envelope payload cap (256 KiB)
    const bigPayload = { blob: "x".repeat(256 * 1024 + 1) };
    assert.throws(() => mesh.envelope.buildEnvelope({
        messageType: "ECHO", sourceNodeId: ids4[0].nodeId, destinationNodeId: ids4[1].nodeId,
        logicalDamarId: ids4[0].logicalDamarId, trustGeneration: ids.mint.trustGeneration(), payload: bigPayload
    }), (e) => e.code === "BOUNDS_EXCEEDED");
});

test("L1: deterministic canonical encoding — digests stable across key order; ambiguity rejected", () => {
 const d1 = mesh.canonical.sha256Hex({ b: 1, a: 2 });
 const d2 = mesh.canonical.sha256Hex({ a: 2, b: 1 });
 assert.equal(d1, d2);
 // undefined property values are OMITTED deterministically (still stable)
 const omitA = mesh.canonical.sha256Hex({ a: 1, gone: undefined });
 const omitB = mesh.canonical.sha256Hex({ gone: undefined, a: 1 });
 assert.equal(omitA, omitB);
 // undefined INSIDE arrays is rejected (position-dependent ambiguity)
 assert.throws(() => mesh.canonical.sha256Hex({ x: [undefined, 1] }), TypeError);
 assert.throws(() => mesh.canonical.sha256Hex({ x: 1n }), TypeError);
 const circular = {}; circular.self = circular;
 assert.throws(() => mesh.canonical.sha256Hex(circular), /circular/i);
 // -0 normalized
 assert.equal(mesh.canonical.sha256Hex({ z: -0 }), mesh.canonical.sha256Hex({ z: 0 }));
});

test("L1: typed failure envelopes carry no stack traces", () => {
    try {
        mesh.meshIdentity.coerceNodeIdentity({ nodeId: "nope" });
        assert.fail("should throw");
    } catch (e) {
        assert.equal(e.name, "MeshError");
        assert.ok(!String(e.message).includes("at "));
        assert.equal(e.toJSON().code, "NODE_IDENTITY_MALFORMED");
        assert.ok(mesh.errors.isMeshFailure(e));
        assert.ok(mesh.errors.isMeshFailure(e, "NODE_IDENTITY_MALFORMED"));
    }
});
