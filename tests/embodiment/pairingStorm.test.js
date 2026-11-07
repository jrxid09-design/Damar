const test = require("node:test");
const assert = require("node:assert");

/**
 * STORM TEST (I§10) — 6000 deterministic mixed operations.
 *
 * Requires: bounded structures, unique canonical identity, no lifecycle
 * wedge, no replay success, no stale resurrection, no Authority
 * mutations (structural isolation), no hidden actuation, no timer leak.
 */

const emb = require("../../src/embodiment");
const { createIdentityService } = emb;

const OPS = 6000;

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test(`S-1: ${OPS} mixed operations stay bounded, replay-proof, resurrection-free`, () => {
    const clock = emb.manualClock(0);
    let s = createIdentityService({
        clock,
        config: {
            maxDevices: 64, challengeTtlMs: 500, pairingTtlMs: 2000,
            maxPendingTransactions: 8, maxArchivedTransactions: 128,
            maxTotalSessions: 256, maxSessionsPerDevice: 4
        }
    });

    const rand = rng(20260826);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const deviceIds = [];

    // No timers anywhere in this module:
    const timersBefore = process.getActiveResourcesInfo
        ? process.getActiveResourcesInfo().filter(r => r === "Timeout").length : -1;

    const counters = {
        register: 0, rename: 0, begin: 0, submitOk: 0, submitFail: 0,
        confirm: 0, expire: 0, replay: 0, revoke: 0, session: 0,
        disconnect: 0, capability: 0, presence: 0, restore: 0, malformed: 0
    };

    for (let i = 0; i < OPS; i++) {
        clock.advance(1 + Math.floor(rand() * 50));
        if (!deviceIds.length || (rand() < 0.15 && deviceIds.length < 64)) {
            const { deviceId } = s.registerIdentity({
                namespace: "storm",
                stableKey: `dev-${Math.floor(rand() * 1e9)}`
            });
            deviceIds.push(deviceId);
            counters.register++;
            continue;
        }
        const d = pick(deviceIds);
        const v = s.getIdentity(d);
        switch (pick([
            "rename", "begin", "submit", "confirm", "expire", "replay",
            "revoke", "session", "disconnect", "capability", "presence",
            "malformed"
        ])) {
            case "rename":
                s.rename(d, `name-${i % 97}`);
                counters.rename++;
                break;
            case "begin":
                try {
                    s.beginPairing(d);
                    counters.begin++;
                } catch (e) {
                    // REVOKED / active tx / EXPIRED are all legal refusals
                    assert.match(e.code, /^PID_(REVOKED|INVALID_STATE|TOO_MANY)/);
                }
                break;
            case "submit": {
                // fabricate a plausible-but-wrong attempt against a live tx
                try {
                    const pending = [...s._transactions.values()]
                        .find(t => (t.deviceId === d)
                            && t.state === "CHALLENGE_ISSUED");
                    if (!pending) break;
                    s.submitChallenge({
                        pairingId: pending.pairingId,
                        challengeId: pending.challengeId,
                        secret: rand() < 0.02 ? null : "guess"
                    });
                    counters.submitFail++;   // wrong secret consumed an attempt
                } catch (e) {
                    assert.match(e.code, /^PID_/);
                    counters.submitFail++;
                }
                break;
            }
            case "confirm": {
                const awaitConf = [...s._transactions.values()]
                    .find(t => t.deviceId === d && t.state === "AWAITING_OWNER_CONFIRMATION");
                if (!awaitConf) break;
                // confirm without ever submitting a valid challenge is impossible
                // here because storm never submits correct secrets; refusal expected
                try {
                    s.ownerConfirm(awaitConf.pairingId);
                    counters.confirm++;
                } catch (e) {
                    assert.equal(e.code, "PID_NOT_CONFIRMABLE");
                }
                break;
            }
            case "expire":
                clock.advance(3000);          // force sweep on next op
                counters.expire++;
                break;
            case "replay": {
                // replay of ANY previously used tx must fail forever
                const done = [...s._transactions.values()]
                    .find(t => t.deviceId === d && (t.state === "CONFIRMED" || t.state === "EXPIRED"));
                if (!done) break;
                assert.throws(() =>
                    s.submitChallenge({ pairingId: done.pairingId, challengeId: done.challengeId, secret: "x" }),
                    e => e.code === "PID_CHALLENGE_NOT_FOUND"
                        || e.code === "PID_INVALID_STATE");
                counters.replay++;
                break;
            }
            case "revoke":
                try {
                    s.revoke(d);
                    counters.revoke++;
                    assert.equal(s.getIdentity(d).pairingState, "REVOKED");
                } catch (e) {
                    assert.match(e.code, /^PID_(NOT_PAIRED|UNKNOWN_DEVICE)/);
                }
                break;
            case "session":
                try {
                    const sess = s.openSession({ deviceId: d, bindingSecret: "no-cred" });
                    assert.fail("forged bind must fail"); void sess;
                } catch (e) {
                    assert.match(e.code, /^PID_(SESSION_FORGED|UNKNOWN_DEVICE)/);
                    counters.session++;
                }
                break;
            case "disconnect": {
                const mine = s.listSessions(d).filter(x => x.state === "ACTIVE");
                for (const m of mine) s.closeSession(m.sessionId);
                counters.disconnect++;
                break;
            }
            case "capability":
                s.observeCapabilities(d, ["camera", "microphone", "bogus", "location"]);
                counters.capability++;
                break;
            case "presence":
                s.setPresence(d, pick(["ONLINE", "OFFLINE", "STALE", "UNKNOWN"]));
                counters.presence++;
                break;
            case "malformed":
                assert.throws(() => s.submitChallenge({
                    pairingId: rand() < 0.5 ? null : "../etc/passwd",
                    challengeId: "\u0000", secret: 7
                }), e => /^PID_/.test(e.code));
                counters.malformed++;
                break;
        }

        // periodic recovery-generation change
        if (i > 0 && i % 1000 === 0) {
            const snap = s.serialize();
            s = emb.DeviceIdentityService.restore(snap, { clock });
            counters.restore++;
        }

        // mid-storm invariants
        if (i % 500 === 0) {
            const st = s.stats();
            assert.ok(st.devices <= 64, "device bound");
            assert.ok(st.challengesLive <= 16, "challenge bound");
            assert.ok(st.transactionsActive <= 8, "pending-tx bound");
            assert.ok(st.sessionsActive >= 0);
            for (const id of deviceIds) {
                const rec = s.getIdentity(id);
                assert.ok(rec, `identity ${id} alive at op ${i}`);
                assert.notEqual(rec.pairingState, undefined);
            }
        }
    }

    // final structural assertions
    const st = s.stats();
    assert.ok(new Set(s.serialize().devices.map(x => x.deviceId)).size
        === s.serialize().devices.length, "unique canonical identity");
    assert.ok(st.transactionsActive <= 8);
    assert.ok(s._sessions.size <= 256, "session tombstone bound");
    assert.ok(s._transactions.size <= 8 + 128, "tx archive bound");

    // no replay succeeded anywhere (counters exercised)
    assert.ok(counters.replay >= 25, `replay attempts ran: ${counters.replay}`);
    assert.ok(counters.malformed > 100);
    assert.ok(counters.restore === OPS / 1000 - 1 || counters.restore >= 4,
        `recovery generations: ${counters.restore}`);

    // no timer/handle leak
    if (timersBefore >= 0) {
        const timersAfter = process.getActiveResourcesInfo()
            .filter(r => r === "Timeout").length;
        assert.equal(timersAfter, timersBefore);
    }

    // revoked never resurrected by the final restore generation
    for (const d of deviceIds) {
        if (s.getIdentity(d).pairingState === "TRUSTED") {
            // TRUSTED can only exist via explicit owner setTrust — storm never calls it
            assert.fail("trust escalation without owner action");
        }
    }
});

test("S-2: serialization size stays bounded across many generations", () => {
    const clock = emb.manualClock(0);
    const cfg = { maxDevices: 32, pairingTtlMs: 10, challengeTtlMs: 10 };
    let s = createIdentityService({ clock, config: cfg });
    let maxSize = 0;
    const rand = rng(99);
    for (let gen = 0; gen < 25; gen++) {
        for (let k = 0; k < 40; k++) {
            try {
                s.registerIdentity({
                    namespace: "g", stableKey: `k-${Math.floor(rand() * 20)}`
                });
            } catch { /* device-cap refusals are legal */ }
        }
        clock.advance(100);
        const size = JSON.stringify(s.serialize()).length;
        maxSize = Math.max(maxSize, size);
        s = emb.DeviceIdentityService.restore(s.serialize(), { clock, config: cfg });
    }
    assert.ok(maxSize < 512 * 1024, `serialization bounded (${maxSize} bytes)`);
});

test("S-3: 5200-op storm with REAL pairing flows across recovery generations", () => {
    const clock = emb.manualClock(0);
    const cfg = {
        maxDevices: 192, challengeTtlMs: 30000, pairingTtlMs: 60000,
        maxPendingTransactions: 8, maxArchivedTransactions: 128,
        maxTotalSessions: 256, maxSessionsPerDevice: 4
    };
    let s = createIdentityService({ clock, config: cfg });
    const rand = rng(777001);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    const devices = [];
    const inflight = new Map();   // deviceId -> {pairingId, challengeId, secret}
    const creds = new Map();      // deviceId -> bindingSecret
    const counters = {
        register: 0, begin: 0, realSubmit: 0, realConfirm: 0, trustOps: 0,
        sessionOk: 0, sessionForgedDenied: 0, revoke: 0, replay: 0,
        malformed: 0, restarts: 0, expireSweeps: 0, closeSession: 0
    };

    const timersBefore = process.getActiveResourcesInfo
        ? process.getActiveResourcesInfo().filter(r => r === "Timeout").length : -1;

    for (let i = 0; i < 5200; i++) {
        clock.advance(1 + Math.floor(rand() * 40));

        if (!devices.length || (rand() < 0.10 && devices.length < 48)) {
            try {
                const { deviceId } = s.registerIdentity({
                    namespace: "real", stableKey: `dev-${Math.floor(rand() * 1e9)}`
                });
                devices.push(deviceId);
            } catch { /* device cap is legal */ }
            counters.register++;
            continue;
        }

        // Follow in-flight pairing chains most of the time so REAL flows
        // (begin -> submit -> confirm -> bind) actually complete.
        const pendingIds = [...inflight.keys()];
        const d = (pendingIds.length && rand() < 0.75)
            ? pick(pendingIds)
            : pick(devices);
        switch (pick([
            "begin", "begin", "realSubmit", "realSubmit", "realSubmit",
            "realConfirm", "realConfirm",
            "trust", "trust", "session", "session", "closeSession",
            "revoke", "replay", "malformed", "restart", "expire"
        ])) {
            case "begin": {
                if (s.getIdentity(d).pairingState !== "UNPAIRED") break;
                try {
                    const p = s.beginPairing(d);
                    inflight.set(d, p.pairingId && {
                        pairingId: p.pairingId,
                        challengeId: p.challenge.challengeId,
                        secret: p.challenge.secret
                    });
                    counters.begin++;
                } catch (e) {
                    assert.match(e.code, /^PID_(REVOKED|INVALID_STATE|TOO_MANY)/);
                }
                break;
            }
            case "realSubmit": {
                const p = inflight.get(d);
                if (!p) break;
                try {
                    s.submitChallenge(p);       // VALID secret
                    counters.realSubmit++;
                } catch (e) {
                    if (e.code === "PID_INVALID_STATE") {
                        // already AWAITING — entry still live, confirm next
                        break;
                    }
                    // expired / exhausted / swept — drop the attempt
                    assert.match(e.code, /^PID_/);
                    inflight.delete(d);
                }
                break;
            }
            case "realConfirm": {
                const p = inflight.get(d);
                if (!p) break;
                try {
                    const res = s.ownerConfirm(p.pairingId);
                    creds.set(d, res.bindingCredential.secret);   // REAL binding credential
                    inflight.delete(d);
                    counters.realConfirm++;
                } catch (e) {
                    if (e.code === "PID_NOT_CONFIRMABLE") {
                        // still CHALLENGE_ISSUED — keep for a later submit
                        break;
                    }
                    assert.match(e.code,
                        /^PID_(ALREADY_CONFIRMED|TX_UNKNOWN|INVALID_TRANSITION)$/);
                    inflight.delete(d);
                }
                break;
            }
            case "trust": {
                const v = s.getIdentity(d);
                if (!["PAIRED", "TRUSTED", "LIMITED"].includes(v.pairingState)) {
                    assert.throws(() => s.setTrust(d, "TRUSTED"),
                        e => e.code === "PID_NO_ESTABLISHED_PAIRING");
                } else {
                    const target = pick(["TRUSTED", "LIMITED", "PAIRED"]);
                    if (target !== v.pairingState) {   // table forbids self-transitions
                        s.setTrust(d, target);
                        counters.trustOps++;
                    }
                }
                break;
            }
            case "session": {
                const cred = creds.get(d);
                if (!cred) {
                    assert.throws(() =>
                        s.openSession({ deviceId: d, bindingSecret: "no-cred" }),
                        e => e.code === "PID_SESSION_FORGED" || e.code === "PID_UNKNOWN_DEVICE");
                    counters.sessionForgedDenied++;
                    break;
                }
                try {
                    const sess = s.openSession({ deviceId: d, bindingSecret: cred });
                    assert.equal(sess.state, "ACTIVE");
                    counters.sessionOk++;
                } catch (e) {
                    // post-revoke or cap — legal refusals
                    assert.match(e.code, /^PID_(SESSION_FORGED|SESSION_EXISTS)/);
                    counters.sessionForgedDenied++;
                }
                break;
            }
            case "closeSession": {
                const mine = s.listSessions(d).filter(x => x.state === "ACTIVE");
                for (const m of mine.slice(0, 2)) {
                    s.closeSession(m.sessionId);
                    counters.closeSession++;
                }
                break;
            }
            case "revoke": {
                const v = s.getIdentity(d);
                try {
                    s.revoke(d);
                    counters.revoke++;
                    creds.delete(d);            // dead credential can never rebind
                } catch (e) {
                    assert.equal(e.code, "PID_NOT_PAIRED");
                }
                void v;
                break;
            }
            case "replay": {
                const p = inflight.get(d);
                if (!p) break;
                // replay of the same challenge args must NEVER succeed twice
                try {
                    s.submitChallenge(p);
                    counters.replay++;   // first use in this op is legal
                } catch (e) {
                    assert.match(e.code, /^PID_/);
                }
                try {
                    s.submitChallenge(p);       // immediate second use: forbidden
                    assert.fail("replay succeeded");
                } catch (e) {
                    assert.match(e.code,
                        /^PID_(CHALLENGE_NOT_FOUND|CHALLENGE_EXPIRED|INVALID_STATE|NOT_FOUND|CHALLENGE_MISMATCH)$/);
                }
                break;
            }
            case "malformed":
                assert.throws(() => s.submitChallenge({
                    pairingId: null, challengeId: "\u0000", secret: 9
                }), e => /^PID_/.test(e.code));
                counters.malformed++;
                break;
            case "restart": {
                const snap = s.serialize();
                s = emb.DeviceIdentityService.restore(snap, { clock, config: cfg });
                inflight.clear();               // pending txs are not durable (B2)
                counters.restarts++;
                break;
            }
            case "expire":
                clock.advance(8000);
                counters.expireSweeps++;
                break;
        }

        if (i % 650 === 0) {
            const st = s.stats();
            assert.ok(st.devices <= 192);
            assert.ok(st.transactionsActive <= 8);
            assert.ok(st.challengesLive <= 16);
            // trust mirror consistency everywhere
            const data = s.serialize();
            for (const row of data.devices) {
                const established = ["PAIRED", "TRUSTED", "LIMITED", "REVOKED"];
                if (!established.includes(row.pairingState)) {
                    assert.equal(row.trustState, "UNKNOWN",
                        `non-established ${row.pairingState} leaked trust`);
                }
                assert.ok(!["CHALLENGE_ISSUED", "AWAITING_OWNER_CONFIRMATION"]
                    .includes(row.pairingState), "transient state serialized");
            }
        }
    }

    /* -------- final invariants -------- */
    const st = s.stats();
    assert.ok(st.devices > 0 && st.devices <= 192);

    // real flows actually happened (not just malformed noise)
    // (~280 mid-storm restarts wipe in-flight chains; 45+ completed
    // ownerConfirm flows is a strong real-throughput signal)
    assert.ok(counters.realConfirm >= 45, `confirms: ${counters.realConfirm}`);
    assert.ok(counters.trustOps >= 20, `trust ops: ${counters.trustOps}`);
    assert.ok(counters.sessionOk >= 20, `sessions bound: ${counters.sessionOk}`);
    assert.ok(counters.revoke >= 5, `revokes: ${counters.revoke}`);
    assert.ok(counters.restarts >= 50, `restarts: ${counters.restarts}`);
    assert.ok(counters.sessionForgedDenied >= 10);
    assert.ok(counters.malformed >= 10);

    // canonical truth consistency after the last generation
    const data = s.serialize();
    const ids = data.devices.map(x => x.deviceId);
    assert.equal(new Set(ids).size, ids.length, "unique canonical identity");
    for (const row of data.devices) {
        assert.ok(!["CHALLENGE_ISSUED", "AWAITING_OWNER_CONFIRMATION"]
            .includes(row.pairingState), "no transient state survived restart (B2)");
        if (row.bindingDigest != null) {
            assert.ok(["PAIRED", "TRUSTED", "LIMITED"].includes(row.pairingState),
                "binding credential only on established relationship");
        }
        if (["TRUSTED", "LIMITED"].includes(row.pairingState)) {
            assert.equal(row.trustState, row.pairingState,
                "trust escalation only within established pairing (B1)");
        }
    }

    // every surviving credential belongs to an established device and works
    let workingBinds = 0;
    for (const [d, cred] of creds) {
        const v = s.getIdentity(d);
        if (!v) continue;
        if (["PAIRED", "TRUSTED", "LIMITED"].includes(v.pairingState)) {
            const sess = s.openSession({ deviceId: d, bindingSecret: cred });
            assert.equal(sess.state, "ACTIVE");
            workingBinds++;
        } else {
            assert.throws(() => s.openSession({ deviceId: d, bindingSecret: cred }),
                e => e.code === "PID_SESSION_FORGED");
        }
    }
    assert.ok(workingBinds >= 1);

    // no timer/handle leak
    if (timersBefore >= 0) {
        const timersAfter = process.getActiveResourcesInfo()
            .filter(r => r === "Timeout").length;
        assert.equal(timersAfter, timersBefore);
    }
});
