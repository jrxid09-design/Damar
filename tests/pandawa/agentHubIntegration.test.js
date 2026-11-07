"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const agentHub = require("../../src/services/agentHub");

test("P1: AgentHub exposes canonical Pandawa targets without role authority", () => {
  assert.equal(agentHub.resolveTarget("Arjuna, review this").id, "pandawa:janaka");
  assert.equal(agentHub.resolveTarget("Bima, cek ini").id, "pandawa:werkudara");
  assert.equal(agentHub.identityOf("Yudistira").id, "pandawa:puntadewa");
  assert.equal(agentHub.get("arjuna").id, "janaka");
  assert.equal(agentHub.get("bima").id, "werkudara");
  assert.equal(agentHub.get("pandawa:janaka"), null);
});

test("P2/P3: AgentHub owns bounded sessions and private delegation", () => {
  const sessionId = `ses_lane6_${Date.now()}`;
  const session = agentHub.createPandawaSession({ sessionId, targetEntity: "janaka", ownerUserId: "owner", surface: "console", channel: "console" });
  assert.equal(session.targetEntity, "pandawa:janaka");
  const resumed = agentHub.resumePandawaSession(sessionId, { ownerUserId: "owner", targetEntity: "Arjuna" });
  assert.equal(resumed.targetEntity, session.targetEntity);
  const handoff = agentHub.createPandawaDelegation({ fromEntity: "janaka", toEntity: "werkudara", sourceSession: sessionId, targetSession: "ses_review", objective: "review", reason: "security", contextRefs: ["artifact:1"] });
  assert.throws(() => agentHub.acceptPandawaDelegation({ ...handoff }, { receiver: "werkudara", sessionId: "ses_review" }), /UNTRUSTED/);
  assert.equal(agentHub.acceptPandawaDelegation(handoff, { receiver: "werkudara", sessionId: "ses_review" }).toEntity, "pandawa:werkudara");
});
