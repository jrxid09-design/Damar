"use strict";

/**
 * CANONICAL TRANSPORT PEER MINT — INTERNAL COMPOSITION ENTRY POINT
 * (Wave 5 Lane 4, repair R6 / DSC-R5-003).
 *
 * This module is NOT part of the public session-continuity package surface.
 * `src/runtime/sessionContinuity/index.js` does NOT re-export it.  It is
 * imported directly and ONLY by the canonical RuntimeHost transport
 * composition (`src/manager/bootstrap.js`), which owns the trusted per-runtime
 * transport peer scopes.
 *
 * LAW: UNTRUSTED CALLER CANNOT MINT TRANSPORT IDENTITY.
 *
 * The mint below is the SOLE production source of canonical
 * TransportPeerHandles.  It:
 *
 *   - mints ONLY for channels the honest matrix marks SUPPORTED (fail-closed
 *     otherwise);
 *   - derives the peer value from a fixed RUNTIME-OWNED constant
 *     (`<channel>-runtime-owner`) — never from a raw event field, caller
 *     payload, or transport-session id;
 *   - brands the handle with a SCOPE-PRIVATE WeakSet, so the SAME scope that
 *     mints a handle is the ONLY scope that recognizes it (per-scope
 *     provenance — a foreign scope's handle is rejected even with the same
 *     channel string).
 *
 * Ordinary production callers do NOT import this module.  Test-scope
 * construction lives in tests/helpers/testTransportPeer.js (outside the
 * production tree).
 */

const {
  TRANSPORT_CONTINUITY_SUPPORT,
  _internal
} = require("./transportPeer");

const { CHANNEL_NAME_RE, peerValueIsValid, canonicalRuntimePeerValue } = _internal;

/**
 * PRIVATE TRUSTED MINT (DSC-R4-001 / DSC-R5-003).
 *
 * Creates a FRESH per-runtime scope for `channel` and mints the canonical
 * runtime-owner TransportPeerHandle from it.  Returns BOTH the scope (the
 * only object that will ever recognize this handle) and the handle, so the
 * RuntimeHost composition can keep them bound together in private closure
 * state.
 *
 * Reachable ONLY by the canonical RuntimeHost transport composition.  An
 * ordinary module can never obtain the returned scope, and therefore can
 * never mint a handle the canonical composition accepts.
 *
 * Fail-closed: an UNSUPPORTED channel throws; the caller cannot mint a peer
 * for a channel the honest matrix does not support.
 */
function mintCanonicalTransportPeerHandle(channel) {
  if (typeof channel !== "string" || !CHANNEL_NAME_RE.test(channel)) {
    throw Object.assign(new TypeError("TRANSPORT_PEER_CHANNEL_INVALID"), { code: "TRANSPORT_PEER_CHANNEL_INVALID" });
  }
  const verdict = TRANSPORT_CONTINUITY_SUPPORT[channel];
  if (!verdict || verdict.supported !== true) {
    throw Object.assign(new Error("TRANSPORT_PEER_UNSUPPORTED"), { code: "TRANSPORT_PEER_UNSUPPORTED" });
  }
  const brand = new WeakSet(); // SCOPE-PRIVATE provenance brand (DSC-R4-001)
  const peerValue = canonicalRuntimePeerValue(channel);
  if (!peerValueIsValid(peerValue)) {
    throw Object.assign(new Error("TRANSPORT_PEER_INVALID"), { code: "TRANSPORT_PEER_INVALID" });
  }
  const handle = Object.freeze({
    kind: "TransportPeerHandle",
    channel,
    peer: peerValue,
    scope: verdict.scope
  });
  brand.add(handle);
  const scope = Object.freeze({
    channel,
    supported: true,
    scope: verdict.scope,
    /** This scope recognizes ONLY handles it minted itself. */
    isHandle(value) {
      return value !== null && typeof value === "object" && brand.has(value);
    }
  });
  return Object.freeze({ scope, handle });
}

module.exports = Object.freeze({ mintCanonicalTransportPeerHandle });
