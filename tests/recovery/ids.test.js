"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ids = require("../../src/runtime/recovery/ids");

test("capsule id format: generated values match canonical pattern", () => {
    const id = ids.newRecoveryCapsuleId();
    assert.match(id, /^rc-[0-9a-f]{32}$/);
    assert.equal(ids.coerceRecoveryCapsuleId(id), id);
});

test("capsule id: uppercase rejected", () => {
    assert.throws(() => ids.coerceRecoveryCapsuleId("RC-" + "a".repeat(32)), RangeError);
});

test("capsule id: path traversal segments rejected", () => {
    assert.throws(() => ids.coerceRecoveryCapsuleId("../etc/passwd"), RangeError);
    assert.throws(() => ids.coerceRecoveryCapsuleId("rc-../../.."), RangeError);
    assert.throws(() => ids.coerceRecoveryCapsuleId("..\\windows\\system32"), RangeError);
});

test("capsule id: whitespace and empty rejected", () => {
    assert.throws(() => ids.coerceRecoveryCapsuleId(""), /must be a non-empty string/);
    assert.throws(() => ids.coerceRecoveryCapsuleId(`rc-${"a".repeat(32)} `), RangeError);
    assert.throws(() => ids.coerceRecoveryCapsuleId(null), TypeError);
    assert.throws(() => ids.coerceRecoveryCapsuleId(42), TypeError);
});

test("capsule id: wrong length rejected", () => {
    assert.throws(() => ids.coerceRecoveryCapsuleId(`rc-${"a".repeat(31)}`), RangeError);
    assert.throws(() => ids.coerceRecoveryCapsuleId(`rc-${"a".repeat(33)}`), RangeError);
});

test("runtime generation id: round trip + malformed rejection", () => {
    const id = ids.newRuntimeGenerationId();
    assert.equal(ids.coerceRuntimeGenerationId(id), id);
    assert.throws(() => ids.coerceRuntimeGenerationId("rtg-zz"), RangeError);
});

test("epoch id: lexicographic order equals numeric order", () => {
    const e1 = ids.newRecoveryEpochId(1);
    const e2 = ids.newRecoveryEpochId(2);
    const e999 = ids.newRecoveryEpochId(999);
    assert.ok(e1 < e2 && e2 < e999);
    assert.equal(ids.epochRank(e999), 999);
});

test("epoch id: zero, negative, fractional, overflow rejected", () => {
    assert.throws(() => ids.newRecoveryEpochId(0), RangeError);
    assert.throws(() => ids.newRecoveryEpochId(-1), RangeError);
    assert.throws(() => ids.newRecoveryEpochId(1.5), RangeError);
    assert.throws(() => ids.newRecoveryEpochId(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => ids.coerceRecoveryEpochId("repoch-00000000000000000000"), RangeError);
});

test("section id: lowercase identifier rules, no separators or dots", () => {
    assert.equal(ids.coerceSectionId("acc"), "acc");
    assert.equal(ids.coerceSectionId("semantic-desktop"), "semantic-desktop");
    for (const bad of ["Acc", "1abc", "a".repeat(40), "a/b", "a\\b", "a..b", "", "a b"]) {
        assert.throws(() => ids.coerceSectionId(bad), Error, `expected reject: ${bad}`);
    }
});
