"use strict";

/**
 * TEST-ONLY transport peer scope factory (DSC-R5-003).
 *
 * This helper lives OUTSIDE the production source tree so that the
 * production module `src/runtime/sessionContinuity/transportPeer.js` does NOT
 * export any scope-construction factory.  It builds a standalone per-scope
 * TransportPeerScope for ISOLATED continuity-domain unit tests (provenance /
 * link / conflict semantics).
 *
 * The scope mints handles branded by its OWN private WeakSet — per-scope
 * provenance, identical in shape to the canonical mint.  Because provenance
 * is per-scope, a handle minted here is NEVER recognized by the canonical
 * RuntimeHost composition's scopes (a different scope object, a different
 * brand), so this helper cannot weaken the production trust boundary.
 *
 * NOT for production use.  Production callers must never depend on this.
 */

const CHANNEL_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PEER_BYTES = 128;

function peerValueIsValid(peerValue) {
  if (typeof peerValue !== "string" || peerValue.length === 0) return false;
  if (peerValue.trim().length === 0) return false;
  if (/[\u0000-\u001f\u007f]/.test(peerValue)) return false;
  if (Buffer.byteLength(peerValue, "utf8") > MAX_PEER_BYTES) return false;
  return true;
}

function createTestTransportPeerScope({ channel, scope: scopeName = "TEST" } = {}) {
  if (typeof channel !== "string" || !CHANNEL_NAME_RE.test(channel)) {
    throw Object.assign(new TypeError("TRANSPORT_PEER_SCOPE_CHANNEL_INVALID"), { code: "TRANSPORT_PEER_SCOPE_CHANNEL_INVALID" });
  }
  const brand = new WeakSet(); // SCOPE-PRIVATE provenance brand
  return Object.freeze({
    channel,
    scope: scopeName,
    mint(peerValue) {
      if (!peerValueIsValid(peerValue)) {
        throw Object.assign(new Error("TRANSPORT_PEER_INVALID"), { code: "TRANSPORT_PEER_INVALID" });
      }
      const handle = Object.freeze({
        kind: "TransportPeerHandle",
        channel,
        peer: peerValue,
        scope: scopeName
      });
      brand.add(handle);
      return handle;
    },
    /** This scope recognizes ONLY handles it minted itself. */
    isHandle(value) {
      return value !== null && typeof value === "object" && brand.has(value);
    }
  });
}

module.exports = Object.freeze({ createTestTransportPeerScope });
