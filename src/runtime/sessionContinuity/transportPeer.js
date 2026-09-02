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
 * DSC-R4-001 PROVENANCE MODEL (load-bearing):
 *
 *   createTransportPeerScope is NOT part of the ordinary public module API.
 *   The ONLY minting path is the private `mintCanonicalTransportPeerHandle`
 *   seam below, which the RuntimeHost composition drives for a channel whose
 *   honest verdict is SUPPORTED.  That seam creates ONE fresh scope per
 *   mint; the handle carries NO caller-supplied identity — the peer value is
 *   a fixed RUNTIME-OWNED constant, never a raw event field.
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

/**
 * PRIVATE TRUSTED MINT (DSC-R4-001).
 *
 * Creates a FRESH per-runtime scope for `channel` and mints the canonical
 * runtime-owner TransportPeerHandle from it.  Returns BOTH the scope (the
 * only object that will ever recognize this handle) and the handle, so the
 * RuntimeHost composition can keep them bound together in private closure
 * state.
 *
 * This function is NOT exported from the module.  It is reachable ONLY by the
 * canonical RuntimeHost transport composition.  An ordinary module can never
 * call it, can never obtain the returned scope, and therefore can never mint
 * a handle the canonical composition accepts.
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

/**
 * ISOLATED COMPONENT-TEST FACTORY (DSC-R4-001).  NOT a production mint.
 *
 * Creates a standalone per-scope TransportPeerScope for isolated unit tests
 * of the continuity DOMAIN (provenance/link/conflict semantics).  The scope
 * mints handles branded by its OWN private WeakSet — per-scope provenance,
 * identical to the canonical mint.  Because provenance is per-scope, a
 * handle minted here is NEVER recognized by the canonical RuntimeHost
 * composition's scopes (a different scope object, a different brand), so
 * exposing this factory cannot weaken the production trust boundary.
 *
 * The canonical RuntimeHost composition does NOT use this factory; it uses
 * the private `mintCanonicalTransportPeerHandle` seam.
 */
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

module.exports = Object.freeze({
  // DSC-R4-001: the trusted mint is PRIVATE — it is exposed only to the
  // canonical RuntimeHost composition through this internal binding.  It is
  // NOT a general-purpose public scope factory.
  mintCanonicalTransportPeerHandle,
  // Isolated component-test factory (per-scope provenance; never accepted by
  // the canonical composition).  See createTestTransportPeerScope above.
  createTestTransportPeerScope,
  transportContinuitySupport,
  TRANSPORT_CONTINUITY_SUPPORT
});
