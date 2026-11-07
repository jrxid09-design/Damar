"use strict";

/**
 * CANONICAL TRANSPORT INGRESS ADAPTERS (Wave 5 Lane 4 repair, OT-006).
 *
 * The seam where REAL transport traffic becomes provenance: these wrappers
 * wrap the canonical Telegram/WhatsApp service objects and the console
 * surface, mint a TransportPeerProvenance at the moment real ingress
 * arrives (from the transport library's OWN context — never from a caller
 * envelope or model output), and expose it through an AsyncLocalStorage
 * context for the trust binders/linker.
 *
 * LAWS:
 *   - The wrapper NEVER accepts a peer identity from callers: telegram peer
 *     = the update's chat id as delivered by the Telegram transport library;
 *     whatsapp peer = the message key's JID (participant for groups) as
 *     delivered by the Baileys library; console peer = the local runtime
 *     session.  Raw user-typed IDs in message TEXT are never consulted.
 *   - The mint capability comes ONLY from the canonical composition's
 *     provenance issuer; these adapters never construct provenance objects
 *     themselves.
 *   - Delegation is transparent: every other property/method of the wrapped
 *     service passes through unchanged (the channel contract is preserved).
 */

const { AsyncLocalStorage } = require("node:async_hooks");

const { createTransportProvenanceIssuer } = require("./provenance");

const ingressStorage = new AsyncLocalStorage();

/** Read the provenance minted for the CURRENT ingress context (or null). */
function currentPeerProvenance() {
    return ingressStorage.getStore() ?? null;
}

function assertIssuer(issuer) {
    if (!issuer || typeof issuer.mint !== "function") {
        throw new Error("[OT_PROVENANCE_TRANSPORT_INVALID] canonical provenance issuer required");
    }
    return issuer;
}

/**
 * Wrap a channel service so every `handle(...)` ingress mints provenance
 * first, then delegates inside that provenance context.
 *
 *   extractPeer(msg) — pure per-transport extractor returning the
 *     NORMALIZED transport-owned peer key string, or null when the event
 *     carries no peer evidence (the wrapper then delegates WITHOUT
 *     provenance — fail-open for the transport, fail-closed for trust).
 */
function wrapChannelService({ service, issuer, extractPeer }) {
    assertIssuer(issuer);
    if (!service || typeof service.handle !== "function") {
        throw new Error("[OT_INGRESS_INVALID] channel service with handle() required");
    }
    if (typeof extractPeer !== "function") {
        throw new Error("[OT_INGRESS_INVALID] extractPeer required");
    }
    const original = service.handle.bind(service);
    const wrapped = Object.create(service);
    wrapped.handle = function handle(msg) {
        let provenance = null;
        try {
            const peerKey = extractPeer(msg);
            if (typeof peerKey === "string" && peerKey.length > 0) {
                provenance = issuer.mint({
                    peerKey,
                    incarnation: typeof msg?.id === "string" ? msg.id : null
                });
            }
        } catch {
            provenance = null; // transport keeps working; trust stays closed
        }
        if (provenance === null) {
            return original(msg);
        }
        return ingressStorage.run(provenance, () => original(msg));
    };
    return wrapped;
}

/** Telegram: the chat id as delivered by the transport library update. */
function telegramPeerExtractor() {
    return (msg) => {
        const chatId = msg?.chat?.id;
        return chatId === undefined || chatId === null ? null : String(chatId);
    };
}

/** WhatsApp: sender JID as delivered by the Baileys message key. */
function whatsappPeerExtractor() {
    return (msg) => {
        const jid = msg?.key?.remoteJid;
        if (typeof jid !== "string" || jid.length === 0) return null;
        if (jid.endsWith("@g.us")) {
            const participant = msg?.key?.participant;
            return typeof participant === "string" && participant.length > 0
                ? participant
                : null; // group message without participant evidence: no peer
        }
        return jid;
    };
}

/**
 * Canonical Telegram ingress adapter: wraps the REAL TelegramService.
 */
function attachTelegramIngress({ service, issuer }) {
    return wrapChannelService({
        service, issuer: assertIssuer(issuer), extractPeer: telegramPeerExtractor()
    });
}

/**
 * Canonical WhatsApp ingress adapter: wraps the REAL WhatsAppService.
 */
function attachWhatsappIngress({ service, issuer }) {
    return wrapChannelService({
        service, issuer: assertIssuer(issuer), extractPeer: whatsappPeerExtractor()
    });
}

/**
 * Console provenance: the local console runtime session.  `incarnation`
 * distinguishes distinct console sessions (e.g. the HTTP request id).
 * Returns the minted provenance object (caller decides where it lives).
 */
function mintConsoleProvenance({ issuer, incarnation = null } = {}) {
    assertIssuer(issuer);
    return issuer.mint({ peerKey: "local", incarnation });
}

/**
 * Express middleware for the console surface: mints per-request console
 * provenance and exposes it through the ingress context for the duration
 * of the request.
 */
function consoleProvenanceMiddleware({ issuer } = {}) {
    assertIssuer(issuer);
    return function consoleProvenance(req, res, next) {
        let provenance = null;
        try {
            provenance = mintConsoleProvenance({
                issuer, incarnation: typeof req?.id === "string" ? req.id : null
            });
        } catch {
            provenance = null;
        }
        if (provenance === null) return next();
        return ingressStorage.run(provenance, () => next());
    };
}

/**
 * Factory bundling the three canonical issuers (one per transport) —
 * called ONCE by the canonical composition; the issuers are never exported
 * anywhere else.
 */
function createCanonicalIngressIssuers() {
    return Object.freeze({
        console: createTransportProvenanceIssuer({ transport: "console", instanceId: "canonical-console" }),
        telegram: createTransportProvenanceIssuer({ transport: "telegram", instanceId: "canonical-telegram" }),
        whatsapp: createTransportProvenanceIssuer({ transport: "whatsapp", instanceId: "canonical-whatsapp" })
    });
}

module.exports = Object.freeze({
    createCanonicalIngressIssuers,
    attachTelegramIngress,
    attachWhatsappIngress,
    mintConsoleProvenance,
    consoleProvenanceMiddleware,
    currentPeerProvenance
});
