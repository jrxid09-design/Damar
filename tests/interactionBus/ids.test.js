"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");

const { isCanonicalId, assertCanonicalId, ID_MAX_LENGTHS } = ib;

test("ids: canonical interactionId accepted", () => {
  assert.equal(isCanonicalId("interactionId", "ix_abc123"), true);
  assert.equal(isCanonicalId("interactionId", "ix_0"), true);
  assert.equal(isCanonicalId("interactionId", "ix_a-b_c"), true);
});

test("ids: all prefixed types accept valid values", () => {
  assert.equal(isCanonicalId("sessionId", "ses_main"), true);
  assert.equal(isCanonicalId("correlationId", "cor_9z"), true);
  assert.equal(isCanonicalId("turnId", "trn_t1"), true);
  assert.equal(isCanonicalId("runtimeGenerationId", "gen_g1"), true);
  assert.equal(isCanonicalId("attachmentId", "att_file1"), true);
  assert.equal(isCanonicalId("evidenceId", "evd_e1"), true);
});

test("ids: transportId allows dotted segments like telegram.primary", () => {
  assert.equal(isCanonicalId("transportId", "telegram.primary"), true);
  assert.equal(isCanonicalId("transportId", "voice.local.a"), true);
  assert.equal(isCanonicalId("transportId", "a1.b2"), true);
});

test("ids: reject empty, wrong prefix, and non-string values", () => {
  assert.equal(isCanonicalId("interactionId", ""), false);
  assert.equal(isCanonicalId("interactionId", "session_abc"), false);
  assert.equal(isCanonicalId("interactionId", "ix_"), false);
  assert.equal(isCanonicalId("interactionId", null), false);
  assert.equal(isCanonicalId("interactionId", 123), false);
  assert.equal(isCanonicalId("interactionId", undefined), false);
});

test("ids: reject whitespace and path semantics", () => {
  assert.equal(isCanonicalId("sessionId", "ses_a b"), false);
  assert.equal(isCanonicalId("sessionId", "ses_a/b"), false);
  assert.equal(isCanonicalId("sessionId", "ses_a\\b"), false);
  assert.equal(isCanonicalId("sessionId", "ses_../etc"), false);
  assert.equal(isCanonicalId("sessionId", "ses_a..b"), false);
  assert.equal(isCanonicalId("sessionId", "../passwd"), false);
});

test("ids: reject uppercase (case-sensitive grammar, no normalization)", () => {
  assert.equal(isCanonicalId("sessionId", "SES_ABC"), false);
  assert.equal(isCanonicalId("sessionId", "ses_ABC"), false);
  assert.equal(isCanonicalId("sessionId", "ix_ABC"), false);
});

test("ids: enforce explicit total length limits", () => {
  const maxSegment = "a".repeat(63);
  assert.equal(isCanonicalId("interactionId", `ix_${maxSegment}`), true);
  assert.equal(
    isCanonicalId("interactionId", `ix_${"a".repeat(64)}`),
    false
  );
  assert.equal(isCanonicalId("transportId", "a".repeat(64)), true);
  assert.equal(isCanonicalId("transportId", "a".repeat(65)), false);
});

test("ids: transportId rejects leading/trailing/double dots", () => {
  assert.equal(isCanonicalId("transportId", ".telegram"), false);
  assert.equal(isCanonicalId("transportId", "telegram."), false);
  assert.equal(isCanonicalId("transportId", "tele..gram"), false);
  assert.equal(isCanonicalId("transportId", "tele gram"), false);
});

test("ids: unknown id type rejected", () => {
  assert.equal(isCanonicalId("unknownType", "ix_a"), false);
  assert.throws(() => assertCanonicalId("unknownType", "ix_a"), /INVALID_ID|canonical/);
});

test("ids: assertCanonicalId throws BusError with INVALID_ID code", () => {
  try {
    assertCanonicalId("sessionId", "not-a-session");
    assert.fail("expected throw");
  } catch (error) {
    assert.equal(error.code, "INVALID_ID");
  }
});

test("ids: sequential factory produces grammar-valid ids for every type", () => {
  const factory = ib.createSequentialIdFactory();
  for (const type of [
    "interactionId",
    "sessionId",
    "correlationId",
    "turnId",
    "runtimeGenerationId",
    "attachmentId",
    "evidenceId"
  ]) {
    const value = factory.next(type);
    assert.equal(isCanonicalId(type, value), true, `${type}: ${value}`);
  }
});

test("ids: sequential factory is deterministic", () => {
  const a = ib.createSequentialIdFactory();
  const b = ib.createSequentialIdFactory();
  assert.deepEqual(
    [a.next("interactionId"), a.next("interactionId")],
    [b.next("interactionId"), b.next("interactionId")]
  );
});

test("ids: crypto factory produces grammar-valid unique ids", () => {
  const factory = ib.createCryptoIdFactory();
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const value = factory.next("correlationId");
    assert.equal(isCanonicalId("correlationId", value), true);
    seen.add(value);
  }
  assert.equal(seen.size, 50);
});

test("ids: factories refuse to mint transportId", () => {
  const factory = ib.createSequentialIdFactory();
  assert.throws(() => factory.next("transportId"), /transportId/);
});

test("ids: ids carry no privilege semantics (admin prefix parses as ordinary)", () => {
  assert.equal(isCanonicalId("sessionId", "ses_admin-123"), true);
  assert.equal(isCanonicalId("sessionId", "ses_user-123"), true);
});
