"use strict";

/**
 * STAGE 11 — trusted cross-channel continuity linker.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
    composeOwnerTrustForTest,
    canonicalChallenge,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
} = require("../../src/authority/ownerTrustComposition");

function pem(kp) {
    return kp.publicKey.export({ type: "spki", format: "pem" });
}

async function makeComposed() {
    const comp = await composeOwnerTrustForTest({ stateFile: null });
    const b = await comp.firstOwnerBootstrap.begin({ principalId: "owner-ardi" });
    await comp.firstOwnerBootstrap.complete({ ceremonyId: b.ceremonyId });
    const kp = crypto.generateKeyPairSync("ed25519");
    await comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live", publicKeyPem: pem(kp) }
    });
    const testMint = comp.testMint;
    // testMintAll: derive live provenance for a list of session keys
    // (`channel:<kanal>:<kind>:<peer>` -> mint for that transport peer).
    const testMintAll = (keys) => keys.map((key) => {
        const parts = String(key).split(":");
        if (parts.length < 4 || parts[0] !== "channel") return null;
        const channel = parts[1];
        const peer = parts.slice(3).join(":");
        if (channel === "telegram") return testMint.telegram(peer);
        if (channel === "whatsapp") return testMint.whatsapp(peer);
        if (channel === "console") return testMint.console(peer);
        return null; // non-linkable channel: no provenance possible
    });
    return { comp, ownerKey: kp, testMint, testMintAll };
}

function ownerProof({ comp, ownerKey }, purpose = "owner-proof") {
    const ch = comp.proofVerifier.issueChallenge({ purpose, credentialId: "cred-live" });
    const signature = crypto.sign(null, canonicalChallenge({
        purpose, credentialId: "cred-live", nonce: ch.nonce, context: ch.context
    }), ownerKey.privateKey);
    return { nonce: ch.nonce, signature: signature.toString("base64url") };
}

const OWNER_KEYS = [
    "channel:telegram:dm:12345",
    "channel:whatsapp:dm:62812@s.whatsapp.net"
];

async function bindOwnerPeers(ctx) {
    const B = ctx.comp.channelBinders;
    await B.telegram.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.telegram("12345") });
    await B.whatsapp.bind({ proof: ownerProof(ctx), purpose: "owner-proof", provenance: ctx.testMint.whatsapp("62812@s.whatsapp.net") });
}

test("cross-channel linking is DISABLED by default; no caller option can enable it", async () => {
    const ctx = await makeComposed();
    await bindOwnerPeers(ctx);
    const L = ctx.comp.continuityLinker;
    assert.deepEqual(L.getLinkPolicy(), { enabled: false, generation: 0 });
    // Even with both peers bound and authenticated, linking fails while disabled.
    assert.equal(L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) }).code, "OT_LINK_POLICY_DISABLED");
});

test("enabling the policy requires an authenticated Owner proof (model/caller cannot flip it)", async () => {
    const ctx = await makeComposed();
    const L = ctx.comp.continuityLinker;
    for (const proof of [null, undefined, {}, { nonce: "x", signature: "y" }, "owner-ardi"]) {
        await assert.rejects(() => L.setLinkPolicy({ proof, enabled: true }),
            (e) => String(e.code).startsWith("OT_"));
    }
    assert.equal(L.getLinkPolicy().enabled, false);
    // Owner enables it with a genuine proof.
    const pol = await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    assert.equal(pol.enabled, true);
    assert.equal(pol.generation, 1);
});

test("link authorization: same verified principal across channels -> one-use expiring authorization", async () => {
    const ctx = await makeComposed();
    await bindOwnerPeers(ctx);
    const L = ctx.comp.continuityLinker;
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    const auth = L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) });
    assert.equal(auth.ok, true);
    assert.equal(auth.principalId, "owner-ardi");
    assert.ok(auth.linkId);
    // Exactly-once consumption, from the LIVE consuming channel.
    const live = ctx.testMintAll(OWNER_KEYS);
    assert.equal(L.consumeLink({ linkId: auth.linkId, provenance: live[0] }).ok, true);
    assert.equal(L.consumeLink({ linkId: auth.linkId, provenance: live[1] }).code, "OT_LINK_REPLAY");
});

test("SESSION CONTINUITY != AUTHENTICATION: an unbound/revoked peer fails the whole link", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    const L = ctx.comp.continuityLinker;
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    await bindOwnerPeers(ctx);
    // One unbound peer -> whole link rejected.
    assert.equal(L.authorizeLink({
        sessionKeys: ["channel:telegram:dm:12345", "channel:whatsapp:dm:62899@s.whatsapp.net"],
        provenances: ctx.testMintAll(["channel:telegram:dm:12345", "channel:whatsapp:dm:62899@s.whatsapp.net"])
    }).code, "OT_PEER_NOT_BOUND");
    // Revoke one binding -> link fails again.
    const bindings = ctx.comp.registry.bindingsFor("owner-ardi");
    await ctx.comp.registry.revokeBinding({ bindingId: bindings[0].bindingId });
    const auth = L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) });
    assert.equal(auth.ok, false);
});

test("cross-PRINCIPAL linking is forbidden outright", async () => {
    const ctx = await makeComposed();
    const B = ctx.comp.channelBinders;
    const L = ctx.comp.continuityLinker;
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    await bindOwnerPeers(ctx);
    const kpA = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.addAdmin({
        principalId: "admin-1", delegatedBy: "owner-ardi",
        credential: { credentialId: "cred-admin", publicKeyPem: pem(kpA) }
    });
    const ch = ctx.comp.proofVerifier.issueChallenge({ purpose: "admin-proof", credentialId: "cred-admin" });
    const adminSig = crypto.sign(null, canonicalChallenge({
        purpose: "admin-proof", credentialId: "cred-admin", nonce: ch.nonce, context: ch.context
    }), kpA.privateKey);
    await B.telegram.bind({
        proof: { nonce: ch.nonce, signature: adminSig.toString("base64url") },
        purpose: "admin-proof", provenance: ctx.testMint.telegram("777")
    });
    const auth = L.authorizeLink({
        sessionKeys: ["channel:telegram:dm:12345", "channel:telegram:dm:777"],
        provenances: ctx.testMintAll(["channel:telegram:dm:12345", "channel:telegram:dm:777"])
    });
    assert.equal(auth.ok, false);
    assert.equal(auth.code, "OT_LINK_PRINCIPAL_MISMATCH");
});

test("PERSISTED TRUST != LIVE AUTHENTICATION: credential rotation stales outstanding links", async () => {
    const ctx = await makeComposed();
    await bindOwnerPeers(ctx);
    const L = ctx.comp.continuityLinker;
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    const auth = L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) });
    assert.equal(auth.ok, true);
    // Rotation: new bindings must fail live re-authentication -> authorize fails...
    const kp2 = crypto.generateKeyPairSync("ed25519");
    await ctx.comp.registry.rotateCredential({
        principalId: "owner-ardi",
        newCredential: { credentialId: "cred-live2", publicKeyPem: pem(kp2) }
    });
    assert.equal(L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) }).code, "OT_GENERATION_STALE");
    // ...and the previously issued authorization is revoked on consumption.
    assert.equal(L.consumeLink({ linkId: auth.linkId }).code, "OT_LINK_REVOKED");
});

test("disabling the policy invalidates ALL outstanding link authorizations", async () => {
    const ctx = await makeComposed();
    await bindOwnerPeers(ctx);
    const L = ctx.comp.continuityLinker;
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    const auth = L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) });
    assert.equal(auth.ok, true);
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: false });
    assert.equal(L.consumeLink({ linkId: auth.linkId }).code, "OT_LINK_UNKNOWN");
    assert.equal(L.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) }).code, "OT_LINK_POLICY_DISABLED");
});

test("non-linkable channels and malformed keys fail closed; bounds enforced", async () => {
    const ctx = await makeComposed();
    const L = ctx.comp.continuityLinker;
    await bindOwnerPeers(ctx);
    await L.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    // voice/companion have no canonical binder
    assert.equal(L.authorizeLink({
        sessionKeys: ["channel:voice:dm:x", "channel:telegram:dm:12345"],
        provenances: ctx.testMintAll(["channel:voice:dm:x", "channel:telegram:dm:12345"])
    }).code, "OT_CHANNEL_NOT_LINKABLE");
    // malformed grammar
    assert.equal(L.authorizeLink({ sessionKeys: ["not-a-key", "channel:telegram:dm:12345"], provenances: ctx.testMintAll(["not-a-key", "channel:telegram:dm:12345"]) }).code,
        "OT_SESSION_KEY_INVALID");
    assert.equal(L.authorizeLink({ sessionKeys: ["channel:telegram:group:12345", "channel:telegram:dm:12345"], provenances: ctx.testMintAll(["channel:telegram:group:12345", "channel:telegram:dm:12345"]) }).ok,
        true); // group kind is valid grammar
    // bounds: fewer than 2 or more than 4 sessions
    assert.equal(L.authorizeLink({ sessionKeys: ["channel:telegram:dm:12345"] }).code, "OT_LINK_BOUND");
    assert.equal(L.authorizeLink({
        sessionKeys: [...Array(5)].map((_, i) => `channel:telegram:dm:${i}`)
    }).code, "OT_LINK_BOUND");
    assert.equal(L.authorizeLink({ sessionKeys: "not-an-array", provenances: [] }).code, "OT_LINK_INVALID");
});

test("link expiry: an authorization past its TTL fails closed", async () => {
    const ctx = await makeComposed();
    await bindOwnerPeers(ctx);
    // Use a controllable clock through a fresh linker over the same bindings.
    const { createContinuityLinker } = require("../../src/authority/ownerTrust");
    let now = 1_000_000;
    const L2 = createContinuityLinker({
        registry: ctx.comp.registry,
        principalBindings: ctx.comp.principalBindings,
        clock: () => now
    });
    await L2.setLinkPolicy({ proof: ownerProof(ctx), enabled: true });
    const auth = L2.authorizeLink({ sessionKeys: OWNER_KEYS, provenances: ctx.testMintAll(OWNER_KEYS) });
    assert.equal(auth.ok, true);
    now += 61_000;
    assert.equal(L2.consumeLink({ linkId: auth.linkId }).code, "OT_LINK_EXPIRED");
});
