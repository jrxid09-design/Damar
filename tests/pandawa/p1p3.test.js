"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../src/services/pandawaIdentity");
const { createPandawaSessionRegistry } = require("../../src/runtime/interactionBus/pandawaSessions");
const delegation = require("../../src/services/pandawaDelegation");

test("P1: canonical identities and aliases remain one identity", () => {
  assert.deepEqual(identity.records().map(x => x.id), [
    "pandawa:puntadewa", "pandawa:werkudara", "pandawa:janaka", "pandawa:nakula", "pandawa:sadewa"
  ]);
  assert.equal(identity.resolve("Yudistira").id, "pandawa:puntadewa");
  assert.equal(identity.resolve("Bima").id, "pandawa:werkudara");
  assert.equal(identity.resolve("Arjuna").id, "pandawa:janaka");
  assert.equal(identity.resolveTarget("Janaka, review ini").id, "pandawa:janaka");
  assert.equal(identity.resolveTarget("Bima, cek security").id, "pandawa:werkudara");
  assert.equal(identity.resolveTarget("Panggil Damar").id, "damar");
  assert.equal(identity.resolveTarget("Pandawa, bahas ini").id, "pandawa:colony");
  assert.equal(identity.resolve("pandawa:yudistira"), null);
  assert.equal(identity.resolve("pandawa:unknown"), null);
});

test("P2: bounded session resume preserves entity and clears authority context", () => {
  let now = 100;
  const sessions = createPandawaSessionRegistry({ now: () => now, maxSessions: 2 });
  const first = sessions.create({ sessionId: "ses_janaka_1", targetEntity: "Arjuna", ownerUserId: "owner", surface: "console", channel: "console", parentDamarSessionId: "dsc_parent" });
  assert.equal(first.targetEntity, "pandawa:janaka");
  assert.equal(first.memoryNamespace, "pandawa:janaka");
  assert.deepEqual(first.contextRefs, []);
  assert.equal(first.authorityContextRef, null);
  now = 200;
  const resumed = sessions.resume(first.sessionId, { ownerUserId: "owner", targetEntity: "pandawa:janaka" });
  assert.equal(resumed.targetEntity, first.targetEntity);
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.authorityContextRef, null);
  assert.throws(() => sessions.resume(first.sessionId, { ownerUserId: "attacker" }), /RESUME_DENIED/);
  assert.throws(() => sessions.resume(first.sessionId, { ownerUserId: "owner", targetEntity: "bima" }), /TARGET_MISMATCH/);
  sessions.create({ sessionId: "ses_second", targetEntity: "pandawa:sadewa", ownerUserId: "owner" });
  assert.throws(() => sessions.create({ sessionId: "ses_fake", targetEntity: "pandawa:janaka", ownerUserId: "owner", authorityContextRef: "forged" }), /SESSION_LIMIT/);
});

test("P3: delegation is private, bounded, and does not transfer authority", () => {
  const issued = delegation.createDelegation({
    fromEntity: "janaka", toEntity: "bima", sourceSession: "ses_j", targetSession: "ses_w",
    objective: "Review the patch", reason: "security review", contextRefs: ["artifact:patch"], requestedCapabilities: ["read"]
  });
  assert.equal(issued.fromEntity, "pandawa:janaka");
  assert.equal(issued.toEntity, "pandawa:werkudara");
  assert.equal("authority" in issued, false);
  assert.deepEqual(delegation.projectHandoff(issued, { receiver: "werkudara", sessionId: "ses_w" }).contextRefs, ["artifact:patch"]);
  assert.throws(() => delegation.acceptDelegation({ ...issued }, { receiver: "werkudara", sessionId: "ses_w" }), /UNTRUSTED/);
  assert.throws(() => delegation.acceptDelegation(issued, { receiver: "janaka", sessionId: "ses_w" }), /TARGET_INVALID/);
  assert.throws(() => delegation.acceptDelegation(issued, { receiver: "werkudara", sessionId: "ses_other" }), /TARGET_INVALID/);
  assert.throws(() => delegation.createDelegation({ fromEntity: "janaka", toEntity: "werkudara", sourceSession: "ses_j", objective: "x", reason: "x", contextRefs: Array(33).fill("x") }), /CONTEXT_INVALID/);
});
