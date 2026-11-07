"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");

const vaultMod = require("../../src/runtime/vault");

const SECRET_A = "sk-LEAKCHECK-alpha-000111";
const SECRET_B = "whatsapp-session-MATERIAL-xyz";

function makeVault() {
    let t = 10;
    return vaultMod.createSecretVault({ now: () => (t += 1) });
}

test("secrets do not leak through JSON.stringify of every reachable surface", () => {
    const vault = makeVault();
    const a = vault.create({ scope: "provider", label: "a", value: SECRET_A });
    const b = vault.create({ scope: "transport", label: "b", value: SECRET_B });
    vault.rotate(a.ref, "rotated-A-value-99");
    vault.revoke(b.ref);

    const surfaces = {
        refs: vault.listRefs(),
        evidence: vault.evidenceView(),
        describeA: vault.describe(a.ref),
        describeB: vault.describe(b.ref),
        resolveB: vault.resolve(b.ref),
        stats: vault.stats(),
        diagnostics: vault._diagnostics.recent(200)
    };
    const blob = JSON.stringify(surfaces);
    assert.ok(!blob.includes(SECRET_A), "leak via surfaces json (SECRET_A)");
    assert.ok(!blob.includes(SECRET_B), "leak via surfaces json (SECRET_B)");
    assert.ok(!blob.includes("rotated-A-value-99"), "rotated-out value must be gone");
});

test("secrets do not leak through util.inspect of vault outputs", () => {
    const vault = makeVault();
    const { ref } = vault.create({ scope: "system", value: SECRET_A });
    const inspected = util.inspect({
        ref,
        meta: vault.describe(ref),
        view: vault.evidenceView()
    }, { depth: Infinity, showHidden: true });
    assert.ok(!inspected.includes(SECRET_A));
});

test("structured logger payload scrubbing via vault.scrubText", () => {
    const vault = makeVault();
    vault.create({ scope: "provider", label: "llm", value: SECRET_A });
    const logPayload = {
        msg: `request failed with key ${SECRET_A}`,
        nested: { auth: `Bearer ${SECRET_A}` }
    };
    const scrubbed = vault.scrubText(JSON.stringify(logPayload));
    assert.equal(scrubbed.includes(SECRET_A), false);
    assert.match(scrubbed, /\[secret:llm\]/);
});

test("rejection reasons and error messages never embed values", () => {
    const vault = makeVault();
    assert.throws(() => vault.rotate(
        vaultMod.refs.buildSecretRef({ secretId: require("../../src/runtime/vault/ids").newSecretId(), scope: "system" }),
        SECRET_A
    ), (err) => !String(err.message).includes(SECRET_A));
    assert.throws(() => vault.create({ scope: "system", value: SECRET_A, secretId: "garbage" }),
        (err) => !JSON.stringify(err).includes(SECRET_A));
});

test("diagnostics history is bounded and scrubbed", () => {
    const v = vaultMod.createSecretVault({
        config: { maxDiagnosticHistory: 20 },
        now: () => 1
    });
    const { ref } = v.create({ scope: "system", value: SECRET_A });
    for (let i = 0; i < 100; i++) {
        v.resolve(ref);
        v.describe(ref);
    }
    assert.ok(v.stats().diagnosticEntries <= 20);
    const dump = JSON.stringify(v._diagnostics.recent(200));
    assert.ok(!dump.includes(SECRET_A));
});

test("redaction registry is bounded", () => {
    const v = vaultMod.createSecretVault({
        config: { maxRedactionTrackedValues: 4 },
        now: () => 1
    });
    for (let i = 0; i < 20; i++) {
        v.create({ scope: "system", value: `val-${i}-${"x".repeat(10)}` });
    }
    assert.ok(v.stats().trackedRedactionValues <= 4);
});

test("snapshots (evidence view) are safe by construction even after many ops", () => {
    const vault = makeVault();
    for (let i = 0; i < 25; i++) {
        const { ref } = vault.create({ scope: "system", value: `${SECRET_A}-${i}` });
        if (i % 3 === 0) vault.revoke(ref);
        if (i % 3 === 1) vault.rotate(ref, `${SECRET_B}-${i}`);
    }
    const snapshot = JSON.stringify(vault.evidenceView());
    assert.ok(!snapshot.includes(SECRET_A));
    assert.ok(!snapshot.includes(SECRET_B));
});
