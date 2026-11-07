"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");

function makeVault(extra = {}) {
    let t = 500;
    return vaultMod.createSecretVault({ now: () => (t += 5), ...extra });
}

test("prototype pollution via create/rotate/import inputs is neutralized", () => {
    const vault = makeVault();
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"scope":"system","value":"x"}');
    vault.create(hostile);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(({}).polluted, undefined);
    // Constructor/config smuggle attempts are ignored, never honored.
    vault.create({ scope: "system", value: "y", constructor: { prototype: {} } });
    assert.equal(Object.prototype.polluted, undefined);
});

test("oversized secret value rejected before storage", () => {
    const vault = makeVault();
    assert.throws(() => vault.create({ scope: "system", value: "A".repeat(64 * 1024 + 1) }), /maximum size/);
    assert.equal(vault.stats().total, 0);
});

test("oversized identifiers and labels rejected", () => {
    const vault = makeVault();
    assert.throws(() => ids.assertSecretId("sec-" + "a".repeat(300)), /length|malformed/i);
    assert.throws(
        () => vault.create({ scope: "system", value: "v", label: "L".repeat(500) }),
        /maximum length/
    );
});

test("malformed SecretRef at every entry point fails closed", () => {
    const vault = makeVault();
    for (const bad of [
        "not-a-ref",
        "secretref:v1:short",
        { v: 1 },
        { secretId: "sec-zz", scope: "system" },
        () => {}
    ]) {
        assert.throws(() => vault.resolve(bad), Error);
        assert.throws(() => vault.describe(bad), Error);
    }
});

test("forged metadata cannot be injected through public APIs", () => {
    const vault = makeVault();
    const created = vault.create({ scope: "system", value: "real" });
    const before = vault.describe(created.ref).metadata;
    // Attempt to forge status/digest by importing over a live secret:
    // the vault must skip it and never downgrade live state.
    const result = vault.importRecoveryEvidence({
        secretId: created.ref.secretId,
        scope: created.ref.scope,
        status: "active",
        valueDigest: "f".repeat(64)
    });
    assert.equal(result.imported, false);
    const after = vault.describe(created.ref).metadata;
    assert.equal(after.valueDigest, before.valueDigest);
    assert.equal(after.status, before.status);
});

test("cross-scope reference resolution denied", () => {
    const vault = makeVault();
    const a = vault.create({ scope: { kind: "provider", key: "openrouter" }, value: "ka" });
    const b = vault.create({ scope: { kind: "device", key: "phone-1" }, value: "kb" });
    assert.equal(vault.resolveIn(a.ref.scope, b.ref).code, "VAULT_SCOPE_MISMATCH");
    assert.equal(vault.resolveIn(b.ref.scope, a.ref).code, "VAULT_SCOPE_MISMATCH");
});

test("revoked reference stays revoked under repeated resolution", () => {
    const vault = makeVault();
    const { ref } = vault.create({ scope: "system", value: "dying" });
    vault.revoke(ref);
    for (let i = 0; i < 5; i++) {
        const r = vault.resolve(ref);
        assert.equal(r.ok, false);
        assert.equal(r.code, "VAULT_REVOKED");
    }
});

test("rotation race: interleaved rotations keep state consistent", async () => {
    const vault = makeVault();
    const { ref } = vault.create({ scope: "system", value: "gen-0" });
    // Fire concurrent rotations; JS serializes sync bodies, but each must
    // complete atomically and leave a resolvable consistent value.
    await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
            Promise.resolve().then(() => vault.rotate(ref, `gen-${i + 1}`))
        )
    );
    const meta = vault.describe(ref).metadata;
    assert.equal(meta.rotationCount, 8);
    const final = vault.resolve(ref).value.reveal();
    assert.match(final, /^gen-[1-8]$/);
});

test("stale-version rotation race loses cleanly without partial update", () => {
    const vault = makeVault();
    const { ref } = vault.create({ scope: "system", value: "stable" });
    const version = vault.describe(ref).metadata ? 1 : 1;
    vault.rotate(ref, "winner"); // bumps version
    assert.throws(() => vault.rotate(ref, "loser-stale", { expectedVersion: version }), /concurrent/);
    assert.equal(vault.resolve(ref).value.reveal(), "winner");
});

test("delete/resolve race never yields empty-string success or partial state", async () => {
    const vault = makeVault();
    const { ref } = vault.create({ scope: "system", value: "racy-value" });
    const outcomes = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
            Promise.resolve().then(() => {
                if (i === 7) {
                    try { vault.deleteSecret(ref); } catch (_) { /* raced */ }
                    return "deleted";
                }
                const r = vault.resolve(ref);
                return r.ok ? r.value.reveal() : `denied:${r.code}`;
            })
        )
    );
    for (const outcome of outcomes) {
        if (outcome === "deleted") continue;
        assert.ok(outcome === "racy-value" || outcome === "denied:VAULT_NOT_FOUND", outcome);
    }
    assert.equal(vault.resolve(ref).code, "VAULT_NOT_FOUND");
});

test("corrupt stored record fails integrity check without leaking", () => {
    const real = vaultMod.store.createMemorySecretStore();
    const vault = makeVault({ store: real });
    const { ref } = vault.create({ scope: "system", value: "integrity-check-me" });
    // Tamper with the stored record (simulated bit-rot / hostile disk).
    const rec = real.get(ref.secretId);
    const forgedDigest = "0".repeat(64);
    const tampered = { ...rec, valueDigest: forgedDigest };
    const proxyStore = {
        get: (id) => (id === ref.secretId ? vaultMod.record.buildSecretRecord(tampered) : real.get(id)),
        put: (r) => real.put(r),
        delete: (id) => real.delete(id),
        listIds: () => real.listIds(),
        describePersistence: () => real.describePersistence()
    };
    const v2 = makeVault({ store: proxyStore });
    const r = v2.resolve(ref);
    assert.equal(r.ok, false);
    assert.equal(r.code, "VAULT_STORE_FAILURE");
    assert.ok(!JSON.stringify(r).includes("integrity-check-me"));
});

test("hostile scope keys rejected", () => {
    const vault = makeVault();
    for (const bad of [
        { kind: "provider", key: "../etc" },
        { kind: "provider", key: "k".repeat(65) },
        { kind: "root-everything" },
        { kind: "provider", key: { $gt: "" } }
    ]) {
        assert.throws(() => vault.create({ scope: bad, value: "x" }), Error);
    }
});
