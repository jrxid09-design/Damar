"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ids = require("../../src/runtime/vault/ids");
const { VaultError } = require("../../src/runtime/vault/errors");

test("secret id format: generated values match canonical pattern", () => {
    const id = ids.newSecretId();
    assert.match(id, /^sec-[0-9a-f]{32}$/);
    assert.equal(ids.assertSecretId(id), id);
});

test("secret id is safe for logs and carries no value material", () => {
    const id = ids.newSecretId();
    assert.ok(id.length <= 36);
    assert.equal(JSON.stringify({ id }), `{"id":"${id}"}`);
});

test("secret id: uppercase, whitespace variants normalize then validate", () => {
    const id = ids.newSecretId();
    assert.equal(ids.assertSecretId("  " + id.toUpperCase() + " "), id);
});

test("secret id: malformed inputs rejected fail-closed", () => {
    for (const bad of [
        "",
        "sec-",
        "sec-32hexchars-but-not-all-hex-gg00",
        `sec-${"a".repeat(31)}`,
        `sec-${"a".repeat(33)}`,
        "sec-gg0000000000000000000000000000000",
        "../etc/passwd",
        "rc-00000000000000000000000000000000",
        null,
        42,
        {},
        `${"x".repeat(129)}`
    ]) {
        assert.throws(() => ids.assertSecretId(bad), (e) => e instanceof TypeError || e instanceof RangeError || e instanceof VaultError,
            `expected reject: ${String(bad).slice(0, 20)}`);
    }
});

test("secret id: oversized input rejected before pattern work", () => {
    assert.throws(() => ids.assertSecretId(`sec-${"a".repeat(200)}`), /maximum length/);
});

test("duplicate normalized ids collide to one identity", () => {
    const base = ids.newSecretId();
    assert.equal(ids.normalizeSecretIdInput(base.toUpperCase()), base);
    assert.equal(ids.normalizeSecretIdInput(` ${base} `), base);
});

test("seeded derivation is deterministic and valid", () => {
    const a = ids.secretIdFromSeed("provider:openrouter");
    const b = ids.secretIdFromSeed("provider:openrouter");
    assert.equal(a, b);
    assert.match(a, /^sec-[0-9a-f]{32}$/);
    assert.notEqual(a, ids.secretIdFromSeed("provider:telegram"));
});

test("newSecretId rejects wrong entropy", () => {
    assert.throws(() => ids.newSecretId(() => Buffer.alloc(8)), /16 bytes/);
});
