"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sha256Hex, digestOfCanonical, isValidDigestFormat } = require("../../src/runtime/recovery/digest");

test("sha256 known-answer vector", () => {
    assert.equal(
        sha256Hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
});

test("digest format validator", () => {
    assert.ok(isValidDigestFormat("a".repeat(64)));
    assert.ok(!isValidDigestFormat("A".repeat(64)));
    assert.ok(!isValidDigestFormat("a".repeat(63)));
    assert.ok(!isValidDigestFormat(null));
});

test("digest of canonical value is stable", () => {
    const d = digestOfCanonical({ x: 1 });
    assert.equal(d, digestOfCanonical({ x: 1 }));
    assert.notEqual(d, digestOfCanonical({ x: 2 }));
});

test("digest semantics constant: algorithm pinned to sha256", () => {
    // Digest is CORRUPTION DETECTION ONLY. Pinning the algorithm prevents
    // silent upgrades that would invalidate stored capsules.
    assert.equal(require("../../src/runtime/recovery/digest").DIGEST_ALGORITHM, "sha256");
});
