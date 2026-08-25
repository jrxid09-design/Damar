"use strict";

const { BusError } = require("./errors");
const { assertCanonicalId } = require("./ids");
const { assertEnum } = require("./enums");

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",");
  return `{${body}}`;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code, detail) {
  throw new BusError(code, code.toLowerCase(), detail);
}

function rejectForbiddenFields(raw, allowed, what) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail("PAYLOAD_FIELD_FORBIDDEN", { scope: what, field: key });
    }
  }
}

function optionalString(raw, key, maxLen, what) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    fail("PAYLOAD_FIELD_INVALID", { scope: what, field: key });
  }
  return value;
}

const FORBIDDEN_META_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const META_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validateBoundedRecord(raw, key, bounds, what) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: what, field: key });
  }
  const entries = Object.entries(value);
  const keyCaps = [
    Number.isSafeInteger(bounds.maxClaimedFields) ? bounds.maxClaimedFields : Infinity,
    Number.isSafeInteger(bounds.maxMetadataKeys) ? bounds.maxMetadataKeys : Infinity
  ];
  const keyCap = Math.min(...keyCaps);
  if (entries.length > keyCap) {
    fail("BOUNDS_EXCEEDED", { scope: what, field: key });
  }
  const out = {};
  for (const [k, v] of entries) {
    if (FORBIDDEN_META_KEYS.has(k) || !META_KEY_RE.test(k)) {
      fail("PAYLOAD_FIELD_INVALID", { scope: what, field: k });
    }
    if (
      !(typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) ||
      (typeof v === "number" && !Number.isFinite(v))
    ) {
      fail("PAYLOAD_FIELD_INVALID", { scope: what, field: k });
    }
    out[k] = v;
  }
  if (byteLength(canonicalize(out)) > bounds.maxMetadataBytes) {
    fail("BOUNDS_EXCEEDED", { scope: what, field: key });
  }
  return out;
}

const MEDIA_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const CONTENT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateAttachment(value, bounds) {
  if (!isPlainObject(value)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "attachment" });
  }
  rejectForbiddenFields(
    value,
    ["attachmentId", "mediaType", "sizeBytes", "contentRef", "name"],
    "attachment"
  );
  assertCanonicalId("attachmentId", value.attachmentId);
  if (typeof value.mediaType !== "string" || !MEDIA_TYPE_RE.test(value.mediaType)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "attachment", field: "mediaType" });
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > bounds.maxPayloadBytes) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "attachment", field: "sizeBytes" });
  }
  if (
    typeof value.contentRef !== "string" ||
    !CONTENT_REF_RE.test(value.contentRef) ||
    value.contentRef.includes("..")
  ) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "attachment", field: "contentRef" });
  }
  const name = value.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 128 ||
    /[\\/\u0000-\u001F]/.test(name) ||
    name === "." ||
    name === ".." ||
    name.startsWith(".")
  ) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "attachment", field: "name" });
  }
  return Object.freeze({
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    contentRef: value.contentRef,
    name
  });
}

const PROVIDER_RE = /^[a-z][a-z0-9_]{1,31}$/;

function validateAuthEvidence(value) {
  if (!isPlainObject(value)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "authEvidence" });
  }
  rejectForbiddenFields(value, ["provider", "evidenceId", "issuedAt", "expiresAt"], "authEvidence");
  if (typeof value.provider !== "string" || !PROVIDER_RE.test(value.provider)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "authEvidence", field: "provider" });
  }
  assertCanonicalId("evidenceId", value.evidenceId);
  if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "authEvidence", field: "issuedAt" });
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < value.issuedAt) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "authEvidence", field: "expiresAt" });
  }
  return Object.freeze({
    provider: value.provider,
    evidenceId: value.evidenceId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt
  });
}

const CONTEXT_REF_TYPE_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function validateContextRef(value) {
  if (!isPlainObject(value)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "contextRef" });
  }
  rejectForbiddenFields(value, ["type", "ref"], "contextRef");
  if (typeof value.type !== "string" || !CONTEXT_REF_TYPE_RE.test(value.type)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "contextRef", field: "type" });
  }
  if (
    typeof value.ref !== "string" ||
    !CONTENT_REF_RE.test(value.ref) ||
    value.ref.includes("..")
  ) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "contextRef", field: "ref" });
  }
  return Object.freeze({ type: value.type, ref: value.ref });
}

function validateMessagePayload(raw, bounds) {
  rejectForbiddenFields(
    raw,
    ["text", "language", "attachments", "replyToInteractionId", "referenceIds"],
    "MESSAGE"
  );
  const text = raw.text;
  if (typeof text !== "string" || text.length === 0 || text.length > bounds.maxTextChars) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "MESSAGE", field: "text" });
  }
  let language;
  if (raw.language !== undefined) {
    if (typeof raw.language !== "string" || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(raw.language)) {
      fail("PAYLOAD_FIELD_INVALID", { scope: "MESSAGE", field: "language" });
    }
    language = raw.language;
  }
  let attachments;
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > bounds.maxAttachments) {
      fail("BOUNDS_EXCEEDED", { scope: "MESSAGE", field: "attachments" });
    }
    attachments = Object.freeze(raw.attachments.map((a) => validateAttachment(a, bounds)));
  }
  let replyToInteractionId;
  if (raw.replyToInteractionId !== undefined) {
    replyToInteractionId = assertCanonicalId("interactionId", raw.replyToInteractionId);
  }
  let referenceIds;
  if (raw.referenceIds !== undefined) {
    if (!Array.isArray(raw.referenceIds) || raw.referenceIds.length > bounds.maxContextRefs) {
      fail("BOUNDS_EXCEEDED", { scope: "MESSAGE", field: "referenceIds" });
    }
    referenceIds = Object.freeze(raw.referenceIds.map((id) => assertCanonicalId("interactionId", id)));
  }
  return Object.freeze({
    text,
    language,
    attachments,
    replyToInteractionId,
    referenceIds
  });
}

const COMMAND_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function validateCommandPayload(raw, bounds) {
  rejectForbiddenFields(raw, ["command", "arguments", "namedArguments"], "COMMAND");
  if (typeof raw.command !== "string" || !COMMAND_NAME_RE.test(raw.command)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "COMMAND", field: "command" });
  }
  let args;
  if (raw.arguments !== undefined) {
    if (!Array.isArray(raw.arguments) || raw.arguments.length > bounds.maxCommandArgs) {
      fail("BOUNDS_EXCEEDED", { scope: "COMMAND", field: "arguments" });
    }
    args = Object.freeze(
      raw.arguments.map((arg) => {
        if (typeof arg !== "string" || arg.length > 256) {
          fail("PAYLOAD_FIELD_INVALID", { scope: "COMMAND", field: "arguments" });
        }
        return arg;
      })
    );
  }
  const namedArguments = validateBoundedRecord(raw, "namedArguments", bounds, "COMMAND");
  return Object.freeze({ command: raw.command, arguments: args, namedArguments });
}

function validateCancelPayload(raw) {
  rejectForbiddenFields(raw, ["targetInteractionId", "reason"], "CANCEL_REQUEST");
  const targetInteractionId = assertCanonicalId("interactionId", raw.targetInteractionId);
  const reason = optionalString(raw, "reason", 256, "CANCEL_REQUEST");
  return Object.freeze({ targetInteractionId, reason });
}

function validateApprovalResponsePayload(raw) {
  rejectForbiddenFields(raw, ["approvalRequestId", "decision", "note"], "APPROVAL_RESPONSE");
  const approvalRequestId = assertCanonicalId("interactionId", raw.approvalRequestId);
  const decision = assertEnum(raw.decision, new Set(["approve", "reject"]), "approval decision");
  const note = optionalString(raw, "note", 256, "APPROVAL_RESPONSE");
  return Object.freeze({ approvalRequestId, decision, note });
}

function validateStatusRequestPayload(raw) {
  rejectForbiddenFields(raw, ["scope", "includeDetails"], "STATUS_REQUEST");
  let scope = "SESSION";
  if (raw.scope !== undefined) {
    scope = assertEnum(raw.scope, new Set(["SESSION", "GLOBAL"]), "status scope");
  }
  let includeDetails = false;
  if (raw.includeDetails !== undefined) {
    if (typeof raw.includeDetails !== "boolean") {
      fail("PAYLOAD_FIELD_INVALID", { scope: "STATUS_REQUEST", field: "includeDetails" });
    }
    includeDetails = raw.includeDetails;
  }
  return Object.freeze({ scope, includeDetails });
}

function validateAuthEvidencePayload(raw) {
  return validateAuthEvidence(raw);
}

function validateEventPayload(raw, bounds) {
  rejectForbiddenFields(raw, ["eventType", "attributes"], "EVENT");
  if (typeof raw.eventType !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(raw.eventType)) {
    fail("PAYLOAD_FIELD_INVALID", { scope: "EVENT", field: "eventType" });
  }
  const attributes = validateBoundedRecord(raw, "attributes", bounds, "EVENT");
  return Object.freeze({ eventType: raw.eventType, attributes });
}

function validateContextReferencePayload(raw) {
  rejectForbiddenFields(raw, ["reference"], "CONTEXT_REFERENCE");
  return Object.freeze({ reference: validateContextRef(raw.reference) });
}

const PAYLOAD_VALIDATORS = {
  MESSAGE: validateMessagePayload,
  COMMAND: validateCommandPayload,
  CANCEL_REQUEST: validateCancelPayload,
  APPROVAL_RESPONSE: validateApprovalResponsePayload,
  STATUS_REQUEST: validateStatusRequestPayload,
  AUTH_EVIDENCE: validateAuthEvidencePayload,
  EVENT: validateEventPayload,
  CONTEXT_REFERENCE: validateContextReferencePayload
};

function validatePayload(kind, raw, bounds) {
  const validator = PAYLOAD_VALIDATORS[kind];
  if (!validator) {
    fail("KIND_HAS_NO_PAYLOAD_SCHEMA", { kind });
  }
  if (!isPlainObject(raw)) {
    fail("PAYLOAD_NOT_OBJECT", { kind });
  }
  const payload = validator(raw, bounds);
  if (byteLength(canonicalize(payload)) > bounds.maxPayloadBytes) {
    fail("BOUNDS_EXCEEDED", { scope: kind, field: "payloadBytes" });
  }
  return payload;
}

module.exports = {
  canonicalize,
  byteLength,
  isPlainObject,
  validatePayload,
  validateAttachment,
  validateAuthEvidence,
  validateContextRef,
  validateBoundedRecord,
  FORBIDDEN_META_KEYS,
  META_KEY_RE,
  COMMAND_NAME_RE,
  PROVIDER_RE
};
