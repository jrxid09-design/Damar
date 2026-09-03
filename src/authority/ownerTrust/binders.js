"use strict";

/**
 * CHANNEL AUTHENTICATION BINDERS (Wave 5 Lane 4, Stages 8-10).
 *
 * One narrow canonical binder per transport: Console, Telegram, WhatsApp.
 * Each binder is the seam between the transport adapter (which owns the
 * peer evidence) and the Owner trust domain.  The binder NEVER trusts a
 * caller-supplied ID: the transport adapter must present its OWN verified
 * peer evidence, and a binding ceremony requires an ALREADY authenticated
 * Owner/Admin proof.
 *
 * LAWS (binding):
 *   LOCAL != OWNER.            (Console)
 *   TRANSPORT ID != DAMAR PRINCIPAL.          (Telegram / WhatsApp)
 *   PERSISTED TRUST != LIVE AUTHENTICATION.   (generation-checked, revocable)
 *   SESSION CONTINUITY != AUTHENTICATION.     (binder mints auth results only)
 *
 * Console (Stage 8):
 *   - Local process/runtime/device evidence is transport/context ONLY.
 *   - Actual Owner/Admin proof is REQUIRED for authentication.
 *   - Results are temporary/expiring (session-bound), generation-checked,
 *     revocation-checked.  NO permanent "Console is Owner" shortcut and NO
 *     environment variable that directly says owner=true is honored.
 *
 * Telegram (Stage 9) / WhatsApp (Stage 10):
 *   - Only transport-owned sender/chat evidence that the bridge can reliably
 *     obtain (telegram sender id / whatsapp JID as delivered by the transport
 *     adapter) may be bound and authenticated.
 *   - Raw user-supplied IDs in message payloads are NOT proof and never reach
 *     the binder as evidence — the transport adapter attests the peer.
 *   - The binding ceremony requires an authenticated Owner/Admin proof.
 *   - After binding, the peer authenticates the principal ONLY when the
 *     canonical peer identity matches, the binding is active, the principal
 *     is active, and the credential/binding generation is valid.
 *   - TOTP is NOT used here at all (no TOTP factor exists in this build; the
 *     Owner root is proof-of-possession, never a Telegram ID / phone number).
 *
 * AUTHORITY remains the sole permission decision maker: an authenticated
 * principal confers NO grant by itself.
 */

const { createPrincipalBindings } = require("./bindings");

const CHANNEL_PEER_MAX = 128;

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

function assertPeerEvidence(peer, label) {
    if (typeof peer !== "string" || peer.length === 0 || peer.length > CHANNEL_PEER_MAX) {
        throw fail("OT_PEER_INVALID", `${label} peer evidence malformed`);
    }
    if (!/^[\x21-\x7E]+$/.test(peer)) {
        throw fail("OT_PEER_INVALID", `${label} peer evidence contains forbidden characters`);
    }
    return peer;
}

/**
 * createChannelBinders({ registry, proofVerifier, policy })
 *
 *   registry       — OwnerTrustRegistry.
 *   proofVerifier  — sealed proof verifier.
 *   policy         — optional { allowedChannelPairs?: Set<string> } used by the
 *                    continuity linker; binders only enforce their own
 *                    transport rules.
 */
function createChannelBinders({ registry, proofVerifier, policy = null } = {}) {
    const bindings = createPrincipalBindings({ registry, proofVerifier });

    /**
     * Shared binding ceremony: an ALREADY authenticated Owner/Admin proof +
     * transport-owned peer evidence.  The proof principal must be ACTIVE.
     */
    async function ceremonyBind({ proof, purpose, transport, peer, deviceId = null }) {
        return bindings.bindTransportPeer({ proof, purpose, transport, peer, deviceId });
    }

    // ---------------------------------------------------------------------
    // STAGE 8 — CONSOLE BINDER
    // ---------------------------------------------------------------------
    const consoleBinder = Object.freeze({
        transport: "console",

        /**
         * Bind a console context (local process/device evidence) to a
         * principal.  LOCAL != OWNER: the local evidence is transport/context
         * ONLY — the ceremony still requires an authenticated Owner/Admin
         * proof.  `localContext` is descriptive metadata recorded verbatim;
         * it NEVER substitutes for proof.
         */
        async bind({ proof, purpose, localContext, deviceId = null }) {
            const peer = localContext === undefined || localContext === null
                ? "console:local"
                : `console:${assertPeerEvidence(String(localContext), "console")}`;
            return ceremonyBind({ proof, purpose, transport: "console", peer, deviceId });
        },

        /**
         * Authenticate the local console context.  Requires an ACTIVE binding
         * (which itself was created only through a proven ceremony).
         * The result is a TEMPORARY authentication fact: generation-checked
         * and revocation-checked on EVERY call — never a standing
         * "console is Owner" state.  No environment variable is consulted.
         * Malformed evidence fails closed with a verdict (never throws).
         */
        authenticate({ localContext } = {}) {
            try {
                const peer = localContext === undefined || localContext === null
                    ? "console:local"
                    : `console:${assertPeerEvidence(String(localContext), "console")}`;
                return bindings.authenticateTransportPeer({ transport: "console", peer });
            } catch (error) {
                return Object.freeze({ ok: false, code: error.code ?? "OT_PEER_INVALID" });
            }
        }
    });

    // ---------------------------------------------------------------------
    // STAGE 9 — TELEGRAM BINDER
    // ---------------------------------------------------------------------
    const telegramBinder = Object.freeze({
        transport: "telegram",

        /**
         * Bind a Telegram peer.  `peer` MUST be the transport-owned sender
         * evidence (as delivered by the Telegram transport adapter), not a
         * raw ID the user typed into a message.  The ceremony requires an
         * already authenticated Owner/Admin proof.
         */
        async bind({ proof, purpose, senderPeer, deviceId = null }) {
            return ceremonyBind({
                proof, purpose, transport: "telegram",
                peer: assertPeerEvidence(senderPeer, "telegram"), deviceId
            });
        },

        /**
         * Authenticate a Telegram peer from transport-owned evidence.
         * Spoofed/raw IDs simply have no active binding -> fail closed.
         * Malformed evidence fails closed with a verdict (never throws).
         */
        authenticate({ senderPeer }) {
            try {
                return bindings.authenticateTransportPeer({
                    transport: "telegram",
                    peer: assertPeerEvidence(senderPeer, "telegram")
                });
            } catch (error) {
                return Object.freeze({ ok: false, code: error.code ?? "OT_PEER_INVALID" });
            }
        }
    });

    // ---------------------------------------------------------------------
    // STAGE 10 — WHATSAPP BINDER
    // ---------------------------------------------------------------------
    const whatsappBinder = Object.freeze({
        transport: "whatsapp",

        /**
         * Bind a WhatsApp peer (transport-owned JID evidence).  The ceremony
         * requires an already authenticated Owner/Admin proof.  Phone/JID
         * alone is never Owner.
         */
        async bind({ proof, purpose, jid, deviceId = null }) {
            return ceremonyBind({
                proof, purpose, transport: "whatsapp",
                peer: assertPeerEvidence(jid, "whatsapp"), deviceId
            });
        },

        /**
         * Authenticate a WhatsApp peer from transport-owned JID evidence.
         * Malformed evidence fails closed with a verdict (never throws).
         */
        authenticate({ jid }) {
            try {
                return bindings.authenticateTransportPeer({
                    transport: "whatsapp",
                    peer: assertPeerEvidence(jid, "whatsapp")
                });
            } catch (error) {
                return Object.freeze({ ok: false, code: error.code ?? "OT_PEER_INVALID" });
            }
        }
    });

    return Object.freeze({
        console: consoleBinder,
        telegram: telegramBinder,
        whatsapp: whatsappBinder,
        // Exposed for the trusted continuity linker (Stage 11) and tests:
        _bindings: bindings
    });
}

module.exports = Object.freeze({ createChannelBinders });
