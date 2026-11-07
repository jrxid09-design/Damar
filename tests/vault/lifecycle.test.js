"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");
const { VAULT_ERROR_CODES } = require("../../src/runtime/vault/errors");

function makeVault() {
    let t = 1_000;
    return {
        vault: vaultMod.createSecretVault({ now: () => (t += 10) }),
        advance: (ms) => { t += ms; }
    };
}

test("create returns ref + metadata; value never appears in either", () => {
    const { vault } = makeVault();
    const { ref, metadata } = vault.create({
        scope: { kind: "provider", key: "openrouter" },
        label: "llm-key",
        value: "sk-live-abcdef123456"
    });
    assert.match(ref.secretId, /^sec-[0-9a-f]{32}$/);
    assert.equal(JSON.stringify([ref, metadata]).includes("sk-live-abcdef123456"), false);
    assert.equal(metadata.status, "active");
    assert.equal(metadata.rotationCount, 0);
    assert.ok(metadata.valueDigest.match(/^[0-9a-f]{64}$/));
});

test("describe is metadata-only and distinct from resolve", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "system", value: "v-1" });
    const d = vault.describe(ref);
    assert.equal(d.ok, true);
    assert.equal(d.metadata.valueBytes, 3);
    // Describe result has no value field at all.
    assert.equal("value" in d, false);
});

test("resolve is the only disclosure path and returns a SecretValue", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "device", key: "pair-x", value: "pair-material-42" });
    const r = vault.resolve(ref);
    assert.equal(r.ok, true);
    assert.equal(r.value.reveal(), "pair-material-42");
});

test("rotation keeps SecretId stable, replaces value atomically, counts rotation", () => {
    const { vault } = makeVault();
    const created = vault.create({ scope: "transport", label: "wa", value: "session-old" });
    const id0 = created.ref.secretId;
    const rotated = vault.rotate(created.ref, "session-new");
    assert.equal(rotated.ref.secretId, id0);
    assert.equal(rotated.metadata.rotationCount, 1);
    assert.ok(rotated.metadata.rotatedAt > created.metadata.createdAt);
    const r = vault.resolve(created.ref);
    assert.equal(r.value.reveal(), "session-new");
    assert.notEqual(r.value.reveal(), "session-old");
});

test("stale-version rotation conflicts and leaves old state fully intact", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "system", value: "original" });
    // Force a stale optimistic version.
    assert.throws(
        () => vault.rotate(ref, "hostile", { expectedVersion: 99 }),
        /concurrent modification/
    );
    assert.equal(vault.resolve(ref).value.reveal(), "original");
    assert.equal(vault.describe(ref).metadata.rotationCount, 0);
});

test("revoked secrets do not resolve but refs remain meaningful", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "provider", value: "to-die" });
    vault.revoke(ref);
    const d = vault.describe(ref);
    assert.equal(d.ok, true);
    assert.equal(d.metadata.status, "revoked");
    const r = vault.resolve(ref);
    assert.equal(r.ok, false);
    assert.equal(r.code, VAULT_ERROR_CODES.VAULT_REVOKED);
    // Revocation must NOT degrade to empty string anywhere.
    assert.equal(r.value, undefined);
});

test("revocation destroys the stored envelope and digest", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "system", value: "gone-soon" });
    vault.revoke(ref);
    const meta = vault.describe(ref).metadata;
    assert.equal(meta.valueDigest, null);
    assert.equal(meta.valueBytes, 0);
});

test("delete removes record; later lookups are NOT_FOUND, never empty string", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "project", value: "temp" });
    assert.equal(vault.deleteSecret(ref), true);
    assert.deepEqual(vault.describe(ref), { ok: false, code: VAULT_ERROR_CODES.VAULT_NOT_FOUND });
    const r = vault.resolve(ref);
    assert.equal(r.ok, false);
    assert.equal(r.code, VAULT_ERROR_CODES.VAULT_NOT_FOUND);
    assert.equal(r.value ?? "", "");
    assert.notEqual(r.message, "");
});

test("unknown secret resolution is denied, not defaulted", () => {
    const { vault } = makeVault();
    const ghost = vaultMod.refs.buildSecretRef({ secretId: ids.newSecretId(), scope: "system" });
    const r = vault.resolve(ghost);
    assert.equal(r.code, VAULT_ERROR_CODES.VAULT_NOT_FOUND);
});

test("scoped resolution refuses cross-scope lookup", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: { kind: "provider", key: "openrouter" }, value: "k" });
    const wrong = vault.resolveIn({ kind: "extension", key: "weather" }, ref);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, VAULT_ERROR_CODES.VAULT_SCOPE_MISMATCH);
    const right = vault.resolveIn({ kind: "provider", key: "openrouter" }, ref);
    assert.equal(right.ok, true);
});

test("secret count bound enforced", () => {
    const v = vaultMod.createSecretVault({ config: { maxSecrets: 3 }, now: () => 1 });
    for (let i = 0; i < 3; i++) {
        v.create({ scope: "system", value: `v${i}` });
    }
    assert.throws(() => v.create({ scope: "system", value: "overflow" }), /bound reached/);
});

test("evidence view exposes refs + metadata only", () => {
    const { vault } = makeVault();
    vault.create({ scope: "provider", label: "l1", value: "SECRETVALUE-X" });
    const view = JSON.stringify(vault.evidenceView());
    assert.ok(view.includes("sec-"));
    assert.ok(!view.includes("SECRETVALUE-X"));
});

test("recovery import: evidence restores as evidence, never active", () => {
    const { vault } = makeVault();
    const { ref, metadata } = vault.create({ scope: "device", value: "live-now" });
    const fresh = vaultMod.createSecretVault({ now: () => 5_000 });
    const imported = fresh.importRecoveryEvidence({
        secretId: ref.secretId,
        scope: ref.scope,
        label: "from-capsule",
        createdAt: metadata.createdAt
    });
    assert.equal(imported.imported, true);
    assert.equal(imported.metadata.status, "evidence");
    const r = fresh.resolve(ref);
    assert.equal(r.ok, false);
    assert.equal(r.code, VAULT_ERROR_CODES.VAULT_UNAVAILABLE);
});

test("recovery cannot resurrect a revoked secret as active", () => {
    const { vault } = makeVault();
    const { ref } = vault.create({ scope: "system", value: "will-revoke" });
    vault.revoke(ref);
    const evidenceView = vault.evidenceView().find((e) => e.ref.secretId === ref.secretId);
    const fresh = vaultMod.createSecretVault({ now: () => 9_000 });
    fresh.importRecoveryEvidence({
        secretId: ref.secretId,
        scope: ref.scope,
        status: evidenceView.metadata.status
    });
    assert.equal(fresh.describe(ref).metadata.status, "evidence");
    assert.equal(fresh.resolve(ref).ok, false);
});

test("recovery evidence carrying raw value material is rejected outright", () => {
    const fresh = vaultMod.createSecretVault({ now: () => 1 });
    for (const hostile of [
        { secretId: ids.newSecretId(), scope: "system", value: "STALE-CRED" },
        { secretId: ids.newSecretId(), scope: "system", cleartext: "STALE-CRED" },
        { secretId: ids.newSecretId(), scope: "system", envelope: { k: "det-v1", d: "U1RBTEUtQ1JFRA==" } },
        { secretId: ids.newSecretId(), scope: "system", token: "tok" }
    ]) {
        assert.throws(() => fresh.importRecoveryEvidence(hostile), /raw value material/);
    }
});

test("duplicate explicit secretId rejected; normalized duplicates collide too", () => {
    const { vault } = makeVault();
    const fixed = ids.secretIdFromSeed("dup-test");
    vault.create({ scope: "system", value: "first", secretId: fixed });
    assert.throws(() => vault.create({ scope: "system", value: "second", secretId: fixed }), /duplicate|exists|UNIQUE/i);
    assert.throws(
        () => vault.create({ scope: "system", value: "third", secretId: fixed.toUpperCase() }),
        Error
    );
});
