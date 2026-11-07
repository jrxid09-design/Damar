"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");

const { SecretValue, secretValue, isSecretValue } = require("../../src/runtime/vault/value");
const { redactMatches } = require("../../src/runtime/vault/redact");

const RAW = "sk-DO-NOT-LEAK-0123456789";

test("json serialization never reveals the value", () => {
    const sv = secretValue(RAW);
    assert.equal(JSON.stringify(sv), JSON.stringify("[SecretValue redacted]"));
    assert.equal(JSON.stringify({ nested: [sv] }), '{"nested":["[SecretValue redacted]"]}');
});

test("util.inspect never reveals the value", () => {
    assert.doesNotMatch(util.inspect(secretValue(RAW)), /DO-NOT-LEAK/);
    assert.match(util.inspect(secretValue(RAW)), /redacted/);
});

test("string coercion (toString, template literal, toPrimitive) is redacted", () => {
    const sv = secretValue(RAW);
    assert.equal(String(sv), "[SecretValue redacted]");
    assert.equal(`${sv}`, "[SecretValue redacted]");
    assert.notEqual(String(sv), RAW);
});

test("no enumerable own properties carry the raw value", () => {
    const sv = secretValue(RAW);
    for (const key of Object.keys(sv)) {
        const v = sv[key];
        const text = typeof v === "string" ? v : JSON.stringify(v) ?? "";
        assert.ok(!text.includes(RAW), `leak via own property ${key}`);
    }
    // Spread of the instance cannot capture cleartext.
    const spread = { ...sv };
    assert.ok(!JSON.stringify(spread).includes(RAW));
});

test("errors constructed from a SecretValue context do not contain the value", () => {
    const sv = secretValue(RAW);
    const err = new Error(`resolution failed for ${JSON.stringify({ value: sv })}`);
    assert.ok(!err.message.includes(RAW));
    void sv;
});

test("reveal() is the only sanctioned read path", () => {
    const sv = secretValue(RAW);
    assert.equal(sv.reveal(), RAW);
    assert.equal(isSecretValue(sv), true);
    assert.equal(isSecretValue({}), false);
});

test("value bounds: empty and oversized rejected", () => {
    assert.throws(() => new SecretValue(""), /empty/);
    assert.throws(() => new SecretValue("x".repeat(64 * 1024 + 1)), /maximum size/);
    assert.throws(() => new SecretValue(42), /string or Buffer/);
});

test("structuredClone-safe surface: toJSON marker survives cloning paths", () => {
    const sv = secretValue(RAW);
    const clone = JSON.parse(JSON.stringify(sv));
    assert.equal(clone, "[SecretValue redacted]");
});

test("redactMatches scrubs candidate values from arbitrary text", () => {
    const out = redactMatches("Authorization: Bearer sk-abc; x=sk-def", ["sk-abc", "sk-def"]);
    assert.equal(out, "Authorization: Bearer [secret]; x=[secret]");
});
