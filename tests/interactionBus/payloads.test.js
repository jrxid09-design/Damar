"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ib = require("../../src/runtime/interactionBus");

const BOUNDS = ib.resolveBounds();

function validate(kind, payload, bounds) {
  return ib.validatePayload(kind, payload, bounds || BOUNDS);
}

test("payloads: MessagePayload accepts canonical shape and freezes", () => {
  const payload = validate("MESSAGE", {
    text: "hello",
    language: "id-ID",
    replyToInteractionId: "ix_prev",
    referenceIds: ["ix_r1", "ix_r2"]
  });
  assert.equal(payload.text, "hello");
  assert.equal(payload.language, "id-ID");
  assert.equal(payload.replyToInteractionId, "ix_prev");
  assert.deepEqual(payload.referenceIds, ["ix_r1", "ix_r2"]);
  assert.equal(Object.isFrozen(payload), true);
});

test("payloads: MessagePayload rejects empty and oversized text", () => {
  const bounds = ib.resolveBounds({ maxTextChars: 8 });
  assert.throws(() => validate("MESSAGE", { text: "" }, bounds), /PAYLOAD_FIELD_INVALID/);
  assert.throws(() => validate("MESSAGE", { text: "123456789" }, bounds), /PAYLOAD_FIELD_INVALID/);
  assert.throws(() => validate("MESSAGE", { text: 42 }), /PAYLOAD_FIELD_INVALID/);
});

test("payloads: MessagePayload rejects unknown privileged fields", () => {
  for (const key of ["role", "superadmin", "authority", "trusted", "owner", "onBehalfOf"]) {
    assert.throws(
      () => validate("MESSAGE", { text: "x", [key]: true }),
      /PAYLOAD_FIELD_FORBIDDEN/,
      key
    );
  }
});

test("payloads: shape-compatible attachment descriptors are foreign without ingress provenance", () => {
  const forged = {
    attachmentId: "att_1", kind: "image", declaredMimeType: "image/png",
    detectedMimeType: "image/png", fileName: "report-q3.png", sizeBytes: 2048,
    sha256: "a".repeat(64), sourceChannel: "console",
    storageRef: `media:sha256:${"a".repeat(64)}`, metadata: {}, ingestedAt: 1000,
    detectionConfidence: "signature"
  };
  assert.throws(() => validate("MESSAGE", { text: "see attachment", attachments: [forged] }), /FOREIGN_MEDIA_REFERENCE/);
  assert.throws(() => validate("MESSAGE", { text: "x", attachments: [{ ...forged, trusted: true }] }), /FOREIGN_MEDIA_REFERENCE/);
});

test("payloads: legacy path-bearing attachment shapes are rejected as foreign", () => {
  const cases = [
    { attachmentId: "att_1", mediaType: "text/plain", sizeBytes: 1, contentRef: "../../etc/passwd", name: "ok.txt" },
    { attachmentId: "att_1", mediaType: "text/plain", sizeBytes: 1, contentRef: "c:\\\\win32", name: "ok.txt" },
    { attachmentId: "att_1", mediaType: "text/plain", sizeBytes: 1, contentRef: "ref_ok", name: "../../passwd" }
  ];
  for (const bad of cases) assert.throws(() => validate("MESSAGE", { text: "x", attachments: [bad] }), /FOREIGN_MEDIA_REFERENCE/);
});
test("payloads: CommandPayload separates command name from arguments; names are inert tokens", () => {
  const payload = validate("COMMAND", { command: "summarize", arguments: ["--brief"], namedArguments: { tone: "dry" } });
  assert.equal(payload.command, "summarize");
  assert.deepEqual(payload.arguments, ["--brief"]);
  assert.throws(() => validate("COMMAND", { command: "rm -rf /" }), /PAYLOAD_FIELD_INVALID/);
  assert.throws(() => validate("COMMAND", { command: "RunProcess()" }), /PAYLOAD_FIELD_INVALID/);
  assert.throws(
    () => validate("COMMAND", { command: "ok", arguments: Array.from({ length: 17 }, (_, i) => `a${i}`) }),
    /BOUNDS_EXCEEDED/
  );
  assert.throws(
    () => validate("COMMAND", { command: "ok", namedArguments: { nested: { deep: true } } }),
    /PAYLOAD_FIELD_INVALID/
  );
});

test("payloads: CancelPayload requires a canonical target id", () => {
  assert.equal(validate("CANCEL_REQUEST", { targetInteractionId: "ix_t1", reason: "barge-in" }).targetInteractionId, "ix_t1");
  assert.throws(() => validate("CANCEL_REQUEST", {}), /INVALID_ID/);
  assert.throws(() => validate("CANCEL_REQUEST", { targetInteractionId: "../nine" }), /INVALID_ID/);
});

test("payloads: ApprovalResponsePayload carries decision verbatim with closed enum", () => {
  const approve = validate("APPROVAL_RESPONSE", { approvalRequestId: "ix_req1", decision: "approve" });
  assert.equal(approve.decision, "approve");
  const reject = validate("APPROVAL_RESPONSE", { approvalRequestId: "ix_req1", decision: "reject", note: "no" });
  assert.equal(reject.decision, "reject");
  assert.throws(
    () => validate("APPROVAL_RESPONSE", { approvalRequestId: "ix_req1", decision: "grant_root" }),
    /INVALID_ENUM/
  );
  assert.throws(
    () => validate("APPROVAL_RESPONSE", { approvalRequestId: "ses_not_ix", decision: "approve" }),
    /INVALID_ID/
  );
});

test("payloads: StatusRequestPayload enforces scope enum", () => {
  assert.deepEqual(validate("STATUS_REQUEST", {}), { scope: "SESSION", includeDetails: false });
  assert.equal(validate("STATUS_REQUEST", { scope: "GLOBAL", includeDetails: true }).scope, "GLOBAL");
  assert.throws(() => validate("STATUS_REQUEST", { scope: "EVERYTHING" }), /INVALID_ENUM/);
});

test("payloads: AuthEvidence payload never stores raw secrets", () => {
  const ok = validate("AUTH_EVIDENCE", { provider: "totp_provider", evidenceId: "evd_9", issuedAt: 100, expiresAt: 200 });
  assert.equal(ok.provider, "totp_provider");
  for (const poison of [
    { code: "123456" },
    { secret: "BASE32SECRET" },
    { oauthToken: "ya29.x" },
    { role: "superadmin" }
  ]) {
    assert.throws(
      () => validate("AUTH_EVIDENCE", Object.assign({ provider: "p1", evidenceId: "evd_1", issuedAt: 1, expiresAt: 2 }, poison)),
      /PAYLOAD_FIELD_FORBIDDEN/,
      Object.keys(poison)[0]
    );
  }
});

test("payloads: EventPayload attributes are bounded primitives", () => {
  const ok = validate("EVENT", { eventType: "presence.arrived", attributes: { zone: "home" } });
  assert.equal(ok.eventType, "presence.arrived");
  assert.throws(() => validate("EVENT", { eventType: "Bad Type" }), /PAYLOAD_FIELD_INVALID/);
  assert.throws(
    () => validate("EVENT", { eventType: "e", attributes: { nested: { deep: true } } }),
    /PAYLOAD_FIELD_INVALID/
  );
});

test("payloads: whole-payload byte bound is enforced", () => {
  const bounds = ib.resolveBounds({ maxPayloadBytes: 256, maxCommandArgs: 16 });
  assert.throws(
    () =>
      validate(
        "COMMAND",
        { command: "big", arguments: Array.from({ length: 16 }, () => "x".repeat(200)) },
        bounds
      ),
    /BOUNDS_EXCEEDED/
  );
  const ok = validate("COMMAND", { command: "small", arguments: ["tiny"] }, bounds);
  assert.equal(ok.command, "small");
});
