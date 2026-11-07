"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");

const refs = require("../../src/runtime/vault/ref");
const ids = require("../../src/runtime/vault/ids");

function makeRef() {
    return refs.buildSecretRef({ secretId: ids.newSecretId(), scope: { kind: "provider", key: "openrouter" } });
}

test("secret ref is safe to serialize, log, inspect, persist", () => {
    const ref = makeRef();
    const json = JSON.stringify(ref);
    assert.equal(json, JSON.parse(JSON.stringify(json)) && json);
    assert.ok(!/sk-|value|cleartext/i.test(json));
    assert.doesNotMatch(util.inspect(ref), /sk-/);
    assert.match(String(ref), /^\[SecretRef provider\/openrouter\]$/);
});

test("secret ref string form round-trips", () => {
    const ref = makeRef();
    const s = refs.secretRefToString(ref);
    assert.ok(s.startsWith("secretref:v1:sec-"));
    const back = refs.parseSecretRefString(s);
    assert.equal(back.secretId, ref.secretId);
    assert.deepEqual({ ...back.scope }, { ...ref.scope });
});

test("malformed secret refs rejected", () => {
    for (const bad of [
        "",
        "secretref:",
        "secretref:v1:not-an-id",
        "secretref:v2:sec-00000000000000000000000000000000",
        "secretref:v1:sec-00000000000000000000000000000000:bogus/../kind",
        "secretref:v1:sec-00000000000000000000000000000000:provider:a:b:c",
        null,
        123,
        ["x"]
    ]) {
        assert.throws(() => refs.coerceSecretRef(bad), Error, `expected reject: ${String(bad).slice(0, 30)}`);
    }
});

test("raw value inserted where SecretRef expected is rejected", () => {
    assert.throws(() => refs.coerceSecretRef({ value: "sk-live-very-secret" }), /forbidden/);
    assert.throws(() => refs.coerceSecretRef({ secretId: ids.newSecretId(), token: "abc" }), /forbidden/);
    assert.throws(() => refs.coerceSecretRef("Bearer sk-abc"), /malformed/);
});

test("forged metadata on ref input cannot smuggle extra fields", () => {
    const ref = refs.buildSecretRef({
        secretId: ids.newSecretId(),
        scope: "system",
        status: "active",
        authority: "root",
        __proto__: { polluted: true }
    });
    const keys = Object.keys(JSON.parse(JSON.stringify(ref)));
    assert.deepEqual(keys.sort(), ["scope", "secretId", "v"]);
    assert.equal(Object.prototype.polluted, undefined);
});
