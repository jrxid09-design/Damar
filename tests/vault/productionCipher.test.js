"use strict";

/**
 * Vault production AEAD cipher adapter tests (Trust Foundation stage).
 *
 * Proves the secure-at-rest boundary: round trip, no plaintext on disk,
 * non-determinism, tamper/wrong-key/corrupt/version rejection, no insecure
 * fallback, fail-closed key provenance, and that the existing Vault
 * file-persistence path works with the secure adapter (and refuses the
 * insecure one).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const { createProductionCipherAdapter, ENVELOPE_KIND } = require("../../src/runtime/vaultProviders/aesGcmCipher");
const { assertCipherAdapter } = require("../../src/runtime/vault/cipher");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "vault-prodcipher-"));
}

function freshKey() {
    return crypto.randomBytes(32);
}

test("production cipher: round trip restores the exact secret bytes", () => {
    const adapter = assertCipherAdapter(createProductionCipherAdapter({ keyMaterial: freshKey() }));
    const secret = Buffer.from("super-secret-token-12345", "utf8");
    const envelope = adapter.encrypt(secret);
    const back = adapter.decrypt(envelope);
    assert.deepEqual(back, secret);
});

test("production cipher: envelope is a versioned JSON object with no plaintext", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const secret = "pk_live_DO_NOT_LEAK_ME";
    const envelope = adapter.encrypt(Buffer.from(secret, "utf8"));
    assert.equal(envelope.k, ENVELOPE_KIND, "versioned envelope kind present");
    for (const field of ["iv", "tag", "d"]) {
        assert.equal(typeof envelope[field], "string", `envelope.${field} present`);
    }
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes(secret), false, "ciphertext must not contain plaintext");
    assert.equal(serialized.includes("DO_NOT_LEAK"), false);
});

test("production cipher: same plaintext yields different envelopes (random IV)", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const secret = Buffer.from("repeatable-plaintext", "utf8");
    const e1 = adapter.encrypt(secret);
    const e2 = adapter.encrypt(secret);
    assert.notEqual(JSON.stringify(e1), JSON.stringify(e2),
        "random per-envelope IV must make identical plaintext encrypt differently");
    assert.notEqual(e1.iv, e2.iv, "IVs differ");
    assert.deepEqual(adapter.decrypt(e1), adapter.decrypt(e2), "both decrypt to same plaintext");
});

test("production cipher: tampered ciphertext is rejected (integrity)", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const envelope = adapter.encrypt(Buffer.from("integrity-protected", "utf8"));
    const tampered = { ...envelope };
    const raw = Buffer.from(tampered.d, "base64");
    raw[0] = raw[0] ^ 0x01; // flip one bit in the ciphertext
    tampered.d = raw.toString("base64");
    assert.throws(() => adapter.decrypt(tampered), /integrity|malformed|failure/i);
});

test("production cipher: tampered auth tag is rejected", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const envelope = adapter.encrypt(Buffer.from("tag-protected", "utf8"));
    const raw = Buffer.from(envelope.tag, "base64");
    raw[0] = raw[0] ^ 0xff;
    const tampered = { ...envelope, tag: raw.toString("base64") };
    assert.throws(() => adapter.decrypt(tampered), /integrity|malformed|failure/i);
});

test("production cipher: wrong key is rejected (fails closed)", () => {
    const a1 = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const a2 = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const envelope = a1.encrypt(Buffer.from("key-bound-secret", "utf8"));
    assert.throws(() => a2.decrypt(envelope), /integrity|failure/i);
});

test("production cipher: truncated/corrupt envelope is rejected", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const envelope = adapter.encrypt(Buffer.from("truncate-me", "utf8"));
    const truncated = { ...envelope, d: envelope.d.slice(0, 4) };
    assert.throws(() => adapter.decrypt(truncated), /malformed|integrity|failure/i);
    assert.throws(() => adapter.decrypt({ k: ENVELOPE_KIND }), /malformed|integrity|failure/i);
    assert.throws(() => adapter.decrypt({}), /version|malformed|integrity|failure/i);
});

test("production cipher: unsupported envelope version is rejected", () => {
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const envelope = adapter.encrypt(Buffer.from("v1", "utf8"));
    const rolled = { ...envelope, k: "aead-gcm-v0" };
    assert.throws(() => adapter.decrypt(rolled), /version/i);
});

test("production cipher: no insecure fallback — construction fails closed without key material", () => {
    const savedEnv = process.env.DAMAR_VAULT_MASTER_KEY;
    delete process.env.DAMAR_VAULT_MASTER_KEY;
    try {
        assert.throws(() => createProductionCipherAdapter({}),
            (e) => e.code === "VAULT_CIPHER_REQUIRED",
            "must refuse to build a production cipher with no secure key material");
    } finally {
        if (savedEnv !== undefined) process.env.DAMAR_VAULT_MASTER_KEY = savedEnv;
    }
});

test("production cipher: rejects malformed key material", () => {
    assert.throws(() => createProductionCipherAdapter({ keyMaterial: "too-short" }),
        /key material|VAULT_CIPHER_REQUIRED/);
    assert.throws(() => createProductionCipherAdapter({ keyMaterial: Buffer.alloc(16) }),
        /key material|VAULT_CIPHER_REQUIRED/);
});

test("production cipher: key material via DAMAR_VAULT_MASTER_KEY env works (hex)", () => {
    const key = freshKey();
    const savedEnv = process.env.DAMAR_VAULT_MASTER_KEY;
    process.env.DAMAR_VAULT_MASTER_KEY = key.toString("hex");
    try {
        const adapter = createProductionCipherAdapter({});
        const envelope = adapter.encrypt(Buffer.from("env-key-secret", "utf8"));
        assert.deepEqual(adapter.decrypt(envelope), Buffer.from("env-key-secret", "utf8"));
    } finally {
        if (savedEnv !== undefined) process.env.DAMAR_VAULT_MASTER_KEY = savedEnv;
        else delete process.env.DAMAR_VAULT_MASTER_KEY;
    }
});

test("production cipher: key material via key file works", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, "master.key");
    fs.writeFileSync(keyFile, freshKey().toString("base64"), { mode: 0o600 });
    // TF-005: on Windows POSIX mode is not ACL protection — the key file is
    // accepted only via the platform-managed opt-in (same semantics as the
    // canonical composition and trustFoundationRepair tests).
    const adapter = createProductionCipherAdapter({
        keyFile,
        allowPlatformManagedKeyFile: process.platform === "win32" ? true : undefined
    });
    const envelope = adapter.encrypt(Buffer.from("file-key-secret", "utf8"));
    assert.deepEqual(adapter.decrypt(envelope), Buffer.from("file-key-secret", "utf8"));
    fs.rmSync(dir, { recursive: true, force: true });
});

test("production cipher: thrown errors never contain key material or plaintext", () => {
    const key = freshKey();
    const adapter = createProductionCipherAdapter({ keyMaterial: key });
    const secret = "sensitive-plaintext-xyz";
    const envelope = adapter.encrypt(Buffer.from(secret, "utf8"));
    const raw = Buffer.from(envelope.tag, "base64");
    raw[0] ^= 0x01;
    try {
        adapter.decrypt({ ...envelope, tag: raw.toString("base64") });
        assert.fail("should have thrown");
    } catch (error) {
        const text = `${error.message} ${error.code ?? ""}`;
        assert.equal(text.includes(secret), false, "no plaintext in error");
        assert.equal(text.includes(key.toString("hex")), false, "no key hex in error");
        assert.equal(text.includes(key.toString("base64")), false, "no key base64 in error");
    }
});

test("production cipher: file secret store accepts the secure adapter WITHOUT allowInsecure", () => {
    const dir = tmpDir();
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const store = vaultMod.store.createFileSecretStore(dir, { cipher: adapter });
    const secretId = "sec-" + "ab".repeat(16);
    const clear = Buffer.from("tok", "utf8");
    const rec = store.create({
        secretId,
        scope: { kind: "system", key: "" },
        status: "active",
        label: "tok",
        createdAt: Date.now(),
        rotationCount: 0,
        valueBytes: clear.length,
        valueDigest: vaultMod.digest.digestOfValue(clear),
        envelope: adapter.encrypt(clear)
    });
    assert.equal(rec.version, 1);
    const loaded = store.get(secretId);
    assert.deepEqual(adapter.decrypt(loaded.envelope), clear);
    assert.match(store.describePersistence().guarantees, /AES-256-GCM/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("production cipher: file secret store still rejects the insecure adapter by default", () => {
    assert.throws(() =>
        vaultMod.store.createFileSecretStore(tmpDir(), {
            cipher: vaultMod.cipher.DETERMINISTIC_TEST_ADAPTER
        }),
        /allowInsecure|VAULT_CIPHER_REQUIRED/,
        "production file persistence must refuse the insecure adapter without explicit allowInsecure");
});

test("production cipher: vault facade rotation + revocation remain working over the secure adapter", () => {
    const dir = tmpDir();
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const store = vaultMod.store.createFileSecretStore(dir, { cipher: adapter });
    const vault = vaultMod.createSecretVault({ store, cipher: adapter });

    const created = vault.create({ value: "initial-secret", scope: "system", label: "svc-key" });
    const ref = created.ref;
    const resolved = vault.resolve(ref);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.reveal(), "initial-secret");

    // Rotation: value changes; the reference path stays intact.
    vault.rotate(ref, "rotated-secret");
    const after = vault.resolve(ref);
    assert.equal(after.ok, true);
    assert.equal(after.value.reveal(), "rotated-secret");

    // Revocation: value destroyed; later resolve is denied.
    vault.revoke(ref);
    const afterRevoke = vault.resolve(ref);
    assert.equal(afterRevoke.ok, false, "revoked secret must not resolve");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("production cipher: vault metadata/records never leak plaintext", () => {
    const dir = tmpDir();
    const adapter = createProductionCipherAdapter({ keyMaterial: freshKey() });
    const store = vaultMod.store.createFileSecretStore(dir, { cipher: adapter });
    const vault = vaultMod.createSecretVault({ store, cipher: adapter });
    const secret = "no-leak-plaintext-999";
    const created = vault.create({ value: secret, scope: "system", label: "leak-check" });
    const rec = store.get(created.ref.secretId);
    const recJson = JSON.stringify(rec);
    assert.equal(recJson.includes(secret), false, "stored record must not contain plaintext");
    assert.equal(JSON.stringify(created.metadata).includes(secret), false,
        "metadata must not contain plaintext");
    // The persisted envelope itself must not contain plaintext.
    const rawFile = fs.readFileSync(require("node:path").join(dir, `${created.ref.secretId}.json`), "utf8");
    assert.equal(rawFile.includes(secret), false, "durable file must not contain plaintext");
    fs.rmSync(dir, { recursive: true, force: true });
});
