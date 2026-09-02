"use strict";

/**
 * DAMAR TRANSPORT PEER HANDLES — trusted transport-owned identity evidence
 * (Wave 5 Lane 4 continuity, repair R4 / DSC-R3-001).
 *
 * LAW: UNTRUSTED EVENT DATA CANNOT ESTABLISH CONTINUITY IDENTITY.
 *       TRANSPORT SESSION != PEER IDENTITY.
 *
 * A TransportPeerHandle is the ONLY value the continuity domain accepts as
 * peer-evidence input.  It is:
 *
 *   - constructed ONLY inside the canonical transport adapter / trusted
 *     composition (createTransportPeerScope), never from a raw event;
 *   - a closure/capability object branded by a module-private WeakSet — a
 *     raw public ingest object CANNOT emulate it by matching its shape;
 *   - carried OUT-OF-BAND: the handle travels through trusted runtime state
 *     (the adapter's own registration), never through the raw event payload;
 *   - transport-scoped: the same peer value under two different channels is
 *     two different identities unless explicitly linked;
 *   - non-authoritative: it confers zero privilege.
 *
 * HONEST PER-TRANSPORT SUPPORT MATRIX (fail-closed by default):
 *
 *   telegram : UNSUPPORTED in the current runtime — the canonical Telegram
 *              surface (channelBridge telemetry) exposes only a claimed,
 *              unauthenticated chatId.  No transport-library-authenticated
 *              sender identity is wired into the canonical ingress today.
 *              Continuity binding FAILS CLOSED for telegram; the ordinary
 *              ses_* interaction path continues unchanged.
 *
 *   whatsapp : UNSUPPORTED for the same reason (claimed JID from telemetry,
 *              no socket-authenticated JID seam at the ingress).
 *
 *   console  : SUPPORTED as RUNTIME-OWNER scope — the local console is the
 *              runtime's own operator surface (single, local, trusted-host
 *              execution).  Identity semantics: "the local Damar owner",
 *              DEVICE/RUNTIME-SCOPED, not a human-peer identity.
 *
 *   voice    : SUPPORTED as RUNTIME/DEVICE scope — the voice runtime is the
 *              local owner's audio surface (one runtime = one owner scope).
 *              Identity semantics: DEVICE/RUNTIME-SCOPED voice continuity,
 *              NOT physical-speaker identity.  All physical speakers sharing
 *              the runtime share one continuity scope by design.
 *
 * Adding support for a transport REQUIRES registering a handle provider in
 * the trusted composition that derives identity from TRANSPORT-AUTHENTICATED
 * state (e.g. a Telegram Bot API sender verified by the transport library,
 * a WhatsApp socket JID, a paired device identity from Device Identity &
 * Pairing V1).  Claimed text fields are never sufficient.
 */

const CHANNEL_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Printable, non-blank; UTF-8 BYTE length bounded at mint time (≤128 bytes).
const MAX_PEER_BYTES = 128;

function peerValueIsValid(peerValue) {
  if (typeof peerValue !== "string" || peerValue.length === 0) return false;
  if (peerValue.trim().length === 0) return false;
  if (/[\u0000-\u001f\u007f]/.test(peerValue)) return false;
  // Actual UTF-8 byte measurement — never silently truncate identity;
  // fail closed one byte over the bound.
  if (Buffer.byteLength(peerValue, "utf8") > MAX_PEER_BYTES) return false;
  return true;
}

const MINTED_HANDLES = new WeakSet();

/** Verdicts for the honest per-transport support matrix. */
const TRANSPORT_CONTINUITY_SUPPORT = Object.freeze({
  telegram: Object.freeze({
    supported: false,
    scope: null,
    reason: "TELEGRAM_PEER_IDENTITY_UNAVAILABLE",
    detail: "canonical Telegram surface exposes only claimed, unauthenticated chatId; continuity fails closed"
  }),
  whatsapp: Object.freeze({
    supported: false,
    scope: null,
    reason: "WHATSAPP_PEER_IDENTITY_UNAVAILABLE",
    detail: "canonical WhatsApp surface exposes only claimed JID from telemetry; continuity fails closed"
  }),
  console: Object.freeze({
    supported: true,
    scope: "RUNTIME_OWNER",
    detail: "local console is the runtime's own operator surface; DEVICE/RUNTIME-SCOPED (not human-peer identity)"
  }),
  voice: Object.freeze({
    supported: true,
    scope: "RUNTIME_OWNER",
    detail: "voice runtime is the local owner's audio surface; DEVICE/RUNTIME-SCOPED voice continuity (not physical-speaker identity)"
  })
});

/**
 * Create a trusted transport-peer-handle scope.  The trusted composition
 * (or a canonical transport adapter) owns the returned scope; raw callers
 * can never obtain one.
 *
 * scope.mint(channel, peerValue)  → TransportPeerHandle (branded capability)
 * scope.isHandle(value)           → boolean
 * scope.support(channel)          → support verdict for honest fail-closed
 */
function createTransportPeerScope({ channel, supported, scope: scopeName, detail } = {}) {
  if (typeof channel !== "string" || !CHANNEL_NAME_RE.test(channel)) {
    throw new TypeError("TRANSPORT_PEER_SCOPE_CHANNEL_INVALID");
  }
  if (supported !== true) {
    throw new TypeError("TRANSPORT_PEER_SCOPE_UNSUPPORTED");
  }
  if (typeof scopeName !== "string" || scopeName.length === 0) {
    throw new TypeError("TRANSPORT_PEER_SCOPE_NAME_INVALID");
  }
  const scopeDetail = typeof detail === "string" ? detail.slice(0, 200) : "";
  return Object.freeze({
    channel,
    supported: true,
    scope: scopeName,
    detail: scopeDetail,
    /**
     * Mint a transport peer handle from RUNTIME-OWNED authenticated state.
     * The peerValue must be the exact transport-derived identity string
     * (case/punctuation meaningful), not caller payload text.  Bounded by
     * actual UTF-8 BYTES (≤128) — fail closed, never truncate.
     */
    mint(peerValue) {
      if (!peerValueIsValid(peerValue)) {
        const error = new Error("[TRANSPORT_PEER_INVALID] transport peer value must be an exact non-empty string bounded by UTF-8 bytes");
        error.name = "TransportPeerError";
        error.code = "TRANSPORT_PEER_INVALID";
        throw error;
      }
      const handle = Object.freeze({
        kind: "TransportPeerHandle",
        channel,
        peer: peerValue,
        scope: scopeName
      });
      MINTED_HANDLES.add(handle);
      return handle;
    },
    isHandle(value) {
      return value !== null && typeof value === "object" &&
        MINTED_HANDLES.has(value) && value.channel === channel;
    }
  });
}

/** Honest fail-closed verdict lookup for a channel. */
function transportContinuitySupport(channel) {
  if (typeof channel !== "string" || !CHANNEL_NAME_RE.test(channel)) {
    return Object.freeze({ supported: false, scope: null, reason: "CHANNEL_UNKNOWN", detail: "unknown channel" });
  }
  const verdict = TRANSPORT_CONTINUITY_SUPPORT[channel];
  return verdict ? verdict : Object.freeze({
    supported: false, scope: null, reason: "CHANNEL_UNKNOWN", detail: "no continuity support registered"
  });
}

/** Predicate: is `value` a minted TransportPeerHandle for ANY channel? */
function isTransportPeerHandle(value) {
  return value !== null && typeof value === "object" && MINTED_HANDLES.has(value);
}

module.exports = Object.freeze({
  createTransportPeerScope,
  transportContinuitySupport,
  isTransportPeerHandle,
  TRANSPORT_CONTINUITY_SUPPORT
});
