"use strict";

const { BusError } = require("./errors");

function freezeSet(values) {
  return Object.freeze(new Set(values));
}

const INTERACTION_ORIGINS = Object.freeze([
  "VOICE",
  "PRESENCE",
  "HOTKEY",
  "OBSERVATORY",
  "TELEGRAM",
  "WHATSAPP",
  "API",
  "SYSTEM",
  "TEST"
]);

const INTERACTION_KINDS = Object.freeze([
  "MESSAGE",
  "COMMAND",
  "APPROVAL_RESPONSE",
  "CANCEL_REQUEST",
  "STATUS_REQUEST",
  "CONTEXT_REFERENCE",
  "AUTH_EVIDENCE",
  "EVENT"
]);

const INTERACTION_STATES = Object.freeze([
  "RECEIVED",
  "VALIDATED",
  "QUEUED",
  "DISPATCHED",
  "STREAMING",
  "COMPLETED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "FAILED",
  "EXPIRED"
]);

const RESPONSE_KINDS = Object.freeze([
  "TEXT_DELTA",
  "TEXT_FINAL",
  "VOICE_HINT",
  "STATUS",
  "APPROVAL_REQUIRED",
  "ERROR",
  "COMPLETE"
]);

const ROUTES = Object.freeze([
  "CONVERSATION",
  "COMMAND",
  "APPROVAL",
  "STATUS",
  "CONTROL"
]);

const STREAM_EVENT_TYPES = Object.freeze([
  "START",
  "DELTA",
  "STATUS",
  "APPROVAL_REQUIRED",
  "FINAL",
  "ERROR",
  "COMPLETE"
]);

const TERMINAL_STATES = freezeSet(["COMPLETED", "CANCELLED", "FAILED", "EXPIRED"]);

const ORIGIN_SET = freezeSet(INTERACTION_ORIGINS);
const KIND_SET = freezeSet(INTERACTION_KINDS);
const STATE_SET = freezeSet(INTERACTION_STATES);
const RESPONSE_KIND_SET = freezeSet(RESPONSE_KINDS);
const ROUTE_SET = freezeSet(ROUTES);
const STREAM_EVENT_SET = freezeSet(STREAM_EVENT_TYPES);

function assertEnum(value, set, label) {
  if (typeof value === "string" && set.has(value)) return value;
  throw new BusError("INVALID_ENUM", `value is not a valid ${label}`, {
    field: label
  });
}

module.exports = {
  INTERACTION_ORIGINS,
  INTERACTION_KINDS,
  INTERACTION_STATES,
  RESPONSE_KINDS,
  ROUTES,
  STREAM_EVENT_TYPES,
  TERMINAL_STATES,
  ORIGIN_SET,
  KIND_SET,
  STATE_SET,
  RESPONSE_KIND_SET,
  ROUTE_SET,
  STREAM_EVENT_SET,
  assertEnum
};
