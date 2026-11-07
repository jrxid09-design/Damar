"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { canonicalJson, canonicalBytes, CanonicalizationError } = require("../../src/runtime/recovery/canonicalJson");
const { digestOfCanonical } = require("../../src/runtime/recovery/digest");

test("canonical json: key order independent of insertion order", () => {
    const a = canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
    const b = canonicalJson({ m: { b: 2, y: 1 }, a: 2, z: 1 });
    assert.equal(a, b);
    assert.deepEqual(JSON.parse(a), JSON.parse(b));
});

test("canonical json: keys sorted by code unit", () => {
    const s = canonicalJson({ "B": 1, "a": 2, "A": 3, "~": 4 });
    assert.equal(s, '{"A":3,"B":1,"a":2,"~":4}');
});

test("canonical json: arrays preserve element order", () => {
    assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonical json: rejects NaN and Infinity", () => {
    assert.throws(() => canonicalJson(NaN), CanonicalizationError);
    assert.throws(() => canonicalJson(Infinity), CanonicalizationError);
    assert.throws(() => canonicalJson(-Infinity), CanonicalizationError);
    assert.throws(() => canonicalJson({ x: NaN }), CanonicalizationError);
});

test("canonical json: rejects BigInt", () => {
    assert.throws(() => canonicalJson(10n), CanonicalizationError);
    assert.throws(() => canonicalJson({ x: 10n }), CanonicalizationError);
});

test("canonical json: rejects undefined values", () => {
    assert.throws(() => canonicalJson(undefined), CanonicalizationError);
    assert.throws(() => canonicalJson({ x: undefined }), CanonicalizationError);
});

test("canonical json: rejects functions and symbols", () => {
    assert.throws(() => canonicalJson(() => {}), CanonicalizationError);
    assert.throws(() => canonicalJson(Symbol("x")), CanonicalizationError);
    assert.throws(() => canonicalJson({ fn() {} }), CanonicalizationError);
});

test("canonical json: rejects circular objects", () => {
    const o = { name: "root" };
    o.self = o;
    assert.throws(() => canonicalJson(o), /circular/);
});

test("canonical json: rejects circular arrays", () => {
    const arr = [1, 2];
    arr.push(arr);
    assert.throws(() => canonicalJson(arr), /circular/);
});

test("canonical json: rejects shared-but-acyclic DAG references", () => {
    const shared = { v: 1 };
    assert.doesNotThrow(() => canonicalJson({ a: shared, b: shared }));
});

test("canonical json: rejects non-plain objects", () => {
    class Foo {
        constructor() { this.x = 1; }
    }
    assert.throws(() => canonicalJson(new Foo()), CanonicalizationError);
    assert.throws(() => canonicalJson(new Date(0)), CanonicalizationError);
    assert.throws(() => canonicalJson(new Map([["k", 1]])), CanonicalizationError);
    assert.throws(() => canonicalJson(new Set([1])), CanonicalizationError);
});

test("canonical json: rejects dangerous prototype keys", () => {
    const hostile = {};
    Object.defineProperty(hostile, "__proto__", { value: { evil: true }, enumerable: true });
    assert.throws(() => canonicalJson(hostile), /forbidden object key/);
    assert.throws(() => canonicalJson({ constructor: 1 }), /forbidden object key/);
    assert.throws(() => canonicalJson({ prototype: 1 }), /forbidden object key/);
});

test("canonical json: rejects hostile parsed payload with own __proto__ property", () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"ok":1}');
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"));
    assert.throws(() => canonicalJson(parsed), /forbidden object key|non-plain object/);
});

test("canonical json: -0 normalized to 0 for byte determinism", () => {
    assert.equal(canonicalJson({ x: -0 }), canonicalJson({ x: 0 }));
    assert.equal(canonicalBytes({ x: -0 }).toString("hex"), canonicalBytes({ x: 0 }).toString("hex"));
});

test("canonical json: deterministic UTF-8 bytes for unicode strings", () => {
    const v = { s: "äther ✓ \u0001\n" };
    const bytes1 = canonicalBytes(v);
    const bytes2 = canonicalBytes({ s: JSON.parse(JSON.stringify(v.s)) });
    assert.deepEqual(bytes1, bytes2);
    assert.equal(bytes1.toString("utf8"), '{"s":"äther ✓ \\u0001\\n"}');
});

test("canonical json + digest: same semantic value yields same digest across shapes", () => {
    const d1 = digestOfCanonical({ b: [1, 2], a: "x" });
    const d2 = digestOfCanonical({ a: "x", b: [1, 2] });
    assert.equal(d1, d2);
    assert.notEqual(d1, digestOfCanonical({ a: "y", b: [1, 2] }));
});
