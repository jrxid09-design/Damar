"use strict";

/**
 * DAMAR TRANSPORT PEER HANDLES — trusted transport-owned identity evidence
 * (Wave 5 Lane 4 continuity, repair R5 / DSC-R4-001).
 *
 * LAW: UNTRUSTED EVENT DATA CANNOT ESTABLISH CONTINUITY IDENTITY.
 *       TRANSPORT SESSION != PEER IDENTITY.
 *       UNTRUSTED CALLER CANNOT MINT TRANSPORT IDENTITY.
 *
 * A TransportPeerHandle is the ONLY value the continuity domain accepts as
 * peer-evidence input.  It is:
 *
 *   - minted ONLY inside the canonical RuntimeHost transport composition,
 *     never from a raw event and never by an ordinary module;
 *   - a capability object branded by a SCOPE-PRIVATE WeakSet — a handle
 *     minted by Scope A is NOT recognized by Scope B, even when both claim
 *     the SAME channel name (DSC-R4-001: per-scope provenance, not a global
 *     brand);
 *   - carried OUT-OF-BAND: the handle travels through trusted runtime state
 *     (the canonical transport adapter's own binding), never through the raw
 *     event payload;
 *   - transport-scoped: the same peer value under two different channels is
 *     two different identities unless explicitly linked;
 *   - non-authoritative: it confers zero privilege.
 *
 * DSC-R4-001 + DSC-R5-003 PROVENANCE MODEL (load-bearing):
 *
 *   There is NO public scope factory and NO public trust mint.  The ONLY
 *   minting path is the canonical `mintCanonicalTransportPeerHandle` in the
 *   SEPARATE internal module `transportPeerInternal.js` (not re-exported by
 *   the package index), which the RuntimeHost composition drives for a
 *   channel whose honest verdict is SUPPORTED.  That mint creates ONE fresh
 *   scope per call; the handle carries NO caller-supplied identity — the
 *   peer value is a fixed RUNTIME-OWNED constant, never a raw event field.
 *
 *   Because provenance is per-scope (a scope accepts ONLY handles it minted
 *   itself), and because ordinary callers can neither obtain the canonical
 *   scope nor call the private mint, an attacker can NEVER produce a handle
 *   the canonical RuntimeHost composition will accept.  A handle minted by a
 *   foreign/test scope — even one claiming the identical channel string — is
 *   rejected by the canonical composition.
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
 *   console  : UNSUPPORTED in the current runtime (DSC-R4-005 honest
 *              downgrade).  No canonical production startup path binds a
 *              runtime-owned console identity automatically; the previous
 *              "supported" verdict was only ever satisfied by tests manually
 *              binding a handle.  Until a canonical Console runtime binds its
 *              own runtime-owner identity through the private adapter seam,
 *              console continuity FAILS CLOSED.
 *
 *   voice    : SUPPORTED as RUNTIME/DEVICE scope — the voice runtime is the
 *              local owner's audio surface (one runtime = one owner scope).
 *              The canonical VoiceRuntime binds its runtime-owner peer
 *              through the private RuntimeHost transport binder at start().
 *              Identity semantics: DEVICE/RUNTIME-SCOPED voice continuity,
 *              NOT physical-speaker identity.  All physical speakers sharing
 *              the runtime share one continuity scope by design.
 *
 * Adding support for a transport REQUIRES a canonical production adapter that
 * binds identity from TRANSPORT-AUTHENTICATED / RUNTIME-OWNED state through
 * the private RuntimeHost transport binder (e.g. a Telegram Bot API sender
 * verified by the transport library, a WhatsApp socket JID, a paired device
 * identity from Device Identity & Pairing V1).  Claimed text fields are never
 * sufficient, and tests manually minting a handle do NOT constitute support.
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
    supported: false,
    scope: null,
    reason: "CONSOLE_RUNTIME_BINDER_UNAVAILABLE",
    detail: "no canonical production startup path binds a runtime-owned console identity automatically; continuity fails closed until one exists"
  }),
  voice: Object.freeze({
    supported: true,
    scope: "RUNTIME_OWNER",
    detail: "voice runtime binds its runtime-owner peer through the private RuntimeHost transport binder at start; DEVICE/RUNTIME-SCOPED voice continuity (not physical-speaker identity)"
  })
});

/**
 * The ONE runtime-owned peer value for a SUPPORTED channel.  This is a fixed
 * RUNTIME-OWNED constant — the local Damar runtime owner for this transport —
 * deliberately NOT derived from any raw event field, caller payload, or
 * transport-session id.  DEVICE/RUNTIME-SCOPED by design.
 */
function canonicalRuntimePeerValue(channel) {
  return `${channel}-runtime-owner`;
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

// ---------------------------------------------------------------------------
// DSC-R5-003 — EXPORT HYGIENE.
//
// The ORDINARY production export surface exposes ONLY the honest support
// verdict vocabulary and the shared peer-value validator (used by the
// canonical internal mint).  It deliberately exposes NO trust-mint and NO
// scope-construction factory:
//
//   - the canonical trust mint lives in the SEPARATE internal module
//     `transportPeerInternal.js`, which the package index does NOT re-export
//     and which only the canonical RuntimeHost transport composition
//     (manager/bootstrap.js) imports;
//   - test-scope construction lives OUTSIDE the production tree
//     (tests/helpers/testTransportPeer.js).
//
// Ordinary production callers depend only on the read-only verdicts below.
// ---------------------------------------------------------------------------
module.exports = Object.freeze({
  transportContinuitySupport,
  TRANSPORT_CONTINUITY_SUPPORT,
  // Shared internal helpers consumed by transportPeerInternal.js (the
  // canonical mint).  These are inert validators/constants — they confer no
  // minting capability by themselves.
  _internal: Object.freeze({
    CHANNEL_NAME_RE,
    peerValueIsValid,
    canonicalRuntimePeerValue
  })
});
