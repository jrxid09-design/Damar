"use strict";

const crypto = require("node:crypto");
const { BusError } = require("./errors");

const ID_TYPES = Object.freeze([
  "interactionId",
  "sessionId",
  "correlationId",
  "turnId",
  "runtimeGenerationId",
  "transportId",
  "attachmentId",
  "evidenceId"
]);

const SEGMENT = "[a-z0-9][a-z0-9_-]{0,62}";

const ID_RULES = Object.freeze({
  interactionId: new RegExp(`^ix_${SEGMENT}$`),
  sessionId: new RegExp(`^ses_${SEGMENT}$`),
  correlationId: new RegExp(`^cor_${SEGMENT}$`),
  turnId: new RegExp(`^trn_${SEGMENT}$`),
  runtimeGenerationId: new RegExp(`^gen_${SEGMENT}$`),
  transportId: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){0,7}$/,
  attachmentId: new RegExp(`^att_${SEGMENT}$`),
  evidenceId: new RegExp(`^evd_${SEGMENT}$`)
});

const ID_MAX_LENGTHS = Object.freeze({
  interactionId: 67,
  sessionId: 67,
  correlationId: 67,
  turnId: 67,
  runtimeGenerationId: 67,
  transportId: 64,
  attachmentId: 67,
  evidenceId: 67
});

function isCanonicalId(type, value) {
  const rule = ID_RULES[type];
  if (!rule) return false;
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > ID_MAX_LENGTHS[type]) return false;
  return rule.test(value);
}

function assertCanonicalId(type, value) {
  if (isCanonicalId(type, value)) return value;
  throw new BusError("INVALID_ID", `value is not a canonical ${type}`, {
    idType: type
  });
}

const ID_PREFIXES = Object.freeze({
  interactionId: "ix",
  sessionId: "ses",
  correlationId: "cor",
  turnId: "trn",
  runtimeGenerationId: "gen",
  attachmentId: "att",
  evidenceId: "evd"
});

function prefixFor(type) {
  const prefix = ID_PREFIXES[type];
  if (!prefix) {
    throw new BusError("INVALID_ID_TYPE", `unknown id type ${type}`);
  }
  if (type === "transportId") {
    throw new BusError("INVALID_ID_TYPE", "transportId is code-registered, not factory-generated");
  }
  return prefix;
}

function createSequentialIdFactory(seed) {
  let counter = Math.floor(Number(seed) || 0);
  function pad(n) {
    return String(n).padStart(12, "0");
  }
  return Object.freeze({
    next(type) {
      counter += 1;
      return `${prefixFor(type)}_${pad(counter)}`;
    }
  });
}

function createCryptoIdFactory() {
  return Object.freeze({
    next(type) {
      return `${prefixFor(type)}_${crypto.randomBytes(16).toString("hex")}`;
    }
  });
}

module.exports = {
  ID_TYPES,
  ID_RULES,
  ID_MAX_LENGTHS,
  isCanonicalId,
  assertCanonicalId,
  createSequentialIdFactory,
  createCryptoIdFactory
};
