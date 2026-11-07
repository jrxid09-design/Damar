const test = require("node:test");
const assert = require("node:assert");

/**
 * Recovery / persistence semantics (I§7).
 *
 * serialize/restore is canonical truth. Restored evidence never upgrades
 * REVOKED -> TRUSTED or UNPAIRED -> PAIRED. Sessions never persist.
 */

const emb = require("../../src/embodiment");
const { createIdentityService, createMemoryIdentityStore, persistIdentity }
    = emb;

const T0 = 1_000_000;
const { digestOf } = require("../../src/embodiment/core/util");

function makeSvc(config = {}) {
    return createIdentityService({
        clock: emb.manualClock(T0),
        config: { challengeTtlMs: 60_000, pairingTtlMs: 300_000, ...config }
    });
}

/** Full pairing; returns { deviceId, pairingId, bindingSecret }. */
function pairAndConfirm(s, key) {
    const { deviceId } = s.registerIdentity({ namespace: "g", stableKey: key });
    const p = s.beginPairing(deviceId);
    s.submitChallenge({
        pairingId: p.pairingId,
        challengeId: p.challenge.challengeId,
        secret: p.challenge.secret
    });
    const res = s.ownerConfirm(p.pairingId);
    return { deviceId, pairingId: p.pairingId, bindingSecret: res.bindingCredential.secret };
}

test("R-1: round-trip preserves identity/pairing/trust; sessions are NOT persisted", () => {
    const s = makeSvc();
    const a = pairAndConfirm(s, "a");
    const b = s.registerIdentity({ namespace: "g", stableKey: "b" }).deviceId;
    s.setTrust(a.deviceId, "TRUSTED");
    const data = s.serialize();

    const revived = emb.DeviceIdentityService.restore(data,
        { clock: emb.manualClock(T0 + 5) });

    assert.equal(revived.getIdentity(a.deviceId).trustState, "TRUSTED");
    assert.equal(revived.getIdentity(b).pairingState, "UNPAIRED");
    assert.equal(revived.stats().sessionsTotal, 0);   // ephemeral, not canonical
});

test("R-2: restored REVOKED stays REVOKED across generations", () => {
    let s = makeSvc();
    const d = pairAndConfirm(s, "rv").deviceId;
    s.revoke(d);
    for (let gen = 0; gen < 3; gen++) {
        s = emb.DeviceIdentityService.restore(s.serialize(),
            { clock: emb.manualClock(T0 + gen) });
        assert.equal(s.getIdentity(d).pairingState, `REVOKED`, `gen ${gen}`);
        assert.equal(s.getIdentity(d).trustState, "REVOKED");
        assert.throws(() => s.beginPairing(d), e => e.code === "PID_REVOKED");
    }
});

test("R-3: restored UNPAIRED stays UNPAIRED — no silent pairing from evidence", () => {
    const s = makeSvc();
    const d = s.registerIdentity({ namespace: "g", stableKey: "solo" }).deviceId;
    s.observeCapabilities(d, ["camera"]);          // mere observation/evidence
    s.setPresence(d, "ONLINE");
    const next = emb.DeviceIdentityService.restore(s.serialize(),
        { clock: emb.manualClock(T0) });
    assert.equal(next.getIdentity(d).pairingState, "UNPAIRED");
    assert.equal(next.getIdentity(d).trustState, "UNKNOWN");
});

test("R-4: fail-closed — one tampered row rejects the WHOLE snapshot", () => {
    const s = makeSvc();
    pairAndConfirm(s, "t1");
    const data = JSON.parse(JSON.stringify(s.serialize()));
    data.devices[0].pairingState = "TRUSTED";       // tamper without re-digest
    assert.throws(() =>
        emb.DeviceIdentityService.restore(data, { clock: emb.manualClock(T0) }),
        e => e.code === "PID_INVALID_SERIALIZATION"
            && e.details.some(x => /PID_DIGEST_MISMATCH|PID_TRUST_MISMATCH/.test(x)));
});

test("R-5: fail-closed — duplicate deviceId, orphan transaction, bad enums rejected", () => {
    const s = makeSvc();
    pairAndConfirm(s, "dup");
    const raw = JSON.parse(JSON.stringify(s.serialize()));

    const dupRows = structuredClone(raw);
    dupRows.devices.push(structuredClone(raw.devices[0]));
    assert.throws(() => emb.DeviceIdentityService.restore(dupRows, {}),
        e => e.details.some(x => /PID_DUPLICATE_DEVICE/.test(x)));

    const orphan = structuredClone(raw);
    orphan.transactions.push({
        pairingId: "pair-orphan", deviceId: "ghost:none", state: "CONFIRMED"
    });
    assert.throws(() => emb.DeviceIdentityService.restore(orphan, {}),
        e => e.details.some(x => /PID_TRANSACTION_ORPHAN/.test(x)));

    const badEnum = structuredClone(raw);
    badEnum.devices[0].bodyRelation = "GOD";
    const mat = { ...badEnum.devices[0] };
    delete mat.rowDigest;
    badEnum.devices[0].rowDigest = digestOf(mat);   // forged matching digest
    assert.throws(() => emb.DeviceIdentityService.restore(badEnum, {}),
        e => e.details.some(x => /PID_INVALID_ENUM/.test(x)));
});

test("R-6: store port round-trip (memory reference implementation)", async () => {
    const store = createMemoryIdentityStore();
    const s = makeSvc();
    const { deviceId } = pairAndConfirm(s, "st");
    await persistIdentity(s, store);

    const revived = await emb.loadIdentity({ store, clock: emb.manualClock(T0 + 9) });
    assert.ok(revived instanceof emb.DeviceIdentityService);
    assert.equal(revived.getIdentity(deviceId).pairingState, "PAIRED");
});

test("R-7: stale session cannot resurrect; legit rebind works until revoked", () => {
    let s = makeSvc();
    const { deviceId, bindingSecret } = pairAndConfirm(s, "bind");

    // legit rebind across a restart generation
    s = emb.DeviceIdentityService.restore(s.serialize(), { clock: emb.manualClock(T0 + 1) });
    const sess = s.openSession({ deviceId, bindingSecret });
    assert.equal(sess.state, "ACTIVE");
    s.closeSession(sess.sessionId);

    // revocation survives restore and kills the binding path forever
    s.revoke(deviceId);
    s = emb.DeviceIdentityService.restore(s.serialize(), { clock: emb.manualClock(T0 + 2) });
    assert.equal(s.getIdentity(deviceId).pairingState, "REVOKED");
    assert.throws(() => s.openSession({ deviceId, bindingSecret }),
        e => e.code === "PID_SESSION_FORGED");   // no stale resurrection
});
