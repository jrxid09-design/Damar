"use strict";

// This is a transport-to-Manager data boundary, not a Manager composition
// factory.  Possession is process-local and identity-based; copied context
// shapes do not acquire the brand.
const canonicalContexts = new WeakSet();

function createCanonicalMediaContext(attachments) {
  if (!Array.isArray(attachments) || !Object.isFrozen(attachments) || attachments.length > 8) {
    throw new TypeError("MEDIA_CONTEXT_INVALID");
  }
  const context = Object.freeze({ attachments });
  canonicalContexts.add(context);
  return context;
}

function isCanonicalMediaContext(value) {
  return value !== null && typeof value === "object" && !require("node:util").types.isProxy(value) && canonicalContexts.has(value);
}

module.exports = Object.freeze({ createCanonicalMediaContext, isCanonicalMediaContext });
