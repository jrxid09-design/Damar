const test = require("node:test");
const assert = require("node:assert");

/**
 * HOSTILE TESTS (I§9) — forged identity/trust, prototype pollution,
 * challenge theft, rename collisions, oversized inputs, replay.
 * Expected: no Authority creation, no sensor access, no actuation, no
 * identity corruption. Everything fails closed with stable codes.
 */

const emb = require("../../src/embodiment");
const { createIdentityService } = emb;
const { digestOf } = require("../../src/embodiment/core/util");

const T0 = 1_000_000;

function makeSvc(config = {}) {
    return createIdentityService({
        clock: emb.manualClock(T0),
        config: { challengeTtlMs: 60_000, pairingTtlMs: 300_000, ...config }
    });
}

function fullPair(s, key) {
    const { deviceId } = s.registerIdentity({ namespace: "h", stableKey: key });
    const p = s.beginPairing(deviceId);
    s.submitChallenge({ pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret });
    const res = s.ownerConfirm(p.pairingId);
    return { deviceId, pairingId: p.pairingId, bindingSecret: res.bindingCredential.secret };
}

test("H-1: forged deviceId — operations on unknown/colliding ids rejected", () => {
    const s = makeSvc();
    for (const op of [
        () => s.beginPairing("h:ghost"),
        () => s.revoke("h:ghost"),
        () => s.setTrust("h:ghost", "TRUSTED"),
        () => s.openSession({ deviceId: "h:ghost", bindingSecret: "x" }),
        () => s.rename("h:ghost", "Ghost")
    ]) {
        assert.throws(op, e => e.code === "PID_UNKNOWN_DEVICE" || e.code === "PID_SESSION_FORGED");
    }
});

test("H-2: forged trusted:true / owner:true in payloads cannot mutate trust", () => {
    const s = makeSvc();
    const { deviceId } = s.registerIdentity({ namespace: "h", stableKey: "forge" });

    // hostile caller tries to smuggle privilege fields through any channel
    s.observeCapabilities(deviceId, ["camera"]);
    s.rename(deviceId, "Innocent");
    s.setPresence(deviceId, "ONLINE");
    s.setBodyRelation(deviceId, "COMPANION");

    const v = s.getIdentity(deviceId);
    assert.equal(v.trustState, "UNKNOWN");     // nothing above grants trust
    assert.equal(v.pairingState, "UNPAIRED");

    // even a completed pairing yields PAIRED, never TRUSTED, without an
    // explicit owner setTrust call:
    const q = fullPair(s, "forge2");
    assert.equal(s.getIdentity(q.deviceId).trustState, "PAIRED");
});

test("H-3: forged capability list — non-vocabulary entries dropped, no grant semantics", () => {
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "h", stableKey: "caps" }).deviceId;
    s.observeCapabilities(d, [
        "camera", "authority.grant.all", "sudo", "__proto__.polluted",
        { malicious: true }, null, undefined
    ]);
    const caps = s.getIdentity(d).observedCapabilities;
    assert.deepEqual(caps, ["camera"]);
});

test("H-4: prototype pollution attempts fail closed everywhere", () => {
    const s = makeSvc();
    assert.throws(() => s.registerIdentity({
        namespace: "h", stableKey: "pp",
        metadata: JSON.parse('{"__proto__":{"admin":true}}')
    }), e => e.code === "PID_INVALID_METADATA");
    assert.throws(() => s.registerIdentity({
        namespace: "h", stableKey: "pp2",
        metadata: JSON.parse('{"constructor":{"prototype":1}}')
    }), e => e.code === "PID_INVALID_METADATA");

    // global object untouched
    assert.notEqual(({}).admin, true);
    assert.equal(({}).polluted, undefined);
});

test("H-5: oversized metadata / display name rejected (not truncated silently)", () => {
    const s = makeSvc();
    assert.throws(() => s.registerIdentity({
        namespace: "h", stableKey: "big", displayName: "x".repeat(121)
    }), e => e.code === "PID_DISPLAY_NAME_TOO_LONG");
    assert.doesNotThrow(() => s.registerIdentity({
        namespace: "h", stableKey: "ok", displayName: "x".repeat(120)
    }));
    const big = {};
    for (let i = 0; i < 40; i++) big[`k${i}`] = i;   // > 32 fields
    assert.throws(() => s.registerIdentity({
        namespace: "h", stableKey: "bigmeta", metadata: big
    }), e => e.code === "PID_METADATA_TOO_LARGE");
});

test("H-6: challenge theft — stolen secret is useless after use/expiry/wrong tx", () => {
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "h", stableKey: "theft" }).deviceId;
    const p = s.beginPairing(d);
    const { challengeId, secret } = p.challenge;

    // attacker consumes it first
    s.submitChallenge({
        pairingId: p.pairingId, challengeId, secret,
        instancePublicKey: "ATTACKER-KEY"
    });
    // legitimate device now locked out of THIS tx — ambiguity exposed by
    // failure, never silent double-bind:
    assert.throws(() => s.submitChallenge({
        pairingId: p.pairingId, challengeId, secret
    }), e => e.code === "PID_CHALLENGE_NOT_FOUND"
        || e.code === "PID_INVALID_STATE");
    s.cancelPairing(p.pairingId);

    // brute force bounded
    const s2 = createIdentityService({
        clock: emb.manualClock(T0),
        config: { maxChallengeAttempts: 3 }
    });
    const d2 = s2.registerIdentity({ namespace: "h", stableKey: "bf" }).deviceId;
    const p2 = s2.beginPairing(d2);
    for (let i = 0; i < 2; i++) {
        assert.throws(() => s2.challenges.consume({
            challengeId: p2.challenge.challengeId, secret: "wrong",
            pairingId: p2.pairingId, deviceId: d2
        }), e => e.code === "PID_CHALLENGE_MISMATCH");
    }
    assert.throws(() => s2.challenges.consume({
        challengeId: p2.challenge.challengeId, secret: "wrong",
        pairingId: p2.pairingId, deviceId: d2
    }), e => e.code === "PID_CHALLENGE_EXHAUSTED");
    // correct secret no longer works — entry reclaimed
    assert.throws(() => s2.challenges.consume({
        challengeId: p2.challenge.challengeId, secret: p2.challenge.secret,
        pairingId: p2.pairingId, deviceId: d2
    }), e => e.code === "PID_CHALLENGE_NOT_FOUND");
});

test("H-7: revoked device reconnecting cannot silently restore pairing", () => {
    const s = makeSvc();
    const q = fullPair(s, "recon");
    s.openSession({ deviceId: q.deviceId, bindingSecret: q.bindingSecret });
    s.revoke(q.deviceId);

    // reconnect attempts with old credentials
    assert.throws(() => s.openSession({ deviceId: q.deviceId, bindingSecret: q.bindingSecret }),
        e => e.code === "PID_SESSION_FORGED");
    assert.throws(() => s.beginPairing(q.deviceId), e => e.code === "PID_REVOKED");
    assert.equal(s.getIdentity(q.deviceId).pairingState, "REVOKED");
});

test("H-8: session/device identity collision — forged session claiming real deviceId never binds", () => {
    const s = makeSvc();
    const q = fullPair(s, "real");
    const before = s.stats().forgedSessionAttempts;
    for (const forgery of [
        { deviceId: q.deviceId },                                        // no credential
        { deviceId: q.deviceId, bindingSecret: "" },
        { deviceId: q.deviceId, bindingSecret: null },
        { deviceId: q.deviceId.toUpperCase() }                            // case games -> unknown device
    ]) {
        assert.throws(() => s.openSession(forgery),
            e => e.code === "PID_SESSION_FORGED" || e.code === "PID_UNKNOWN_DEVICE");
    }
    assert.ok(s.stats().forgedSessionAttempts >= before + 3);

    // the REAL binding still works and identity is unchanged
    const sess = s.openSession({ deviceId: q.deviceId, bindingSecret: q.bindingSecret });
    assert.equal(sess.deviceId, q.deviceId);
});

test("H-9: rename collision — same display names never merge identities", () => {
    const s = makeSvc();
    const a = s.registerIdentity({ namespace: "h", stableKey: "n1", displayName: "Phone" });
    const b = s.registerIdentity({ namespace: "h", stableKey: "n2", displayName: "Phone" });
    s.rename(a.deviceId, b.identity.displayName);
    assert.notEqual(a.deviceId, b.deviceId);
    const sa = s.serialize().devices.find(x => x.deviceId === a.deviceId);
    const sb = s.serialize().devices.find(x => x.deviceId === b.deviceId);
    assert.notEqual(sa.rowDigest, sb.rowDigest);   // distinct canonical rows
    void digestOf;
});

test("H-10: restore input is hostile — garbage shapes rejected wholesale", () => {
    for (const bad of [null, undefined, 42, "[]", {}, { version: 2 }, { version: "1" }]) {
        assert.throws(() => emb.DeviceIdentityService.restore(bad, {}),
            e => e.code === "PID_INVALID_SERIALIZATION");
    }
    // row that is not an object
    assert.throws(() => emb.DeviceIdentityService.restore(
        { version: 1, devices: [null], transactions: [] }, {}),
        e => e.details.some(x => /PID_INVALID_ROW|PID_FIELD_MISSING/.test(x)));
});
