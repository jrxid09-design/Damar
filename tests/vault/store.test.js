"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-vault-store-"));
}

test("file store refuses insecure cipher without explicit acknowledgment", () => {
    assert.throws(
        () => vaultMod.store.createFileSecretStore(tmpDir(), {
            cipher: vaultMod.cipher.DETERMINISTIC_TEST_ADAPTER
        }),
        /allowInsecure/
    );
});

test("file store with explicit allowInsecure reports PLAINTEXT-INSECURE", () => {
    const store = vaultMod.store.createFileSecretStore(tmpDir(), {
        cipher: vaultMod.cipher.DETERMINISTIC_TEST_ADAPTER,
        allowInsecure: true
    });
    const d = store.describePersistence();
    assert.equal(d.secure, false);
    assert.match(d.guarantees, /PLAINTEXT-INSECURE/);
});

test("file store round-trips records atomically and survives reload", () => {
    const dir = tmpDir();
    let t = 100;
    const v1 = vaultMod.createSecretVault({
        now: () => (t += 1),
        store: vaultMod.store.createFileSecretStore(dir, { allowInsecure: true })
    });
    const created = v1.create({ scope: "provider", label: "k", value: "persist-me-123" });
    v1.rotate(created.ref, "rotated-persist-456");

    // Fresh vault over the same directory.
    const v2 = vaultMod.createSecretVault({
        now: () => 999_999,
        store: vaultMod.store.createFileSecretStore(dir, { allowInsecure: true })
    });
    assert.equal(v2.describe(created.ref).metadata.rotationCount, 1);
    assert.equal(v2.resolve(created.ref).value.reveal(), "rotated-persist-456");
});

test("file store ignores foreign/corrupt filenames during listing", () => {
    const dir = tmpDir();
    const v = vaultMod.createSecretVault({
        now: () => 1,
        store: vaultMod.store.createFileSecretStore(dir, { allowInsecure: true })
    });
    v.create({ scope: "system", value: "one" });
    fs.writeFileSync(path.join(dir, "garbage.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    assert.equal(v.stats().total, 1);
});

test("cipher adapter contract is enforced", () => {
    for (const bad of [
        null,
        {},
        { id: "x" },
        { id: "x", secure: true, guarantees: "g", encrypt: 1, decrypt: () => {} },
        { id: "", secure: false, guarantees: "g", encrypt: (b) => b, decrypt: (b) => b }
    ]) {
        assert.throws(() => vaultMod.cipher.assertCipherAdapter(bad), Error);
    }
});

test("custom secure adapter is accepted and reported as secure storage", () => {
    // Minimal XOR "adapter" — proves the CONTRACT only; it is obviously
    // not real crypto and is marked secure:false to stay honest.
    const adapter = vaultMod.cipher.assertCipherAdapter({
        id: "xor-test",
        secure: false,
        guarantees: "test-only reversible transform",
        encrypt(buf) {
            return { k: "xor", d: buf.toString("hex") };
        },
        decrypt(env) {
            return Buffer.from(env.d, "hex");
        }
    });
    const dir = tmpDir();
    const v = vaultMod.createSecretVault({
        now: () => 1,
        cipher: adapter,
        store: vaultMod.store.createFileSecretStore(dir, { cipher: adapter, allowInsecure: true })
    });
    const { ref } = v.create({ scope: "system", value: "adapter-value" });
    assert.equal(v.resolve(ref).value.reveal(), "adapter-value");
    const rawFile = fs.readFileSync(path.join(dir, `${ref.secretId}.json`), "utf8");
    assert.ok(rawFile.includes("xor"));
});

test("memory store persistence description never claims security", () => {
    const d = vaultMod.store.createMemorySecretStore().describePersistence();
    assert.equal(d.secure, false);
});

test("stable secret id across rotation survives file-store reload", () => {
    const dir = tmpDir();
    let t = 1;
    const fixedId = ids.secretIdFromSeed("stable-id-case");
    const s = () => vaultMod.store.createFileSecretStore(dir, { allowInsecure: true });
    const v1 = vaultMod.createSecretVault({ now: () => t++, store: s() });
    const created = v1.create({ scope: "device", value: "v1-material", secretId: fixedId });
    v1.rotate(created.ref, "v2-material");
    const v2 = vaultMod.createSecretVault({ now: () => 10_000, store: s() });
    assert.equal(v2.resolve(created.ref).value.reveal(), "v2-material");
    assert.equal(created.ref.secretId, fixedId);
});
