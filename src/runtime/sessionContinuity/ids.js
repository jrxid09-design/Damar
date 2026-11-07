"use strict";

/**
 * DAMAR SESSION CONTINUITY — canonical IDs (Wave 5 Lane 4).
 *
 * The canonical Damar session identity is minted ONLY by the session
 * continuity domain.  It is deliberately a DISTINCT namespace (`dsc_`) from
 * the bus `ses_*` transport-facing session ids so that no transport id, chat
 * id, JID, voice id, socket id, or UI connection id can ever BE (or be
 * mistaken for) the canonical session identity.
 *
 *   TRANSPORT ID != DAMAR IDENTITY
 *   SESSION ID != AUTHORIZATION TOKEN
 *   SESSION ID != CAPABILITY
 *   SESSION BINDING != AUTHORITY
 *
 * IDs are inert lowercase identity strings.  They carry no authority
 * semantics and no path semantics.
 */

const CONTINUITY_ID_RE = /^dsc_[a-z0-9][a-z0-9_-]{0,62}$/;
const INCARNATION_RE = /^[0-9]{1,10}$/;

function isCanonicalContinuitySessionId(value) {
  return typeof value === "string" && CONTINUITY_ID_RE.test(value);
}

function assertCanonicalContinuitySessionId(value) {
  if (!isCanonicalContinuitySessionId(value)) {
    const error = new Error(`[INVALID_CONTINUITY_ID] value is not a canonical dsc_ session id`);
    error.name = "SessionContinuityError";
    error.code = "INVALID_CONTINUITY_ID";
    throw error;
  }
  return value;
}

function isIncarnation(value) {
  return typeof value === "string" && INCARNATION_RE.test(value) && Number(value) >= 1;
}

/** Deterministic sequential factory (tests / deterministic ids). */
function createSequentialContinuityIdFactory(seed = 0) {
  let counter = Math.floor(Number(seed) || 0);
  return Object.freeze({
    next() {
      counter += 1;
      return `dsc_${String(counter).padStart(12, "0")}`;
    }
  });
}

/** Crypto factory (production default). */
function createCryptoContinuityIdFactory(randomBytes = null) {
  const rng = randomBytes === null
    ? (n) => require("node:crypto").randomBytes(n)
    : randomBytes;
  if (typeof rng !== "function") {
    throw new TypeError("CONTINUITY_ID_FACTORY_INVALID");
  }
  return Object.freeze({
    next() {
      return `dsc_${rng(16).toString("hex")}`;
    }
  });
}

module.exports = Object.freeze({
  CONTINUITY_ID_RE,
  isCanonicalContinuitySessionId,
  assertCanonicalContinuitySessionId,
  isIncarnation,
  createSequentialContinuityIdFactory,
  createCryptoContinuityIdFactory
});
