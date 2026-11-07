"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");
const { VaultError } = require("../../src/runtime/vault/errors");

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-vault-precond-"));
}

function forEachStore(description, run) {
    const backends = [
        { name: "memory", make: () => vaultMod.store.createMemorySecretStore() },
        { name: "file", make: () => vaultMod.store.createFileSecretStore(tmpDir(), { allowInsecure: true }) }
    ];
    for (const backend of backends) {
        test(`${backend.name}: ${description}`, () => run(backend.make));
    }
}

// =====================================================================
// CRITICAL PROBES — split create/update boundary (R32)
// =====================================================================

// 1. bare stale put after delete must fail
forEachStore("probe 1: bare stale put after delete is VAULT_CONFLICT", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-1");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    assert.throws(
        () => store.put(stale),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(store.get(S), null);
});

// 2. stale + expectedVersion 0 must fail (put is not create)
forEachStore("probe 2: stale put with expectedVersion:0 is VAULT_CONFLICT", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-2");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    assert.throws(
        () => store.put({ ...stale, expectedVersion: 0 }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(store.get(S), null);
});

// 3. store.create(stale canonical record) must be rejected, not resurrect
forEachStore("probe 3: create(stale canonical record) is rejected and does not resurrect", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-3");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    assert.throws(
        () => store.create({ ...stale }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(store.get(S), null);
});

// 3b. create intent carrying ANY store-owned lifecycle field is rejected
forEachStore("probe 3b: create intent carrying lifecycle fields is rejected", (makeStore) => {
    const store = makeStore();
    const S = ids.secretIdFromSeed("probe-3b");
    const intent = {
        secretId: S, scope: "system", status: "active", createdAt: 1000,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    };
    assert.throws(
        () => store.create({ ...intent, incarnationId: "inc-" + "0".repeat(32) }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.throws(
        () => store.create({ ...intent, version: 1 }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.throws(
        () => store.create({ ...intent, expectedVersion: 0 }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(store.get(S), null);
});

// 4. legitimate create after delete succeeds with a fresh incarnation
forEachStore("probe 4: legitimate create after delete succeeds with fresh incarnation", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-4");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: "system", value: "E-new", secretId: S });
    const fresh = store.get(S);
    assert.match(fresh.incarnationId, /^inc-[0-9a-f]{32}$/);
    assert.notEqual(fresh.incarnationId, stale.incarnationId);
    assert.equal(vault.resolve(c1.ref).value.reveal(), "E-new");
});

// 5. stale update after recreate must fail and E-new stays current
forEachStore("probe 5: stale update after recreate is VAULT_CONFLICT; E-new stays current", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-5");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: "system", value: "E-new", secretId: S });
    assert.throws(
        () => store.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(c1.ref).value.reveal(), "E-new");
});

// 6. current canonical + correct expectedVersion succeeds
forEachStore("probe 6: current canonical + correct expectedVersion updates successfully", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("probe-6");
    const c1 = vault.create({ scope: "system", value: "E-v0", secretId: S });
    const current = store.get(S);
    // Correct update: same incarnation, exact version.
    const updated = store.put({
        ...current,
        valueBytes: 4,
        valueDigest: "0".repeat(64),
        envelope: { k: "det-v1", d: "bmV3MQ==" },
        expectedVersion: current.version
    });
    assert.equal(updated.version, current.version + 1);
    assert.equal(updated.incarnationId, current.incarnationId);
});

// =====================================================================
// CREATE / PUT semantic boundaries
// =====================================================================

forEachStore("create requires absence and mints version 1", (makeStore) => {
    const store = makeStore();
    const S = ids.secretIdFromSeed("bound-1");
    const rec = store.create({
        secretId: S, scope: "system", status: "active", createdAt: 1000,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    });
    assert.equal(rec.version, 1);
    assert.match(rec.incarnationId, /^inc-[0-9a-f]{32}$/);
    // Second create of the same id fails.
    assert.throws(
        () => store.create({
            secretId: S, scope: "system", status: "active", createdAt: 1000,
            envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
        }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
});

forEachStore("put rejects missing/zero/negative/non-integer expectedVersion", (makeStore) => {
    const store = makeStore();
    const S = ids.secretIdFromSeed("bound-2");
    const rec = store.create({
        secretId: S, scope: "system", status: "active", createdAt: 1000,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    });
    const current = store.get(S);
    for (const ev of [undefined, null, 0, -1, 1.5, "1"]) {
        assert.throws(
            () => store.put({ ...current, expectedVersion: ev }),
            (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT",
            `expectedVersion=${String(ev)} must be rejected`
        );
    }
    // State unchanged after all rejections.
    assert.equal(store.get(S).version, 1);
});

forEachStore("put requires incarnation match even at correct version", (makeStore) => {
    const store = makeStore();
    const S = ids.secretIdFromSeed("bound-3");
    const rec = store.create({
        secretId: S, scope: "system", status: "active", createdAt: 1000,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    });
    // Forge a different incarnationId at the correct version.
    assert.throws(
        () => store.put({ ...rec, incarnationId: "inc-" + "f".repeat(32), expectedVersion: rec.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(store.get(S).incarnationId, rec.incarnationId);
});
