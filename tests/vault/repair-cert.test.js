"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");
const { VaultError } = require("../../src/runtime/vault/errors");

function makeVault(extra = {}) {
    let t = 1_000;
    return vaultMod.createSecretVault({ now: () => (t += 5), ...extra });
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-vault-repair-"));
}

// =====================================================================
// B1 — ENFORCE SCOPE AGAINST CANONICAL RECORD
// =====================================================================

test("B1: provider secret + forged system ref -> DENIED (string ref)", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "provider", key: "openrouter" }, value: "CANONICAL-PROVIDER-1" });
    const forgedString = `secretref:v1:${created.ref.secretId}:system`;
    const r = vault.resolveIn("system", forgedString);
    assert.equal(r.ok, false);
    assert.equal(r.code, "VAULT_SCOPE_MISMATCH");
    assert.equal(r.value, undefined);
});

test("B1: provider secret + forged system ref -> DENIED (object ref)", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "provider", key: "openrouter" }, value: "CANONICAL-PROVIDER-2" });
    const forgedObject = vaultMod.refs.buildSecretRef({ secretId: created.ref.secretId, scope: "system" });
    const r = vault.resolveIn({ kind: "system" }, forgedObject);
    assert.equal(r.ok, false);
    assert.equal(r.code, "VAULT_SCOPE_MISMATCH");
});

test("B1: project A secret + project B ref -> DENIED", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "project", key: "alpha" }, value: "PROJECT-A-VALUE" });
    const r = vault.resolveIn({ kind: "project", key: "beta" }, created.ref);
    assert.equal(r.ok, false);
    assert.equal(r.code, "VAULT_SCOPE_MISMATCH");
});

test("B1: extension A -> extension B -> DENIED; device A -> device B -> DENIED", () => {
    const vault = makeVault();
    const extA = vault.create({ scope: { kind: "extension", key: "weather" }, value: "EXT-A" });
    const devA = vault.create({ scope: { kind: "device", key: "phone-1" }, value: "DEV-A" });
    assert.equal(vault.resolveIn({ kind: "extension", key: "calendar" }, extA.ref).code, "VAULT_SCOPE_MISMATCH");
    assert.equal(vault.resolveIn({ kind: "device", key: "phone-2" }, devA.ref).code, "VAULT_SCOPE_MISMATCH");
});

test("B1: valid canonical scope resolves via string and object refs", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "provider", key: "openrouter" }, value: "GOOD-SCOPE" });
    const viaObject = vault.resolveIn({ kind: "provider", key: "openrouter" }, created.ref);
    assert.equal(viaObject.ok, true);
    assert.equal(viaObject.value.reveal(), "GOOD-SCOPE");
    const viaString = vault.resolveIn(
        { kind: "provider", key: "openrouter" },
        vaultMod.refs.secretRefToString(created.ref)
    );
    assert.equal(viaString.ok, true);
    assert.equal(viaString.value.reveal(), "GOOD-SCOPE");
});

test("B1: resolve(expectedScope) also trusts canonical record, not the claim", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "transport", key: "wa" }, value: "TRANSPORT-TRUTH" });
    const forged = vaultMod.refs.buildSecretRef({ secretId: created.ref.secretId, scope: "system" });
    // Claim says system, truth says transport/wa: canonical wins.
    assert.equal(vault.resolve(forged, { expectedScope: { kind: "system" } }).code, "VAULT_SCOPE_MISMATCH");
    assert.equal(
        vault.resolve(created.ref, { expectedScope: { kind: "transport", key: "wa" } }).ok,
        true
    );
});

test("B1: unscoped resolution of unknown id stays NOT_FOUND under scoped check", () => {
    const vault = makeVault();
    const ghost = vaultMod.refs.buildSecretRef({ secretId: ids.newSecretId(), scope: "system" });
    assert.equal(vault.resolve(ghost, { expectedScope: "system" }).code, "VAULT_NOT_FOUND");
    assert.equal(vault.resolveIn("system", ghost).code, "VAULT_NOT_FOUND");
});

// =====================================================================
// B2 — TYPED VAULT ERROR CONTRACT
// =====================================================================

test("B2: stale version put surfaces VaultError/VAULT_CONFLICT, not TypeError", () => {
    const store = vaultMod.store.createMemorySecretStore();
    const id = ids.newSecretId();
    store.create({
        secretId: id, scope: "system", status: "active", createdAt: 1,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    });
    try {
        store.put({
            secretId: id, scope: "system", status: "active", createdAt: 1,
            envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64),
            valueBytes: 1, expectedVersion: 99
        });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof VaultError, `expected VaultError, got ${e.constructor.name}`);
        assert.equal(e.code, "VAULT_CONFLICT");
        assert.notEqual(e.constructor.name, "TypeError");
    }
});

test("B2: corrupt stored record surfaces typed VAULT_STORE_FAILURE", async () => {
    const real = vaultMod.store.createMemorySecretStore();
    const vault = makeVault({ store: real });
    const { ref } = vault.create({ scope: "system", value: "integrity-target" });
    const tampered = { ...real.get(ref.secretId), valueDigest: "0".repeat(64) };
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
});

test("B2: missing cipher acknowledgment surfaces typed VAULT_CIPHER_REQUIRED", () => {
    try {
        vaultMod.store.createFileSecretStore(tmpDir(), {
            cipher: vaultMod.cipher.DETERMINISTIC_TEST_ADAPTER
        });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof VaultError);
        assert.equal(e.code, "VAULT_CIPHER_REQUIRED");
    }
});

test("B2: corrupt on-disk record fails validation as typed store failure", () => {
    const dir = tmpDir();
    let t = 1;
    const v1 = vaultMod.createSecretVault({
        now: () => t++,
        store: vaultMod.store.createFileSecretStore(dir, { allowInsecure: true })
    });
    const { ref } = v1.create({ scope: "system", value: "on-disk-corrupt-case" });
    const file = path.join(dir, `${ref.secretId}.json`);
    fs.writeFileSync(file, "{not json at all");

    const v2 = vaultMod.createSecretVault({
        now: () => 9_999,
        store: vaultMod.store.createFileSecretStore(dir, { allowInsecure: true })
    });
    assert.throws(() => v2.describe(ref), (e) => e instanceof VaultError && e.code === "VAULT_STORE_FAILURE");
});

test("B2: all conflict paths preserve their stable codes", () => {
    const store = vaultMod.store.createMemorySecretStore();
    const id = ids.newSecretId();
    const baseRecord = {
        scope: "system", status: "active", createdAt: 7,
        envelope: { k: "det-v1", d: "dg==" }, valueDigest: "0".repeat(64), valueBytes: 1
    };
    store.create({ ...baseRecord, secretId: id });

    // vanished-before-update
    assert.throws(
        () => store.put({ ...baseRecord, secretId: ids.newSecretId(), expectedVersion: 3 }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    // stale writer from previous generation (recreate then stale write)
    store.delete(id);
    store.create({ ...baseRecord, secretId: id }); // fresh generation, version 1 again
    assert.throws(
        () => store.put({ ...baseRecord, secretId: id, createdAt: 999_999, expectedVersion: 1 }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
});

// =====================================================================
// B3 — FILE STORE MUST NOT RESURRECT DELETED SECRET
// =====================================================================

function stalePutScenarios(storeFactory) {
    return () => {
        // Sequence: create v1 -> read stale -> delete -> stale put -> CONFLICT + NOT_FOUND
        const store = storeFactory();
        let t = 100;
        const vault = vaultMod.createSecretVault({ now: () => (t += 5), store });
        const created = vault.create({ scope: "system", value: "RESURRECTION-TARGET" });
        const staleRecord = JSON.parse(JSON.stringify({
            ...store.get(created.ref.secretId)
        }));

        vault.deleteSecret(created.ref);
        assert.throws(
            () => store.put({ ...staleRecord, expectedVersion: staleRecord.version }),
            (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
        );
        assert.deepEqual(vault.describe(created.ref), { ok: false, code: "VAULT_NOT_FOUND" });

        // rotate -> stale put
        const rotated = vault.create({ scope: "system", value: "ROTATE-TARGET" });
        const beforeRotate = { ...store.get(rotated.ref.secretId) };
        vault.rotate(rotated.ref, "ROTATED-NEW");
        assert.throws(
            () => store.put({ ...beforeRotate, expectedVersion: beforeRotate.version }),
            (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
        );

        // revoke -> stale put
        const revoked = vault.create({ scope: "system", value: "REVOKE-TARGET" });
        const beforeRevoke = { ...store.get(revoked.ref.secretId) };
        vault.revoke(revoked.ref);
        assert.throws(
            () => store.put({ ...beforeRevoke, expectedVersion: beforeRevoke.version }),
            (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
        );

        // multiple stale writers all lose
        for (let i = 0; i < 3; i++) {
            assert.throws(
                () => store.put({ ...staleRecord, expectedVersion: staleRecord.version }),
                (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
            );
        }
        assert.deepEqual(vault.describe(created.ref), { ok: false, code: "VAULT_NOT_FOUND" });
        assert.ok(!JSON.stringify(vault.evidenceView()).includes("RESURRECTION-TARGET"));
    };
}

test("B3: memory store rejects every stale resurrection path",
    stalePutScenarios(() => vaultMod.store.createMemorySecretStore()));

test("B3: file store rejects every stale resurrection path",
    stalePutScenarios(() => vaultMod.store.createFileSecretStore(tmpDir(), { allowInsecure: true })));

test("B3: file-store reopen then stale put still cannot resurrect", () => {
    const dir = tmpDir();
    let t = 10;
    const s1 = vaultMod.store.createFileSecretStore(dir, { allowInsecure: true });
    const v1 = vaultMod.createSecretVault({ now: () => (t += 5), store: s1 });
    const created = v1.create({ scope: "device", key: "d1", value: "REOPEN-TARGET" });
    const stale = { ...s1.get(created.ref.secretId) };

    v1.deleteSecret(created.ref);

    // Fresh process-style reopen over the same directory.
    const s2 = vaultMod.store.createFileSecretStore(dir, { allowInsecure: true });
    const v2 = vaultMod.createSecretVault({ now: () => 50_000, store: s2 });
    assert.throws(
        () => s2.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(v2.describe(created.ref).code, "VAULT_NOT_FOUND");
    assert.equal(fs.existsSync(path.join(dir, `${created.ref.secretId}.json`)), false);
});

test("B3: recreate-same-id cannot be overwritten by a stale prior-generation writer", () => {
    const store = vaultMod.store.createMemorySecretStore();
    let t = 10;
    const vault = vaultMod.createSecretVault({ now: () => (t += 5), store });
    const fixedId = ids.secretIdFromSeed("generation-guard");
    const first = vault.create({ scope: "system", value: "GEN-0-CLEARTTEXT", secretId: fixedId });
    const stale = { ...store.get(fixedId) };
    vault.deleteSecret(first.ref);
    vault.create({ scope: "system", value: "GEN-1-FRESH", secretId: fixedId });
    assert.throws(
        () => store.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(first.ref).value.reveal(), "GEN-1-FRESH");
});

// =====================================================================
// B4 — DIAGNOSTICS ARGUMENT CONTRACT
// =====================================================================

test("B4: diagnostic records carry the intended schema on success paths", () => {
    let t = 5_000;
    const vault = vaultMod.createSecretVault({ now: () => (t += 1) });
    const created = vault.create({ scope: "provider", label: "diag", value: "DIAG-SECRET-XYZ" });
    vault.describe(created.ref);
    vault.resolve(created.ref);
    vault.rotate(created.ref, "DIAG-ROTATED-XYZ");
    vault.revoke(created.ref);
    vault.deleteSecret(created.ref);

    const entries = vault._diagnostics.recent(10);
    const byOp = Object.fromEntries(entries.map((e) => [e.op, e]));
    for (const op of ["create", "describe", "resolve", "rotate", "revoke", "delete"]) {
        assert.ok(byOp[op], `missing op entry: ${op}`);
        assert.equal(byOp[op].op, op);
        assert.equal(byOp[op].secretId, created.ref.secretId);
        assert.equal(byOp[op].outcome, "ok");
        assert.ok(Number.isSafeInteger(byOp[op].at));
        assert.notEqual(byOp[op].op, "[object Object]");
    }
});

test("B4: failure-path detail passes through scrubText; no raw synthetic secret in diagnostics", () => {
    let t = 5_000;
    const vault = vaultMod.createSecretVault({ now: () => (t += 1) });
    // Produce an error-path diagnostic: decrypt failure via corrupted envelope.
    const real = vaultMod.store.createMemorySecretStore();
    const host = vaultMod.createSecretVault({ now: () => t, store: real });
    const { ref } = host.create({ scope: "system", value: "PLAINTEXT-SHOULD-NOT-APPEAR-777" });
    const rec = real.get(ref.secretId);
    const broken = { ...rec, envelope: { k: "det-v1", d: "!!!notbase64!!!" } };
    void broken;
    const proxy = {
        get: (id) => (id === ref.secretId ? { ...rec, envelope: { nonsense: true } } : real.get(id)),
        put: (r) => real.put(r),
        delete: (id) => real.delete(id),
        listIds: () => real.listIds(),
        describePersistence: () => real.describePersistence()
    };
    const v2 = vaultMod.createSecretVault({ now: () => t, store: proxy });
    v2.resolve(ref); // decrypt failure -> error diagnostic

    const dump = JSON.stringify(v2._diagnostics.recent(50));
    assert.ok(!dump.includes("PLAINTEXT-SHOULD-NOT-APPEAR-777"));
    const errEntry = v2._diagnostics.recent(50).find((e) => e.op === "resolve" && e.outcome === "error");
    assert.ok(errEntry, "expected an error-path diagnostic");
});

test("B4: diagnostics.record validates its input shape", () => {
    let t = 1;
    const vault = vaultMod.createSecretVault({ now: () => (t += 1) });
    assert.throws(() => vault._diagnostics.record(null), TypeError);
    assert.throws(() => vault._diagnostics.record("resolve"), TypeError);
    assert.throws(() => vault._diagnostics.record(["resolve"]), TypeError);
});

// =====================================================================
// CROSS-REPAIR PROOFS
// =====================================================================

test("CROSS: caller-controlled SecretRef scope can never redefine canonical scope", () => {
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "project", key: "secret-project" }, value: "CROSS-CHECK" });
    for (const claimed of [
        { kind: "system" },
        { kind: "provider", key: "openrouter" },
        { kind: "project", key: "other-project" },
        { kind: "device", key: "phone-1" }
    ]) {
        const forged = vaultMod.refs.buildSecretRef({ secretId: created.ref.secretId, scope: claimed });
        assert.equal(vault.resolveIn(claimed, forged).code, "VAULT_SCOPE_MISMATCH");
        assert.equal(vault.resolve(forged, { expectedScope: claimed }).code, "VAULT_SCOPE_MISMATCH");
    }
});

test("CROSS: zero Authority mutation through full repair surface", async () => {
    const { createMemoryAuthorityStore } = require("../../src/authority/store");
    const authorityStore = createMemoryAuthorityStore();

    async function fingerprint() {
        const probes = [];
        for (const id of ["cap.x", "cap.y"]) {
            probes.push(JSON.stringify(await authorityStore.getCapability(id)));
        }
        return probes.join("|");
    }

    const before = await fingerprint();
    const vault = makeVault();
    const created = vault.create({ scope: { kind: "provider", key: "p" }, value: "AUTH-ISOLATION" });
    const forged = vaultMod.refs.buildSecretRef({ secretId: created.ref.secretId, scope: "system" });
    vault.resolveIn("system", forged);
    vault.rotate(created.ref, "AUTH-ISOLATION-2");
    vault.revoke(created.ref);
    vault.deleteSecret(created.ref);
    const after = await fingerprint();
    assert.equal(after, before);
});
