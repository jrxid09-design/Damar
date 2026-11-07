"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const ids = require("../../src/runtime/vault/ids");
const { VaultError } = require("../../src/runtime/vault/errors");

const INCARNATION_PATTERN = /^inc-[0-9a-f]{32}$/;

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-vault-incarnation-"));
}

/**
 * Shared scenario runner: runs the SAME scenario factory against BOTH
 * memory and file stores and requires identical results (error class,
 * error code, and canonical final state). This is the memory/file parity
 * requirement of section 7.
 */
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
// 5. PRIMARY REPRO — fixed clock, delete → recreate → stale write
// =====================================================================

forEachStore("fixed-clock delete/recreate: stale prior-generation write is VAULT_CONFLICT", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("primary-repro");
    const first = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));

    vault.deleteSecret(first.ref);
    vault.create({ scope: "system", value: "E-new", secretId: S });

    const fresh = store.get(S);
    assert.notEqual(stale.incarnationId, fresh.incarnationId, "incarnationId must change on recreate");
    assert.match(fresh.incarnationId, INCARNATION_PATTERN);
    assert.equal(fresh.createdAt, stale.createdAt, "precondition: createdAt collides");

    assert.throws(
        () => store.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(first.ref).value.reveal(), "E-new");
    assert.notEqual(vault.resolve(first.ref).value.reveal(), "E-old");
});

// =====================================================================
// 6. REQUIRED CASES
// =====================================================================

// A. fixed-clock delete → recreate → stale write
forEachStore("A: fixed-clock delete/recreate blocks stale write", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("case-A");
    const c1 = vault.create({ scope: "system", value: "A-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: "system", value: "A-new", secretId: S });
    assert.throws(
        () => store.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(c1.ref).value.reveal(), "A-new");
});

// B. same-tick recreation: delete + recreate resolve to the SAME clock
// value (a same-millisecond collision under a real clock), yet the
// incarnationId MUST still differ and the stale write MUST still lose.
forEachStore("B: same-tick recreation produces distinct incarnation", (makeStore) => {
    const store = makeStore();
    // A real-clock "same tick" is a single fixed millisecond value; we pin
    // it so delete+recreate are guaranteed to share one timestamp, which is
    // the exact collision the incarnation guard must survive.
    const tick = Date.now();
    const vault = vaultMod.createSecretVault({ now: () => tick, store });
    const S = ids.secretIdFromSeed("case-B");
    const c1 = vault.create({ scope: "system", value: "B-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: "system", value: "B-new", secretId: S });
    const fresh = store.get(S);
    assert.notEqual(stale.incarnationId, fresh.incarnationId);
    assert.equal(fresh.createdAt, stale.createdAt, "same tick -> createdAt equal");
    assert.throws(
        () => store.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(c1.ref).value.reveal(), "B-new");
});

// C. rotate → stale write
forEachStore("C: rotate bumps version; stale pre-rotate write loses", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const c = vault.create({ scope: "system", value: "C-v0" });
    const before = JSON.parse(JSON.stringify(store.get(c.ref.secretId)));
    vault.rotate(c.ref, "C-v1");
    assert.throws(
        () => store.put({ ...before, expectedVersion: before.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(c.ref).value.reveal(), "C-v1");
});

// D. revoke → stale write
forEachStore("D: revoke destroys value; stale pre-revoke write loses", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const c = vault.create({ scope: "system", value: "D-v0" });
    const before = JSON.parse(JSON.stringify(store.get(c.ref.secretId)));
    vault.revoke(c.ref);
    assert.throws(
        () => store.put({ ...before, expectedVersion: before.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.describe(c.ref).metadata.status, "revoked");
});

// E. multiple stale writers all lose
forEachStore("E: multiple stale writers from a prior incarnation all lose", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("case-E");
    const c1 = vault.create({ scope: "system", value: "E-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: "system", value: "E-new", secretId: S });
    for (let i = 0; i < 3; i++) {
        assert.throws(
            () => store.put({ ...stale, expectedVersion: stale.version }),
            (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
        );
    }
    assert.equal(vault.resolve(c1.ref).value.reveal(), "E-new");
});

// F. file-store reopen after recreate
test("F: file-store reopen after recreate keeps the new incarnation; stale write still loses", () => {
    const dir = tmpDir();
    const s1 = vaultMod.store.createFileSecretStore(dir, { allowInsecure: true });
    const v1 = vaultMod.createSecretVault({ now: () => 1000, store: s1 });
    const S = ids.secretIdFromSeed("case-F");
    const c1 = v1.create({ scope: "system", value: "F-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(s1.get(S)));
    v1.deleteSecret(c1.ref);
    v1.create({ scope: "system", value: "F-new", secretId: S });

    // Fresh process-style reopen over the same directory.
    const s2 = vaultMod.store.createFileSecretStore(dir, { allowInsecure: true });
    const v2 = vaultMod.createSecretVault({ now: () => 50_000, store: s2 });
    const reopened = s2.get(S);
    assert.match(reopened.incarnationId, INCARNATION_PATTERN);
    assert.notEqual(stale.incarnationId, reopened.incarnationId);
    assert.throws(
        () => s2.put({ ...stale, expectedVersion: stale.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(v2.resolve(c1.ref).value.reveal(), "F-new");
});

// G. recreate same SecretId repeatedly under fixed clock
forEachStore("G: repeated recreate under fixed clock yields distinct incarnations", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("case-G");
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
        const c = vault.create({ scope: "system", value: `G-${i}`, secretId: S });
        const inc = store.get(S).incarnationId;
        assert.ok(!seen.has(inc), `incarnation reused across recreate: ${inc}`);
        assert.match(inc, INCARNATION_PATTERN);
        seen.add(inc);
        if (i < 4) vault.deleteSecret(c.ref);
    }
    assert.equal(seen.size, 5);
});

// H. legitimate update inside same incarnation
forEachStore("H: legitimate same-incarnation rotate succeeds (expectedVersion match)", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const c = vault.create({ scope: "system", value: "H-v0" });
    const rec = store.get(c.ref.secretId);
    const rotated = vault.rotate(c.ref, "H-v1", { expectedVersion: rec.version });
    assert.equal(rotated.metadata.rotationCount, 1);
    assert.equal(store.get(c.ref.secretId).incarnationId, rec.incarnationId);
});

// I. rotate preserves incarnationId
forEachStore("I: rotate preserves incarnationId", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const c = vault.create({ scope: "system", value: "I-v0" });
    const before = store.get(c.ref.secretId).incarnationId;
    vault.rotate(c.ref, "I-v1");
    vault.rotate(c.ref, "I-v2");
    assert.equal(store.get(c.ref.secretId).incarnationId, before);
});

// J. revoke preserves incarnationId
forEachStore("J: revoke preserves incarnationId", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const c = vault.create({ scope: "system", value: "J-v0" });
    const before = store.get(c.ref.secretId).incarnationId;
    vault.revoke(c.ref);
    assert.equal(store.get(c.ref.secretId).incarnationId, before);
});

// K. stale incarnation cannot overwrite newer incarnation even when all else equal
forEachStore("K: stale incarnation blocked even when version/createdAt/scope/id all equal", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const S = ids.secretIdFromSeed("case-K");
    const c1 = vault.create({ scope: { kind: "provider", key: "k" }, value: "K-old", secretId: S });
    const stale = JSON.parse(JSON.stringify(store.get(S)));
    vault.deleteSecret(c1.ref);
    vault.create({ scope: { kind: "provider", key: "k" }, value: "K-new", secretId: S });
    const fresh = store.get(S);
    // version equal, createdAt equal, scope equal, SecretId equal —
    // only incarnationId differs.
    assert.equal(stale.version, fresh.version);
    assert.equal(stale.createdAt, fresh.createdAt);
    assert.deepEqual(stale.scope, fresh.scope);
    assert.equal(stale.secretId, fresh.secretId);
    assert.notEqual(stale.incarnationId, fresh.incarnationId);
    assert.throws(
        () => store.put({ ...stale, expectedVersion: fresh.version }),
        (e) => e instanceof VaultError && e.code === "VAULT_CONFLICT"
    );
    assert.equal(vault.resolve(c1.ref).value.reveal(), "K-new");
});

// =====================================================================
// 4. RECORD VALIDATION
// =====================================================================

test("incarnationId is validated (typed VaultError) and bounded", () => {
    for (const bad of [
        "",
        "inc-",
        "inc-" + "g".repeat(32),
        "inc-" + "0".repeat(31),
        "INC-" + "0".repeat(32),
        42,
        null,
        {},
        "inc-" + "0".repeat(32) + "extra"
    ]) {
        assert.throws(
            () => vaultMod.record.validateIncarnationId(bad),
            (e) => e instanceof VaultError && e.code === "VAULT_INVALID_INPUT",
            `expected typed error for ${JSON.stringify(bad)}`
        );
    }
    // Oversized hostile input fails closed before regex.
    assert.throws(
        () => vaultMod.record.validateIncarnationId("inc-" + "0".repeat(2000)),
        (e) => e instanceof VaultError && e.code === "VAULT_INVALID_INPUT"
    );
    assert.equal(vaultMod.record.validateIncarnationId("inc-" + "0".repeat(32)), "inc-" + "0".repeat(32));
});

test("buildSecretRecord generate:false fails closed on missing/malformed incarnationId", () => {
    const base = {
        secretId: ids.secretIdFromSeed("val-inc"),
        scope: "system",
        status: "active",
        createdAt: 1,
        envelope: { k: "det-v1", d: "dg==" },
        valueDigest: "0".repeat(64),
        valueBytes: 1
    };
    assert.throws(
        () => vaultMod.record.buildSecretRecord({ ...base }, { generate: false }),
        (e) => e instanceof VaultError && e.code === "VAULT_INVALID_INPUT"
    );
    assert.throws(
        () => vaultMod.record.buildSecretRecord({ ...base, incarnationId: "BAD" }, { generate: false }),
        (e) => e instanceof VaultError && e.code === "VAULT_INVALID_INPUT"
    );
    // With generate (default), a fresh record gets a valid incarnationId.
    const built = vaultMod.record.buildSecretRecord({ ...base });
    assert.match(built.incarnationId, INCARNATION_PATTERN);
});

// Evidence records must also carry a valid incarnationId so they survive
// file-store reopen and cannot be silently re-rolled.
forEachStore("importRecoveryEvidence assigns a valid incarnationId to evidence records", (makeStore) => {
    const store = makeStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const id = ids.secretIdFromSeed("evidence-inc");
    const res = vault.importRecoveryEvidence({ secretId: id, scope: "system", label: "l" });
    assert.equal(res.imported, true);
    assert.equal(res.metadata.status, "evidence");
    const rec = store.get(id);
    assert.match(rec.incarnationId, INCARNATION_PATTERN);
});

// =====================================================================
// 7. MEMORY / FILE PARITY — identical error class + code + final state
// =====================================================================

test("parity: memory and file stores agree on conflict code and final value", () => {
    const results = [];
    for (const make of [
        () => vaultMod.store.createMemorySecretStore(),
        () => vaultMod.store.createFileSecretStore(tmpDir(), { allowInsecure: true })
    ]) {
        const store = make();
        const vault = vaultMod.createSecretVault({ now: () => 1000, store });
        const S = ids.secretIdFromSeed("parity");
        const c1 = vault.create({ scope: "system", value: "P-old", secretId: S });
        const stale = JSON.parse(JSON.stringify(store.get(S)));
        vault.deleteSecret(c1.ref);
        vault.create({ scope: "system", value: "P-new", secretId: S });
        let errCode = null;
        let errClass = null;
        try {
            store.put({ ...stale, expectedVersion: stale.version });
        } catch (e) {
            errClass = e.constructor.name;
            errCode = e.code;
        }
        results.push({ errClass, errCode, value: vault.resolve(c1.ref).value.reveal() });
    }
    assert.equal(results[0].errClass, results[1].errClass);
    assert.equal(results[0].errCode, results[1].errCode);
    assert.equal(results[0].value, results[1].value);
    assert.equal(results[0].errCode, "VAULT_CONFLICT");
    assert.equal(results[0].value, "P-new");
});
