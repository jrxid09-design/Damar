const test = require("node:test");
const assert = require("node:assert");

/**
 * Pairing lifecycle + challenge semantics (I§6).
 * Covers every mandated failure case deterministically (manual clock).
 */

const emb = require("../../src/embodiment");
const { createIdentityService } = emb;

const T0 = 1_000_000;

function makeSvc(config = {}) {
    return createIdentityService({
        clock: emb.manualClock(T0),
        config: { challengeTtlMs: 60_000, pairingTtlMs: 300_000, ...config }
    });
}

function paired(s, key = "d1") {
    const { deviceId } = s.registerIdentity({ namespace: "t", stableKey: key, displayName: "D" });
    const p = s.beginPairing(deviceId);
    s.submitChallenge({
        pairingId: p.pairingId,
        challengeId: p.challenge.challengeId,
        secret: p.challenge.secret
    });
    return { deviceId, pairingId: p.pairingId, confirm: () => s.ownerConfirm(p.pairingId) };
}

test("P-1: happy path UNPAIRED -> ... -> PAIRED; trust mirrored; zero side-effects", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    assert.equal(s.getIdentity(deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");
    confirm();
    const v = s.getIdentity(deviceId);
    assert.equal(v.pairingState, "PAIRED");
    assert.equal(v.trustState, "PAIRED");
});

test("P-2: expired challenge rejected deterministically and reclaimed", () => {
    const s = makeSvc({ challengeTtlMs: 1000 });
    const { deviceId } = s.registerIdentity({ namespace: "t", stableKey: "e" });
    const p = s.beginPairing(deviceId);
    s.clock.advance(1001);
    assert.throws(() => s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    }), e => e.code === "PID_CHALLENGE_EXPIRED");
    // Even with the right secret later — entry reclaimed, reported as unknown.
    assert.throws(() => s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    }), e => e.code === "PID_CHALLENGE_EXPIRED" || e.code === "PID_CHALLENGE_NOT_FOUND");
});

test("P-3: replayed challenge cannot re-consume", () => {
    const s = makeSvc();
    const { deviceId } = s.registerIdentity({ namespace: "t", stableKey: "r" });
    const p = s.beginPairing(deviceId);
    const args = {
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    };
    s.submitChallenge(args);                       // first use OK
    assert.throws(() => s.submitChallenge(args),   // replay at tx level
        e => e.code === "PID_INVALID_STATE"
            || e.code === "PID_CHALLENGE_NOT_FOUND");
    // broker-level replay: consumed challenge is gone forever
    const { ChallengeBroker } = emb;
    const b = new ChallengeBroker({ clock: emb.manualClock(0) });
    const ch = b.issue({ pairingId: "pair-x", deviceId: "x:y" });
    b.consume({ challengeId: ch.challengeId, secret: ch.secret, pairingId: "pair-x", deviceId: "x:y" });
    assert.throws(() => b.consume({
        challengeId: ch.challengeId, secret: ch.secret,
        pairingId: "pair-x", deviceId: "x:y"
    }), e => e.code === "PID_CHALLENGE_NOT_FOUND");
    // And a second full transaction for the same device is not silently possible:
    assert.throws(() => s.beginPairing(deviceId), e => e.code === "PID_INVALID_STATE");
});

test("P-4: wrong device / wrong transaction / malformed all fail closed", () => {
    const s = makeSvc();
    const dA = s.registerIdentity({ namespace: "t", stableKey: "dev-a" }).deviceId;
    const dB = s.registerIdentity({ namespace: "t", stableKey: "dev-b" }).deviceId;
    const pa = s.beginPairing(dA);
    const pb = s.beginPairing(dB);

    // A's secret offered to B's transaction -> mismatch
    assert.throws(() => s.submitChallenge({
        pairingId: pb.pairingId, challengeId: pb.challenge.challengeId, secret: pa.challenge.secret
    }), e => e.code === "PID_CHALLENGE_MISMATCH");

    // B's challenge bound to B's device, submitted against A's transaction -> wrong device
    assert.throws(() => s.submitChallenge({
        pairingId: pa.pairingId, challengeId: pb.challenge.challengeId, secret: pb.challenge.secret
    }), e => e.code === "PID_CHALLENGE_WRONG_DEVICE");

    // broker-level: same secret+challenge but swapped pairing id -> wrong tx
    const { ChallengeBroker } = emb;
    const b = new ChallengeBroker({ clock: emb.manualClock(0) });
    const ch1 = b.issue({ pairingId: "pair-1", deviceId: "x:one" });
    assert.throws(() => b.consume({
        challengeId: ch1.challengeId, secret: ch1.secret,
        pairingId: "pair-OTHER", deviceId: "x:one"
    }), e => e.code === "PID_CHALLENGE_WRONG_TX");

    assert.throws(() => s.submitChallenge({
        pairingId: pb.pairingId, challengeId: "../../etc/passwd", secret: "x"
    }), e => e.code === "PID_CHALLENGE_MALFORMED");

    assert.throws(() => s.submitChallenge({
        pairingId: pb.pairingId, challengeId: "chg-nonexistent", secret: "x"
    }), e => e.code === "PID_CHALLENGE_NOT_FOUND");

    assert.throws(() => s.ownerConfirm(pb.pairingId),
        e => e.code === "PID_NOT_CONFIRMABLE");     // never passed submit

    // duplicate pending attempt for a device with an active transaction
    assert.throws(() => s.beginPairing(dB), e => e.code === "PID_INVALID_STATE");
});

test("P-5: double confirmation rejected; second confirm mutates nothing", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    confirm();
    const snap = JSON.stringify(s.serialize());
    assert.throws(() => confirm(), e => e.code === "PID_ALREADY_CONFIRMED");
    assert.equal(JSON.stringify(s.serialize()), snap);
});

test("P-6: concurrent confirmation — first wins, second fails deterministically", () => {
    const s = makeSvc();
    const { deviceId, pairingId } = paired(s);
    // two racing owner paths on the same pairingId:
    const r1 = s.ownerConfirm(pairingId);
    assert.equal(r1.pairingState, "PAIRED");
    assert.throws(() => s.ownerConfirm(pairingId),
        e => e.code === "PID_ALREADY_CONFIRMED");
    assert.equal(s.getIdentity(deviceId).pairingState, "PAIRED");
});

test("P-7: transaction expiry sweeps back to EXPIRED; explicit re-enroll required", () => {
    const s = makeSvc({ pairingTtlMs: 500 });
    const { deviceId } = s.registerIdentity({ namespace: "t", stableKey: "x1" });
    s.beginPairing(deviceId);
    s.clock.advance(501);
    assert.equal(s.getIdentity(deviceId).pairingState, "EXPIRED");
    assert.throws(() => s.beginPairing(deviceId), e => e.code === "PID_INVALID_STATE");
    s.reEnrollAfterExpiry(deviceId);
    assert.equal(s.getIdentity(deviceId).pairingState, "UNPAIRED");
});

test("P-8: trust transitions bounded by table; REVOKED terminal", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    confirm();
    s.setTrust(deviceId, "TRUSTED");
    assert.equal(s.getIdentity(deviceId).trustState, "TRUSTED");
    s.setTrust(deviceId, "LIMITED");
    assert.equal(s.getIdentity(deviceId).trustState, "LIMITED");
    s.setTrust(deviceId, "PAIRED");
    s.revoke(deviceId);
    assert.equal(s.getIdentity(deviceId).pairingState, "REVOKED");
    assert.equal(s.getIdentity(deviceId).trustState, "REVOKED");
    // B1 gate denies trust ops outside an established relationship
    assert.throws(() => s.setTrust(deviceId, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING"
            || e.code === "PID_INVALID_TRANSITION");
    assert.throws(() => s.beginPairing(deviceId), e => e.code === "PID_REVOKED");
});

test("P-9: revocation kills challenges and closes sessions", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    const res = confirm();
    const sess = s.openSession({ deviceId, bindingSecret: res.bindingCredential.secret });
    assert.equal(sess.state, "ACTIVE");
    s.revoke(deviceId);
    assert.equal(s.getSession(sess.sessionId).state, "DISCONNECTED");
    assert.equal(s.getSession(sess.sessionId).closedReason, "revoked");
    assert.equal(s.stats().sessionsActive, 0);
});

test("P-10: session binding — trusted path only; forged claims counted, never bound", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    const res = confirm();

    // forged: no credential
    assert.throws(() => s.openSession({ deviceId }),
        e => e.code === "PID_SESSION_FORGED");
    // forged: wrong credential
    assert.throws(() => s.openSession({ deviceId, bindingSecret: "f".repeat(48) }),
        e => e.code === "PID_SESSION_FORGED");
    assert.equal(s.stats().forgedSessionAttempts, 2);

    // trusted binding works, multiple historical sessions fine
    const s1 = s.openSession({ deviceId, bindingSecret: res.bindingCredential.secret });
    s.closeSession(s1.sessionId);
    const s2 = s.openSession({ deviceId, bindingSecret: res.bindingCredential.secret });
    assert.notEqual(s1.sessionId, s2.sessionId);

    // session identity never rewrites canonical identity
    assert.equal(s2.deviceId, deviceId);
    assert.equal(s.getIdentity(deviceId).deviceId, deviceId);

    // unpaired device cannot host sessions at all
    const u = s.registerIdentity({ namespace: "t", stableKey: "unpaired" });
    assert.throws(() => s.openSession({ deviceId: u.deviceId, bindingSecret: "x" }),
        e => e.code === "PID_SESSION_FORGED");
});

test("P-11: binding credential digest-only — original secret not retained anywhere", () => {
    const s = makeSvc();
    const { deviceId, confirm } = paired(s);
    const res = confirm();
    const blob = JSON.stringify(s.serialize());
    assert.ok(!blob.includes(res.bindingCredential.secret));
    assert.ok(blob.length > 0);
    void deviceId;
});

test("P-12: instance-key conflict fails safely and exposes ambiguity", () => {
    const s = makeSvc();
    const { deviceId } = s.registerIdentity({ namespace: "t", stableKey: "k" });
    const p1 = s.beginPairing(deviceId, { instancePublicKey: "KEY-A" });
    s.submitChallenge({
        pairingId: p1.pairingId, challengeId: p1.challenge.challengeId,
        secret: p1.challenge.secret, instancePublicKey: "KEY-A"
    });
    s.ownerConfirm(p1.pairingId);
    s.revoke(deviceId);
    assert.throws(() => s.beginPairing(deviceId), e => e.code === "PID_REVOKED");

    // conflicting crypto identity on the same canonical deviceId
    const s2 = makeSvc();
    const d2 = s2.registerIdentity({ namespace: "t", stableKey: "k2" }).deviceId;
    const q1 = s2.beginPairing(d2, { instancePublicKey: "KEY-Z" });   // binds digest(Z)
    s2.cancelPairing(q1.pairingId);                                   // back to UNPAIRED
    assert.throws(() => s2.beginPairing(d2, { instancePublicKey: "KEY-Y" }),
        e => e.code === "PID_IDENTITY_CONFLICT");
    assert.equal(s2.stats().identityConflicts >= 1, true);
});
