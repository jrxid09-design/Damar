const test = require("node:test");
const assert = require("node:assert");

/**
 * Canonical device identity semantics (I§5).
 *
 * deviceId immutable & canonical; displayName editable metadata;
 * duplicate names allowed; names never security identity.
 */

const emb = require("../../src/embodiment");
const { createIdentityService } = emb;

const T0 = 1_000_000;

function svc() {
    return createIdentityService({ clock: emb.manualClock(T0), config: { challengeTtlMs: 60_000, pairingTtlMs: 300_000 } });
}

test("I-1: deviceId canonical, validated, survives rename", () => {
    const s = svc();
    const { deviceId, created } = s.registerIdentity({
        namespace: "pair", stableKey: "iphone-abc", displayName: "My iPhone"
    });
    assert.equal(created, true);
    assert.match(deviceId, /^pair:[A-Za-z0-9._:+@{}\-]+$/);

    const before = s.getIdentity(deviceId).deviceId;
    s.rename(deviceId, "Phone Jrx");
    assert.equal(s.getIdentity(deviceId).deviceId, before);
    assert.equal(s.getIdentity(deviceId).displayName, "Phone Jrx");
});

test("I-2: re-register same namespace/stableKey returns SAME identity (no fork)", () => {
    const s = svc();
    const a = s.registerIdentity({ namespace: "bt", stableKey: "aa:bb", displayName: "One" });
    const b = s.registerIdentity({ namespace: "bt", stableKey: "aa:bb", displayName: "Two" });
    assert.equal(a.deviceId, b.deviceId);
    assert.equal(b.created, false);
});

test("I-3: duplicate display names allowed; name is not identity", () => {
    const s = svc();
    const a = s.registerIdentity({ namespace: "x", stableKey: "1", displayName: "Same" });
    const b = s.registerIdentity({ namespace: "x", stableKey: "2", displayName: "Same" });
    assert.notEqual(a.deviceId, b.deviceId);
    assert.equal(a.identity.displayName, b.identity.displayName);
});

test("I-4: invalid deviceId sources rejected fail-closed", () => {
    const s = svc();
    for (const bad of [
        { namespace: "Bad Namespace", stableKey: "k" },
        { namespace: "", stableKey: "k" },
        { namespace: "ok", stableKey: "" },
        { namespace: null, stableKey: "k" }
    ]) {
        assert.throws(() => s.registerIdentity({ ...bad, displayName: "n" }),
            undefined, JSON.stringify(bad));
    }
});

test("I-5: observed capabilities are whitelist-only and bounded", () => {
    const s = svc();
    const { deviceId } = s.registerIdentity({ namespace: "x", stableKey: "c" });
    s.observeCapabilities(deviceId, ["camera", "microphone", "warp_drive", "__proto__", 42]);
    assert.deepEqual(s.getIdentity(deviceId).observedCapabilities, ["camera", "microphone"]);
    // oversized list clamps to vocabulary bound
    s.observeCapabilities(deviceId, Object.keys(emb.identityTypes.OBSERVED_CAPABILITIES));
    assert.ok(s.getIdentity(deviceId).observedCapabilities.length <= 8);
});

test("I-6: presence observational only — offline never mutates pairing/trust", () => {
    const s = svc();
    const { deviceId } = s.registerIdentity({ namespace: "x", stableKey: "p" });
    s.setPresence(deviceId, "OFFLINE");
    let v = s.getIdentity(deviceId);
    assert.equal(v.presence, "OFFLINE");
    assert.equal(v.pairingState, "UNPAIRED");
    assert.equal(v.trustState, "UNKNOWN");

    // pair fully
    const p = s.beginPairing(deviceId);
    s.submitChallenge({ pairingId: p.pairingId, challengeId: p.challenge.challengeId, secret: p.challenge.secret });
    s.ownerConfirm(p.pairingId);
    s.setPresence(deviceId, "OFFLINE");
    v = s.getIdentity(deviceId);
    assert.equal(v.presence, "OFFLINE");
    assert.equal(v.pairingState, "PAIRED");     // offline != revoked
    assert.equal(v.trustState, "PAIRED");
});

test("I-7: bodyRelation enum closed; unknown rejected", () => {
    const s = svc();
    const { deviceId } = s.registerIdentity({ namespace: "x", stableKey: "r" });
    s.setBodyRelation(deviceId, "COMPANION");
    assert.equal(s.getIdentity(deviceId).bodyRelation, "COMPANION");
    assert.throws(() => s.setBodyRelation(deviceId, "OWNER_OF_UNIVERSE"));
});

test("I-8: identity views are frozen — no writable path from outside", () => {
    const s = svc();
    const { deviceId } = s.registerIdentity({ namespace: "x", stableKey: "f" });
    const v = s.getIdentity(deviceId);
    // frozen in non-strict mode: writes are silent no-ops at best
    try { v.trustState = "TRUSTED"; } catch { /* strict-mode throw is fine */ }
    assert.equal(v.trustState, "UNKNOWN");
    try { v.observedCapabilities.push("camera"); } catch { /* fine */ }
    assert.deepEqual(v.observedCapabilities, []);
    const list = s.listIdentities();
    try { list.push({ fake: true }); } catch { /* fine */ }
    assert.equal(list.length, 1);
});

test("I-9: bounds enforced — maxDevices, display-name length, metadata size/pollution", () => {
    const s = createIdentityService({
        clock: emb.manualClock(T0),
        config: { maxDevices: 2, maxMetadataFields: 2, maxDisplayNameLength: 10 }
    });
    s.registerIdentity({ namespace: "x", stableKey: "1" });
    s.registerIdentity({ namespace: "x", stableKey: "2" });
    assert.throws(() => s.registerIdentity({ namespace: "x", stableKey: "3" }),
        e => e.code === "PID_TOO_MANY_DEVICES");

    assert.throws(() =>
        s.rename("x:1", "a".repeat(11)), e => e.code === "PID_DISPLAY_NAME_TOO_LONG");

    // metadata checks use an unbound service so device-cap doesn't mask them
    const m = createIdentityService({ clock: emb.manualClock(T0), config: { maxMetadataFields: 2 } });
    assert.throws(() => m.registerIdentity({
        namespace: "y", stableKey: "m", displayName: "ok",
        metadata: { a: 1, b: 2, c: 3 }
    }), e => e.code === "PID_METADATA_TOO_LARGE");

    assert.throws(() => m.registerIdentity({
        namespace: "y", stableKey: "pp", displayName: "ok",
        metadata: JSON.parse('{"__proto__": {"x": 1}}')
    }), e => e.code === "PID_INVALID_METADATA");

    const s2 = svc();
    assert.doesNotThrow(() => s2.registerIdentity({
        namespace: "y", stableKey: "dupname", displayName: "d".repeat(120)
    }));
});
