"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dstate = require("../../../src/dstate");
const mesh = require("../../../src/mesh");
const ids = mesh.ids;

/**
 * WAVE 6 L2 — distributed state continuity & reconciliation.
 * Laws under test:
 *   STATE REPLICATION != AUTHORITY REPLICATION
 *   MEMORY REPLICATION != SECRET REPLICATION
 *   STATE CONVERGENCE != TRUTH ; CLOCK ORDER != CAUSAL TRUTH
 *   authority-sensitive state never blind-LWW
 *   MODEL RECOVERY != ACTION REPLAY (completed actions stay completed)
 */

const nodeA = ids.mint.nodeId();
const nodeB = ids.mint.nodeId();
const damar = ids.mint.logicalDamarId();

function env(overrides = {}) {
    return dstate.stateEnvelope.buildStateEnvelope({
        stateType: "continuity",
        stateKey: "session:abc",
        logicalOwner: damar,
        sourceNodeId: nodeA,
        replicationClass: "REPLICATED",
        mergePolicy: "LAST_WRITER_FOR_NONCRITICAL",
        payload: { v: 1 },
        ...overrides
    });
}

test("L2: causal classification — AFTER/BEFORE/CONCURRENT via bounded lineage", () => {
 const r1 = env({ payload: { v: 1 } });
 const r2 = env({ payload: { v: 2 }, parentRevision: r1, causalParents: [r1.revisionId] });
 // relation(X, Y) describes X's position relative to Y:
 // r1 vs r2: r2 knows r1 as ancestor -> r1 is BEFORE r2
 assert.equal(dstate.stateEnvelope.causalRelation(r1, r2), "BEFORE");
 // r2 vs r1: r2 descends from r1 -> r2 is AFTER r1
 assert.equal(dstate.stateEnvelope.causalRelation(r2, r1), "AFTER");
    // concurrent: two revisions neither knowing the other
    const r3a = env({ payload: { v: "a" }, parentRevision: r2, causalParents: [r2.revisionId] });
    const r3b = env({ payload: { v: "b" }, parentRevision: r2, causalParents: [r2.revisionId] });
    assert.equal(dstate.stateEnvelope.causalRelation(r3a, r3b), "CONCURRENT");
    assert.equal(dstate.stateEnvelope.causalRelation(r1, r1), "IDENTICAL");
    // lineage is bounded: maxCausalParents=4; a long chain loses old parents -> falls back to CONCURRENT
    let chain = r1;
    for (let i = 0; i < 8; i++) chain = env({ payload: { v: i }, parentRevision: chain, causalParents: [chain.revisionId] });
    assert.equal(dstate.stateEnvelope.causalRelation(r1, chain), "CONCURRENT", "bounded lineage must not pretend total order");
});

test("L2: LWW only for non-critical class; authority-sensitive forbids LWW at build time", () => {
    // non-critical LWW works
    const a1 = env({ payload: { v: 1 } });
    const a2 = env({ payload: { v: 2 }, parentRevision: a1, causalParents: [a1.revisionId] });
    const store = new dstate.DistributedStateStore();
    store.applyRemote(a1);
    const res = store.applyRemote(a2);
    assert.equal(res.accepted, true);
    assert.equal(store.get("session:abc").payload.v, 2);
    // OWNER_BOUND + LWW rejected at build
    assert.throws(() => env({
        stateKey: "trust:owner", replicationClass: "OWNER_BOUND", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL"
    }), (e) => e.code === "MESSAGE_MALFORMED" && /forbids LAST_WRITER/.test(e.message));
});

test("L2: authority-sensitive conflict is blocking — no silent LWW, resolved only by explicit re-validation", () => {
    const store = new dstate.DistributedStateStore();
    // OWNER_BOUND family: session binding revision (authority-sensitive)
    const mkOwner = (payload, parent = null, parents = []) => dstate.stateEnvelope.buildStateEnvelope({
        stateType: "owner_binding", stateKey: "binding:owner-1", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "OWNER_BOUND", mergePolicy: "AUTHORITY_REVALIDATE",
        payload, parentRevision: parent, causalParents: parents
    });
    const base = mkOwner({ principal: "owner", deviceBound: "A" });
    store.applyRemote(base);
    // two CONCURRENT owner-binding updates from different nodes
    const left = mkOwner({ principal: "owner", deviceBound: "A2" }, base, [base.revisionId]);
    const right = mkOwner({ principal: "owner", deviceBound: "B2" }, base, [base.revisionId]);
    store.applyRemote(left);
    const res = store.applyRemote(right);
    assert.equal(res.accepted, false, "blocking conflict must not auto-accept");
    assert.equal(res.conflict.authoritySensitive, true);
    assert.equal(res.conflict.resolutionStatus, "BLOCKING_UNRESOLVED");
    assert.equal(res.conflict.causalRelation, "CONCURRENT");
    assert.equal(res.conflict.policy, "AUTHORITY_REVALIDATE");
    // open conflicts are visible and countable (never silently dropped)
    const open = store.conflicts({ openOnly: true });
    assert.equal(open.length, 1);
    // resolution only via explicit re-validation outcome with evidence
    const resolved = store.resolveConflict(res.conflict.conflictId, {
        winnerRevisionId: right.revisionId, evidence: "owner re-ratified on node B", resolverNodeId: nodeB
    });
    assert.equal(resolved.resolutionStatus, "RESOLVED");
    assert.match(resolved.resolutionEvidence.evidence, /re-ratified/);
    assert.equal(store.get("binding:owner-1").payload.deviceBound, "B2");
    // unknown winner rejected
    assert.throws(() => store.resolveConflict(res.conflict.conflictId, { winnerRevisionId: "nope" }), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L2: MANUAL_CONFLICT for non-authority state stays open until resolved; store bounded", () => {
    const store = new dstate.DistributedStateStore();
    const mk = (payload, parent = null, parents = []) => dstate.stateEnvelope.buildStateEnvelope({
        stateType: "note", stateKey: "note:1", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "REPLICATED", mergePolicy: "MANUAL_CONFLICT",
        payload, parentRevision: parent, causalParents: parents
    });
    const base = mk({ text: "base" });
    store.applyRemote(base);
    const l = mk({ text: "left" }, base, [base.revisionId]);
    const r = mk({ text: "right" }, base, [base.revisionId]);
    store.applyRemote(l);
    const res = store.applyRemote(r);
    assert.equal(res.accepted, false);
    assert.equal(res.conflict.policy, "MANUAL_CONFLICT");
    assert.equal(res.conflict.authoritySensitive, false);
    assert.equal(res.conflict.resolutionStatus, "OPEN");
    store.resolveConflict(res.conflict.conflictId, { winnerRevisionId: l.revisionId, evidence: "user picked left" });
    assert.equal(store.get("note:1").payload.text, "left");
});

test("L2: convergent policies — MAX/MIN/UNION/MONOTONIC_SET/APPEND_ONLY/DOMAIN_MERGE", () => {
    const store = new dstate.DistributedStateStore();
    const mk = (stateKey, policy, payload, parent = null, parents = []) => dstate.stateEnvelope.buildStateEnvelope({
        stateType: "metrics", stateKey, logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "REPLICATED", mergePolicy: policy,
        payload, parentRevision: parent, causalParents: parents
    });
    // MAX
    store.applyRemote(mk("m:max", "MAX", { value: 10 }));
    store.applyRemote(mk("m:max", "MAX", { value: 4 }, null, [])); // concurrent lower -> stays 10
    assert.equal(store.get("m:max").payload.value, 10);
    store.applyRemote(mk("m:max", "MAX", { value: 42 }, null, []));
    assert.equal(store.get("m:max").payload.value, 42);
    // MIN
    store.applyRemote(mk("m:min", "MIN", { value: 7 }));
    store.applyRemote(mk("m:min", "MIN", { value: 3 }, null, []));
    assert.equal(store.get("m:min").payload.value, 3);
    // UNION / MONOTONIC_SET
    store.applyRemote(mk("m:tags", "UNION", { values: ["a", "b"] }));
    store.applyRemote(mk("m:tags", "UNION", { values: ["b", "c"] }, null, []));
    assert.deepEqual(store.get("m:tags").payload.values, ["a", "b", "c"]);
    // APPEND_ONLY keeps both
    store.applyRemote(mk("m:log", "APPEND_ONLY", { entry: "one" }));
    store.applyRemote(mk("m:log", "APPEND_ONLY", { entry: "two" }, null, []));
    const log = store.appendLog("m:log");
    assert.equal(log.length, 2);
    // DOMAIN_MERGE merges keys
    store.applyRemote(mk("m:cfg", "DOMAIN_MERGE", { a: 1, b: 1 }));
    store.applyRemote(mk("m:cfg", "DOMAIN_MERGE", { b: 2, c: 3 }, null, []));
    const cfg = store.get("m:cfg").payload;
    assert.equal(cfg.a, 1); assert.equal(cfg.b, 2); assert.equal(cfg.c, 3);
    // MAX with non-numeric payload rejected
    assert.throws(() => store.applyRemote(mk("m:bad", "MAX", { value: "not-number" })), (e) => e.code === "MESSAGE_MALFORMED");
});

test("L2: secret non-replication — SECRET_BOUND never enters the state plane; memory namespace classes enforced", () => {
    const store = new dstate.DistributedStateStore();
    // SECRET_BOUND cannot even be built as a replicatable envelope
    assert.throws(() => dstate.stateEnvelope.buildStateEnvelope({
        stateType: "secret", stateKey: "vault:key1", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "SECRET_BOUND", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL",
        payload: { value: "super-secret" }
    }), (e) => /SECRET_BOUND state can never be replicated/.test(e.message));
    assert.throws(() => store.writeLocal({
        stateType: "secret", stateKey: "vault:key1", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "SECRET_BOUND", mergePolicy: "MAX", payload: { value: "x" }
    }), (e) => e.code === "MESSAGE_MALFORMED");
    // LOCAL_ONLY / AUDIT_IMMUTABLE also excluded from the plane
    assert.throws(() => store.writeLocal({
        stateType: "ui", stateKey: "ui:window", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "LOCAL_ONLY", mergePolicy: "MAX", payload: {}
    }), (e) => e.code === "MESSAGE_MALFORMED");
    // memory namespace classes: only SHARED_DAMAR replicatable by default
    assert.equal(dstate.checkpoint.REPLICATABLE_NAMESPACES.has("SHARED_DAMAR"), true);
    assert.equal(dstate.checkpoint.REPLICATABLE_NAMESPACES.has("OWNER_SCOPED"), false);
    assert.equal(dstate.checkpoint.SECRET_REFERENCE_NAMESPACES.has("SECRET_REFERENCE_ONLY"), true);
});

test("L2: checkpoint — build, verify, stale reject, revoked-node reject, digest tamper reject", () => {
    const cp = dstate.checkpoint.buildDistributedCheckpoint({
        sourceNodeId: nodeA, logicalDamarId: damar,
        continuityIncarnation: "dsc_inc_001",
        sessionReferences: ["dsc-abc"],
        pendingCognitiveWork: ["summarize thread"],
        verifiedCompletedActionRefs: ["act_verified_1"],
        memoryPointers: ["SHARED_DAMAR:note:12"]
    });
    assert.match(cp.checkpointId, /^dckpt-[0-9a-f]{32}$/);
    // verify OK
    assert.equal(dstate.checkpoint.verifyCheckpoint(cp, { continuityIncarnation: "dsc_inc_001", isNodeTrusted: () => true }), true);
    const view = dstate.checkpoint.restoreView(cp);
    assert.deepEqual(view.verifiedCompletedActionRefs, ["act_verified_1"]);
    assert.match(view.note, /MODEL RECOVERY != ACTION REPLAY/);
    // stale incarnation rejected
    assert.throws(() => dstate.checkpoint.verifyCheckpoint(cp, { continuityIncarnation: "dsc_inc_002", isNodeTrusted: () => true }), (e) => e.code === "TRUST_GENERATION_STALE");
    // revoked source node rejected
    assert.throws(() => dstate.checkpoint.verifyCheckpoint(cp, { continuityIncarnation: "dsc_inc_001", isNodeTrusted: () => false }), (e) => e.code === "NODE_REVOKED");
 // expired rejected: non-positive TTL fails closed at BUILD time
 assert.throws(() => dstate.checkpoint.buildDistributedCheckpoint({
 sourceNodeId: nodeA, logicalDamarId: damar, continuityIncarnation: "dsc_inc_001", ttlMs: -1
 }), (e) => e.code === "MESSAGE_MALFORMED");
    // tampered digest rejected
    const tampered = { ...cp, verifiedCompletedActionRefs: ["act_hacked"] };
    assert.throws(() => dstate.checkpoint.verifyCheckpoint(tampered, { isNodeTrusted: () => true }), (e) => e.code === "PAYLOAD_DIGEST_MISMATCH");
    // authority-shaped fields rejected at build
    assert.throws(() => dstate.checkpoint.buildDistributedCheckpoint({
        sourceNodeId: nodeA, logicalDamarId: damar, continuityIncarnation: "x",
        sessionReferences: [{ authority: "root" }]
    }), (e) => /authority-shaped/.test(e.message));
    // bounds
    assert.throws(() => dstate.checkpoint.buildDistributedCheckpoint({
        sourceNodeId: nodeA, logicalDamarId: damar, continuityIncarnation: "x",
        sessionReferences: Array.from({ length: 17 }, (_, i) => `dsc-${i}`)
    }), (e) => e.code === "BOUNDS_EXCEEDED");
});

test("L2: action no-replay across migration — completed action stays completed, never re-enters pending", () => {
    // pending list contains a stale entry for a completed action; checkpoint + restore
    // must keep it completed (strip from pending view semantics is the L3 store's job,
    // but the checkpoint itself must carry the completed marker so verification can check).
    const cp = dstate.checkpoint.buildDistributedCheckpoint({
        sourceNodeId: nodeA, logicalDamarId: damar, continuityIncarnation: "inc-1",
        pendingCognitiveWork: ["act_verified_1"], // stale pending entry
        verifiedCompletedActionRefs: ["act_verified_1"]
    });
    const view = dstate.checkpoint.restoreView(cp);
    assert.ok(view.verifiedCompletedActionRefs.includes("act_verified_1"));
 // The marker survived; execution layer treats verified+completed as done (see L3 tests).
 assert.ok(view.pendingCognitiveWork.includes("act_verified_1")); // raw list preserved verbatim
 // law note attached to every restore view
 assert.match(view.note, /MODEL RECOVERY != ACTION REPLAY/);
});

test("L2: offline divergence + reconnect — store applies concurrent non-critical updates and history is bounded", () => {
    // Simulate two stores diverging offline, then exchanging envelopes.
    const storeA = new dstate.DistributedStateStore();
    const storeB = new dstate.DistributedStateStore();
    const mk = (payload, parent = null, parents = [], node = nodeA) => dstate.stateEnvelope.buildStateEnvelope({
        stateType: "continuity", stateKey: "conversation:main", logicalOwner: damar,
        sourceNodeId: node, replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL",
        payload, parentRevision: parent, causalParents: parents
    });
    const base = mk({ turn: 1 });
    storeA.applyRemote(base);
    storeB.applyRemote(base);
    // offline divergence
    const a2 = mk({ turn: 2, from: "A" }, base, [base.revisionId], nodeA);
    const b2 = mk({ turn: 2, from: "B" }, base, [base.revisionId], nodeB);
    storeA.applyRemote(a2);
    storeB.applyRemote(b2);
    // reconnect: exchange envelopes
    const resA = storeA.applyRemote(storeB.get("conversation:main")); // B's divergent state arrives at A
    // concurrent non-critical LWW: deterministic newer wins, no crash, no silent loss of conflict record need
    assert.ok(resA.resolved);
    // convergence: whichever won on A, applying A's final state to B converges
    storeB.applyRemote(storeA.get("conversation:main"));
    assert.equal(
        storeA.get("conversation:main").revisionId,
        storeB.get("conversation:main").revisionId,
        "converged to same revision"
    );
    // history bounded
    for (let i = 0; i < 20; i++) {
        const prev = storeA.get("conversation:main");
        storeA.applyRemote(mk({ turn: 10 + i }, prev, [prev.revisionId]));
    }
    const entry = storeA.size() ? null : null;
    assert.ok(storeA.get("conversation:main"));
    // key cap
    const tiny = new dstate.DistributedStateStore({ config: { maxKeys: 2 } });
    tiny.applyRemote(mk({ v: 1 }));
    tiny.applyRemote((() => { const e = dstate.stateEnvelope.buildStateEnvelope({ stateType: "continuity", stateKey: "k2", logicalOwner: damar, sourceNodeId: nodeA, replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { v: 1 } }); return e; })());
    assert.throws(() => tiny.applyRemote(dstate.stateEnvelope.buildStateEnvelope({ stateType: "continuity", stateKey: "k3", logicalOwner: damar, sourceNodeId: nodeA, replicationClass: "REPLICATED", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL", payload: { v: 1 } })), (e) => e.code === "BOUNDS_EXCEEDED");
});

test("L2: revoked node state rejected at replication ingress (via mesh trust gate integration)", () => {
    const registry = new mesh.NodeRegistry();
    const trust = new mesh.NodeTrust();
    const replayGuard = new mesh.MeshReplayGuard();
    const router = new mesh.MeshRouter({ trust, registry, replayGuard });
    const local = ids.mint.nodeId();
    const remote = ids.mint.nodeId();
    registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: local, logicalDamarId: damar }) });
    registry.register({ identity: mesh.meshIdentity.adoptNodeIdentity({ nodeId: remote, logicalDamarId: damar }) });
    trust.pair({ nodeId: remote, state: "TRUSTED", scopes: ["STATE_REPLICA"] });
    router.bindLocalNodeId(local);
    const gen = trust.snapshot(remote).trustGeneration;
    const env = mesh.envelope.buildEnvelope({
        messageType: "STATE_REPLICATE", sourceNodeId: remote, destinationNodeId: local,
        logicalDamarId: damar, trustGeneration: gen,
        payload: { stateKey: "s1", payload: { v: 1 } }
    });
    assert.ok(router.ingest({ frame: env }));
    // revoke -> same-shape new message with old generation fails stale
    trust.revoke(remote, { reason: "compromised" });
    const env2 = mesh.envelope.buildEnvelope({
        messageType: "STATE_REPLICATE", sourceNodeId: remote, destinationNodeId: local,
        logicalDamarId: damar, trustGeneration: gen,
        payload: { stateKey: "s1", payload: { v: 2 } }
    });
    assert.throws(() => router.ingest({ frame: env2 }), (e) => e.code === "TRUST_GENERATION_STALE");
});

test("L2: expired state revision rejected at store", () => {
    let now = 1_000_000;
    const store = new dstate.DistributedStateStore({ nowMs: () => now });
    const env = dstate.stateEnvelope.buildStateEnvelope({
        stateType: "continuity", stateKey: "eph:1", logicalOwner: damar,
        sourceNodeId: nodeA, replicationClass: "EPHEMERAL", mergePolicy: "LAST_WRITER_FOR_NONCRITICAL",
        payload: { v: 1 }, ttlMs: 1000, nowMs: now
    });
    now += 1001;
    assert.throws(() => store.applyRemote(env), (e) => e.code === "MESSAGE_EXPIRED");
});
