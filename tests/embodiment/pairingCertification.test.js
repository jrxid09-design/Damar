const test = require("node:test");
const assert = require("node:assert");

/**
 * CERTIFICATION REPAIR TESTS (B1/B2/B3 + cross-repair invariant).
 *
 * B1  setTrust must NEVER create pairing (denial = zero mutation).
 * B2  In-flight pairing must not survive restart (shared normalization
 *     at the persistence boundary).
 * B3  ownerConfirm must be atomic (any failure => byte-identical state).
 *
 * Cross-repair: the ONLY establishment path is
 *   UNPAIRED -> beginPairing -> valid challenge ->
 *   AWAITING_OWNER_CONFIRMATION -> ownerConfirm -> PAIRED.
 */

const emb = require("../../src/embodiment");
const { createIdentityService } = emb;

const T0 = 1_000_000;
const CFG = { challengeTtlMs: 60_000, pairingTtlMs: 300_000 };

function makeSvc(config = {}) {
    return createIdentityService({ clock: emb.manualClock(T0), config: { ...CFG, ...config } });
}

function fullFlow(s, key) {
    const { deviceId } = s.registerIdentity({ namespace: "cert", stableKey: key });
    const p = s.beginPairing(deviceId);
    s.submitChallenge({
        pairingId: p.pairingId,
        challengeId: p.challenge.challengeId,
        secret: p.challenge.secret
    });
    return { deviceId, pairingId: p.pairingId };
}

/* ============================== B1 ================================== */

test("B1-1: setTrust from AWAITING_OWNER_CONFIRMATION DENIED for every level", () => {
    const s = makeSvc();
    const { deviceId } = fullFlow(s, "b1");       // now AWAITING_OWNER_CONFIRMATION
    const before = JSON.stringify(s.serialize());

    for (const level of ["PAIRED", "TRUSTED", "LIMITED"]) {
        assert.throws(() => s.setTrust(deviceId, level),
            e => e.code === "PID_NO_ESTABLISHED_PAIRING",
            `setTrust(${level}) from AWAITING must be denied`);
    }
    // byte-identical: zero mutation across all denials
    assert.equal(JSON.stringify(s.serialize()), before);
});

test("B1-2: setTrust denied from UNPAIRED / CHALLENGE_ISSUED / REVOKED / EXPIRED / FAILED", () => {
    const s = makeSvc();

    // UNPAIRED
    const u = s.registerIdentity({ namespace: "cert", stableKey: "u" }).deviceId;
    assert.throws(() => s.setTrust(u, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING");

    // CHALLENGE_ISSUED
    const c = s.registerIdentity({ namespace: "cert", stableKey: "c" }).deviceId;
    s.beginPairing(c);
    assert.throws(() => s.setTrust(c, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING");

    // EXPIRED
    const s2 = makeSvc({ pairingTtlMs: 100 });
    const x = s2.registerIdentity({ namespace: "cert", stableKey: "x" }).deviceId;
    s2.beginPairing(x);
    s2.clock.advance(101);
    assert.equal(s2.getIdentity(x).pairingState, "EXPIRED");
    assert.throws(() => s2.setTrust(x, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING");

    // REVOKED
    const s3 = makeSvc();
    const { deviceId: d3, pairingId: pid3 } = fullFlow(s3, "rev");
    s3.ownerConfirm(pid3);
    s3.revoke(d3);
    assert.throws(() => s3.setTrust(d3, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING");

    // FAILED
    const s4 = makeSvc();
    const d4 = s4.registerIdentity({ namespace: "cert", stableKey: "fail" }).deviceId;
    const p4 = s4.beginPairing(d4, { instancePublicKey: "K1" });
    s4.cancelPairing(p4.pairingId);                       // back to UNPAIRED
    // force a genuine FAILED record (whitebox) and verify denial
    const rec4 = s4._devices.get(d4);
    rec4.pairingState = "FAILED";
    rec4.trustState = "UNKNOWN";
    assert.throws(() => s4.setTrust(d4, "TRUSTED"),
        e => e.code === "PID_NO_ESTABLISHED_PAIRING");
});

test("B1-3: only ownerConfirm establishes the initial relationship", () => {
    const s = makeSvc();
    const { deviceId, pairingId } = fullFlow(s, "only");
    assert.equal(s.getIdentity(deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");
    s.ownerConfirm(pairingId);
    assert.equal(s.getIdentity(deviceId).pairingState, "PAIRED");
    // after establishment setTrust operates per contract
    s.setTrust(deviceId, "TRUSTED");
    assert.equal(s.getIdentity(deviceId).trustState, "TRUSTED");
});

/* ============================== B2 ================================== */

test("B2-A: beginPairing -> serialize/restore -> UNPAIRED -> beginPairing works again", () => {
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "cert", stableKey: "b2a" }).deviceId;
    s.beginPairing(d);
    assert.equal(s.getIdentity(d).pairingState, "CHALLENGE_ISSUED");

    const restored = emb.DeviceIdentityService.restore(s.serialize(),
        { clock: emb.manualClock(T0 + 1), config: CFG });
    const v = restored.getIdentity(d);
    assert.equal(v.pairingState, "UNPAIRED");
    assert.equal(v.trustState, "UNKNOWN");
    assert.equal(v.hasActiveTransaction, false);

    // no wedge: a fresh transaction can start immediately
    const p = restored.beginPairing(d);
    assert.ok(p.pairingId && p.challenge.secret);
});

test("B2-B: valid challenge submitted -> restore -> UNPAIRED, no trusted relationship, restartable", () => {
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "cert", stableKey: "b2b" }).deviceId;
    const p = s.beginPairing(d);
    s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    });
    assert.equal(s.getIdentity(d).pairingState, "AWAITING_OWNER_CONFIRMATION");

    const restored = emb.DeviceIdentityService.restore(s.serialize(),
        { clock: emb.manualClock(T0 + 1), config: CFG });
    const v = restored.getIdentity(d);
    assert.equal(v.pairingState, "UNPAIRED");
    assert.equal(v.trustState, "UNKNOWN");
    // old binding credential could not exist anyway; bindingDigest absent
    assert.throws(() =>
        restored.openSession({ deviceId: d, bindingSecret: "anything" }),
        e => e.code === "PID_SESSION_FORGED");

    // pairing can restart normally end-to-end
    const q = restored.beginPairing(d);
    restored.submitChallenge({
        pairingId: q.pairingId, challengeId: q.challenge.challengeId, secret: q.challenge.secret
    });
    const res = restored.ownerConfirm(q.pairingId);
    assert.equal(restored.getIdentity(d).pairingState, "PAIRED");
    assert.ok(res.bindingCredential.secret);
});

test("B2-C: repeated generations — no wedge, transient never survives", () => {
    let s = makeSvc();
    const d = s.registerIdentity({ namespace: "cert", stableKey: "b2c" }).deviceId;
    for (let gen = 0; gen < 5; gen++) {
        s.beginPairing(d);
        if (gen % 2 === 0) {
            const txs = [...s._transactions.values()]
                .filter(t => t.deviceId === d && t.state === "CHALLENGE_ISSUED");
            const p = txs.at(-1);
            assert.throws(() => s.submitChallenge({
                pairingId: p.pairingId, challengeId: p.challengeId, secret: "wrong"
            }), e => e.code === "PID_CHALLENGE_MISMATCH");
        }
        s = emb.DeviceIdentityService.restore(s.serialize(),
            { clock: emb.manualClock(T0 + gen), config: CFG });
        assert.equal(s.getIdentity(d).pairingState, "UNPAIRED", `gen ${gen}`);
        assert.equal(s.getIdentity(d).trustState, "UNKNOWN");
    }
    // still fully functional after 5 generations
    const p = s.beginPairing(d);
    s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    });
    s.ownerConfirm(p.pairingId);
    assert.equal(s.getIdentity(d).pairingState, "PAIRED");
});

test("B2-D: pending evidence cannot become PAIRED/TRUSTED via setTrust after restore", () => {
    const s = makeSvc();
    const { deviceId } = fullFlow(s, "b2d");     // AWAITING at snapshot time
    const raw = JSON.parse(JSON.stringify(s.serialize()));
    const row = raw.devices[0];
    assert.equal(row.pairingState, "UNPAIRED");  // normalized AT SERIALIZE (shared rule)

    const restored = emb.DeviceIdentityService.restore(raw,
        { clock: emb.manualClock(T0 + 1), config: CFG });
    assert.equal(restored.getIdentity(deviceId).pairingState, "UNPAIRED");
    for (const level of ["PAIRED", "TRUSTED", "LIMITED"]) {
        assert.throws(() => restored.setTrust(deviceId, level),
            e => e.code === "PID_NO_ESTABLISHED_PAIRING");
    }

    // hostile external snapshot claiming transient states WITH matching digest:
    // normalized safely to UNPAIRED by the same shared rule.
    const forged = structuredClone(raw);
    forged.devices[0].pairingState = "AWAITING_OWNER_CONFIRMATION";
    const { digestOf } = require("../../src/embodiment/core/util");
    const mat = { ...forged.devices[0] };
    delete mat.rowDigest;
    forged.devices[0].rowDigest = digestOf({
        ...mat,
        pairingState: "UNPAIRED",
        trustState: "UNKNOWN"
    });
    const svcF = emb.DeviceIdentityService.restore(forged,
        { clock: emb.manualClock(T0 + 2), config: CFG });
    assert.equal(svcF.getIdentity(deviceId).pairingState, "UNPAIRED");
});

/* ============================== B3 ================================== */

test("B3-1: failing ownerConfirm leaves canonical state byte-identical", () => {
    const s = makeSvc();
    const { deviceId, pairingId } = fullFlow(s, "b3");
    // Force an illegal transition: desynchronize device from its transaction.
    const rec = s._devices.get(deviceId);
    rec.pairingState = "EXPIRED";
    rec.trustState = "UNKNOWN";

    const before = JSON.stringify(s.serialize());
    assert.throws(() => s.ownerConfirm(pairingId),
        e => e.code === "PID_INVALID_TRANSITION");
    const after = JSON.stringify(s.serialize());

    assert.equal(after, before);                 // whole snapshot identical
    const tx = s._transactions.get(pairingId);
    assert.equal(tx.state, "AWAITING_OWNER_CONFIRMATION");
    assert.equal(tx.confirmedBy, undefined);
    assert.equal(rec.bindingDigest, null);       // no credential minted
    assert.equal(JSON.parse(after).devices[0].history.length, 0);
});

test("B3-2: stale confirm after cancel / after revoke fails without partial mutation", () => {
    // cancel then stale confirm
    const s1 = makeSvc();
    const d1 = s1.registerIdentity({ namespace: "cert", stableKey: "stale1" }).deviceId;
    const p1 = s1.beginPairing(d1);
    s1.submitChallenge({
        pairingId: p1.pairingId, challengeId: p1.challenge.challengeId, secret: p1.challenge.secret
    });
    s1.cancelPairing(p1.pairingId);
    const before1 = JSON.stringify(s1.serialize());
    assert.throws(() => s1.ownerConfirm(p1.pairingId),
        e => e.code === "PID_NOT_CONFIRMABLE");
    assert.equal(JSON.stringify(s1.serialize()), before1);

    // revoke then stale confirm (double-confirm of a confirmed tx is also covered)
    const s2 = makeSvc();
    const d2 = fullFlow(s2, "stale2").deviceId;
    const txs = [...s2._transactions.values()];
    const pid = txs.filter(t => t.deviceId === d2).at(-1).pairingId;
    s2.ownerConfirm(pid);
    s2.revoke(d2);
    const before2 = JSON.stringify(s2.serialize());
    assert.throws(() => s2.ownerConfirm(pid),
        e => e.code === "PID_ALREADY_CONFIRMED");
    assert.equal(JSON.stringify(s2.serialize()), before2);
});

test("B3-3: concurrent ownerConfirm — exactly one wins, loser mutates nothing", () => {
    const s = makeSvc();
    const { deviceId, pairingId } = fullFlow(s, "race");
    const before = JSON.stringify(s.serialize());
    const r1 = s.ownerConfirm(pairingId);
    assert.equal(r1.pairingState, "PAIRED");
    const afterWin = JSON.stringify(s.serialize());
    for (let i = 0; i < 5; i++) {
        assert.throws(() => s.ownerConfirm(pairingId),
            e => e.code === "PID_ALREADY_CONFIRMED");
        assert.equal(JSON.stringify(s.serialize()), afterWin);
    }
    assert.notEqual(before, afterWin);           // exactly one real transition
    void deviceId;
});

/* ==================== CROSS-REPAIR INVARIANT ======================== */

test("X-1: no public method creates PAIRED from a non-established state", () => {
    for (const state of ["UNPAIRED", "CHALLENGE_ISSUED", "AWAITING_OWNER_CONFIRMATION",
        "REVOKED", "EXPIRED", "FAILED"]) {
        const s = makeSvc();
        const d = s.registerIdentity({ namespace: "cert", stableKey: `x-${state}` }).deviceId;
        // place device into the target state via public paths where possible
        const rec = s._devices.get(d);
        if (state === "CHALLENGE_ISSUED") s.beginPairing(d);
        else if (state === "AWAITING_OWNER_CONFIRMATION") fullFlow(s, `x-${state}`);
        else { rec.pairingState = state; rec.trustState = "UNKNOWN"; }

        // every escalation route must fail
        assert.throws(() => s.setTrust(d, "PAIRED"));
        assert.throws(() => s.setTrust(d, "TRUSTED"));
        try { s.observeCapabilities(d, ["camera"]); } catch { /* irrelevant */ }
        try { s.setPresence(d, "ONLINE"); } catch { /* irrelevant */ }
        try { s.rename(d, "escalate-attempt"); } catch { /* irrelevant */ }
        assert.equal(s.getIdentity(d).pairingState, state,
            `${state}: observation/rename must not establish pairing`);
        assert.equal(s.getIdentity(d).trustState, "UNKNOWN",
            `${state}: trust must remain UNKNOWN outside established relationship`);
    }

    // and the single legal path works end-to-end
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "cert", stableKey: "golden" }).deviceId;
    const p = s.beginPairing(d);
    s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    });
    s.ownerConfirm(p.pairingId);
    assert.equal(s.getIdentity(d).pairingState, "PAIRED");
});

/* ===================== REGRESSION PROBES ============================ */

test("RG-1: session binding after VALID vs FAILED/cancelled confirm", () => {
    // valid confirm binds
    const s1 = makeSvc();
    const d1 = s1.registerIdentity({ namespace: "cert", stableKey: "ok" }).deviceId;
    const p1 = s1.beginPairing(d1);
    s1.submitChallenge({
        pairingId: p1.pairingId, challengeId: p1.challenge.challengeId, secret: p1.challenge.secret
    });
    const res = s1.ownerConfirm(p1.pairingId);
    const sess = s1.openSession({ deviceId: d1, bindingSecret: res.bindingCredential.secret });
    assert.equal(sess.state, "ACTIVE");

    // cancelled confirm mints nothing to bind with
    const s2 = makeSvc();
    const d2 = s2.registerIdentity({ namespace: "cert", stableKey: "no" }).deviceId;
    const p2 = s2.beginPairing(d2);
    s2.cancelPairing(p2.pairingId);
    assert.throws(() => s2.openSession({ deviceId: d2, bindingSecret: "guessed" }),
        e => e.code === "PID_SESSION_FORGED");
});

test("RG-2: multiple devices isolated — one device's lifecycle never touches another", () => {
    const s = makeSvc();
    const a = fullFlow(s, "multi-a");
    const b = fullFlow(s, "multi-b");
    s.ownerConfirm(a.pairingId);

    assert.equal(s.getIdentity(a.deviceId).pairingState, "PAIRED");
    assert.equal(s.getIdentity(b.deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");

    // revoking A leaves B untouched
    s.revoke(a.deviceId);
    assert.equal(s.getIdentity(a.deviceId).pairingState, "REVOKED");
    assert.equal(s.getIdentity(b.deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");

    // restoring keeps both consistent
    const r = emb.DeviceIdentityService.restore(s.serialize(),
        { clock: emb.manualClock(T0 + 1), config: CFG });
    assert.equal(r.getIdentity(a.deviceId).pairingState, "REVOKED");
    assert.equal(r.getIdentity(b.deviceId).pairingState, "UNPAIRED");   // B2 normalization
});

test("RG-3: brute force / replay / expiry regressions still hold post-repair", () => {
    const s = makeSvc({ maxChallengeAttempts: 3 });
    const d = s.registerIdentity({ namespace: "cert", stableKey: "rg3" }).deviceId;
    const p = s.beginPairing(d);
    for (let i = 0; i < 2; i++) {
        assert.throws(() => s.submitChallenge({
            pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: "bad"
        }), e => e.code === "PID_CHALLENGE_MISMATCH");
    }
    assert.throws(() => s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: "bad"
    }), e => e.code === "PID_CHALLENGE_EXHAUSTED");
    assert.throws(() => s.submitChallenge({
        pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret
    }), e => e.code === "PID_CHALLENGE_NOT_FOUND");   // reclaimed even if correct
});
