"use strict";

/**
 * CHANNEL AUTHENTICATION BINDERS (Wave 5 Lane 4, Stages 8-10; OT-006).
 *
 * One narrow canonical binder per transport: Console, Telegram, WhatsApp.
 * Each binder is the seam between the transport adapter (which owns the
 * peer evidence) and the Owner trust domain.
 *
 * RAW STRING != TRUSTED PEER HANDLE:
 *   Every bind()/authenticate() call accepts ONLY a branded
 *   TransportPeerProvenance object minted INTERNALLY by the canonical
 *   transport adapter at the moment real traffic arrived.  Raw chatId/JID
 *   strings from callers, model-produced objects, plain look-alike objects,
 *   and clones/JSON round-trips are structurally rejected — the brand lives
 *   in a module-closure WeakSet plus a non-exported symbol, so shape alone
 *   cannot counterfeit it.
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
 *   - Only transport-owned sender/chat evidence minted by the canonical
 *     adapter (telegram chat id / whatsapp JID as delivered by the transport
 *     library) may be bound and authenticated.
 *   - Raw user-supplied IDs in message payloads are NOT proof and never
 *     reach the binder as evidence — the adapter attests the peer.
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
const { verifyTransportPeerProvenance } = require("./provenance");

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/** Require a genuine provenance view; throws OT_PROVENANCE_INVALID. */
function requireProvenance(provenance, label) {
    const view = verifyTransportPeerProvenance(provenance);
    if (!view) {
        throw fail("OT_PROVENANCE_INVALID",
            `${label} requires canonical peer provenance (raw strings are not evidence)`);
    }
    return view;
}

/**
 * createChannelBinders({ registry, proofVerifier })
 *
 *   registry       — OwnerTrustRegistry.
 *   proofVerifier  — sealed proof verifier.
 */
function createChannelBinders({ registry, proofVerifier } = {}) {
    const bindings = createPrincipalBindings({ registry, proofVerifier });

    /**
     * Shared binding ceremony: an ALREADY authenticated Owner/Admin proof +
     * canonical provenance.  The proof principal must be ACTIVE.
     */
    async function ceremonyBind({ proof, purpose, provenance, deviceId = null }) {
        const view = requireProvenance(provenance, "binding ceremony");
        return bindings.bindTransportPeer({
            proof, purpose, provenance, deviceId
        });
    }

    // ---------------------------------------------------------------------
    // STAGE 8 — CONSOLE BINDER
    // ---------------------------------------------------------------------
    const consoleBinder = Object.freeze({
        transport: "console",

        /**
         * Bind a console session to a principal.  LOCAL != OWNER: the local
         * provenance is transport/context ONLY — the ceremony still requires
         * an authenticated Owner/Admin proof.
         */
        async bind({ proof, purpose, provenance, deviceId = null }) {
            const view = requireProvenance(provenance, "console binding");
            if (view.transport !== "console") {
                throw fail("OT_PROVENANCE_TRANSPORT_MISMATCH", "provenance is not console evidence");
            }
            return ceremonyBind({ proof, purpose, provenance, deviceId });
        },

        /**
         * Authenticate the local console session from canonical provenance.
         * Requires an ACTIVE binding (which itself was created only through a
         * proven ceremony).  The result is a TEMPORARY authentication fact:
         * generation-checked and revocation-checked on EVERY call — never a
         * standing "console is Owner" state.  No environment variable is
         * consulted.  Malformed evidence fails closed with a verdict (never
         * throws).
         */
        authenticate({ provenance } = {}) {
            const view = verifyTransportPeerProvenance(provenance);
            if (!view || view.transport !== "console") {
                return Object.freeze({ ok: false, code: "OT_PROVENANCE_INVALID" });
            }
            return bindings.authenticateTransportPeer({ provenance });
        }
    });

    // ---------------------------------------------------------------------
    // STAGE 9 — TELEGRAM BINDER
    // ---------------------------------------------------------------------
    const telegramBinder = Object.freeze({
        transport: "telegram",

        /**
         * Bind a Telegram peer.  `provenance` MUST be minted by the canonical
         * Telegram ingress adapter from the transport library's own update
         * context, not from a raw ID the user typed into a message.  The
         * ceremony requires an already authenticated Owner/Admin proof.
         */
        async bind({ proof, purpose, provenance, deviceId = null }) {
            const view = requireProvenance(provenance, "telegram binding");
            if (view.transport !== "telegram") {
                throw fail("OT_PROVENANCE_TRANSPORT_MISMATCH", "provenance is not telegram evidence");
            }
            return ceremonyBind({ proof, purpose, provenance, deviceId });
        },

        /**
         * Authenticate a Telegram peer from canonical provenance.
         * Spoofed/raw IDs simply have no active binding -> fail closed.
         * Malformed evidence fails closed with a verdict (never throws).
         */
        authenticate({ provenance }) {
            const view = verifyTransportPeerProvenance(provenance);
            if (!view || view.transport !== "telegram") {
                return Object.freeze({ ok: false, code: "OT_PROVENANCE_INVALID" });
            }
            return bindings.authenticateTransportPeer({ provenance });
        }
    });

    // ---------------------------------------------------------------------
    // STAGE 10 — WHATSAPP BINDER
    // ---------------------------------------------------------------------
    const whatsappBinder = Object.freeze({
        transport: "whatsapp",

        /**
         * Bind a WhatsApp peer (canonical provenance over the transport-owned
         * JID evidence).  The ceremony requires an already authenticated
         * Owner/Admin proof.  Phone/JID alone is never Owner.
         */
        async bind({ proof, purpose, provenance, deviceId = null }) {
            const view = requireProvenance(provenance, "whatsapp binding");
            if (view.transport !== "whatsapp") {
                throw fail("OT_PROVENANCE_TRANSPORT_MISMATCH", "provenance is not whatsapp evidence");
            }
            return ceremonyBind({ proof, purpose, provenance, deviceId });
        },

        /**
         * Authenticate a WhatsApp peer from canonical provenance.
         * Malformed evidence fails closed with a verdict (never throws).
         */
        authenticate({ provenance }) {
            const view = verifyTransportPeerProvenance(provenance);
            if (!view || view.transport !== "whatsapp") {
                return Object.freeze({ ok: false, code: "OT_PROVENANCE_INVALID" });
            }
            return bindings.authenticateTransportPeer({ provenance });
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
