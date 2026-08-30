"use strict";

/**
 * TRANSPORT ADAPTER — jembatan satu arah: peristiwa eksternal → normalisasi
 * → InteractionBus.
 *
 * HUKUM (load-bearing):
 *   - external event → normalize → InteractionBus.submit(). TIDAK PERNAH
 *     external event → eksekusi runtime berhak langsung.
 *   - Provenance dipertahankan: claimedIdentity dari event eksternal hanya
 *     KLAIM; envelope bus mencatatnya sebagai provenance, bukan fakta.
 *   - Adapter tidak meminting Authority, tidak menyentuh Presence secara
 *     langsung, dan tidak punya jalur aktuator.
 */

const MAX_COUNTERS = 64;
const { isPlainObject, readOwnData } = require("../interactionBus/payloads");

const SESSION_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function optionalOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key)
        ? readOwnData(value, key)
        : undefined;
}

/** Turunkan sessionId kanonik (`ses_...`) dari string eksternal apa pun.
 * Deterministik agar sesi per user/channel stabil antar peristiwa. */
function slugSessionId(raw) {
    if (typeof raw !== "string") return null;
    const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const cleaned = base.replace(/^-+|-+$/g, "").slice(0, 62);
    if (SESSION_SLUG_RE.test(cleaned)) return `ses_${cleaned}`;
    return null;
}

let fallbackCounter = 0;

function fallbackSessionId(prefix = "anon") {
    fallbackCounter += 1;
    const slug = `${prefix}-${fallbackCounter}`.slice(0, 62);
    return `ses_${slug}`;
}

function defaultNormalize(rawEvent) {
    if (!isPlainObject(rawEvent)) {
        return { ok: false, code: "EVENT_INVALID" };
    }
    const textValue = optionalOwn(rawEvent, "text");
    const text = typeof textValue === "string" ? textValue.trim() : "";
    if (!text) return { ok: false, code: "EVENT_TEXT_EMPTY" };
    const userIdValue = optionalOwn(rawEvent, "userId");
    const sessionValue = optionalOwn(rawEvent, "sessionId");
    const identity = typeof userIdValue === "string" ? userIdValue.slice(0, 128) : null;
    let sessionId = sessionValue === undefined || sessionValue === null
        ? null
        : (typeof sessionValue === "string" && sessionValue.startsWith("ses_")
            ? sessionValue
            : slugSessionId(sessionValue));
    if (!sessionId) sessionId = slugSessionId(identity) ?? fallbackSessionId("ext");
    return {
        ok: true,
        kind: "MESSAGE",
        text,
        sessionId,
        claimedIdentity: identity,
        metadata: undefined
    };
}

/**
 * createTransportAdapter({ bus, transportId, origin, capabilities, normalize })
 *
 * normalize(rawEvent) -> { ok:true, kind, payload|text, sessionId?,
 *                           claimedIdentity?, metadata? } | { ok:false, code }
 */
function createTransportAdapter({
    bus,
    transportId,
    origin,
    capabilities = { acceptsText: true },
    normalize = defaultNormalize
} = {}) {
    if (!bus || typeof bus.registerTransport !== "function" || typeof bus.submit !== "function") {
        throw new TypeError("TRANSPORT_ADAPTER_BUS_INVALID");
    }
    if (typeof normalize !== "function") {
        throw new TypeError("TRANSPORT_ADAPTER_NORMALIZE_INVALID");
    }

    const descriptor = bus.registerTransport({ transportId, origin, capabilities });

    let counters = { ingested: 0, accepted: 0, rejected: 0 };
    const rejectionReasons = new Map();
    let disconnected = false;

    function bumpRejected(code) {
        counters.rejected += 1;
        const next = (rejectionReasons.get(code) ?? 0) + 1;
        if (rejectionReasons.size < MAX_COUNTERS || rejectionReasons.has(code)) {
            rejectionReasons.set(code, next);
        }
    }

    /** Satu-satunya pintu masuk peristiwa eksternal. Tidak mengeksekusi
     * apa pun sendiri; hasil submit bus dikembalikan apa adanya. */
    function ingestExternalEvent(rawEvent) {
        if (disconnected) {
            bumpRejected("ADAPTER_DISCONNECTED");
            return { accepted: false, code: "ADAPTER_DISCONNECTED" };
        }

        counters.ingested += 1;

        let normalized;
        try {
            normalized = normalize(rawEvent);
        } catch {
            bumpRejected("NORMALIZE_FAULT");
            return { accepted: false, code: "NORMALIZE_FAULT" };
        }
        if (!normalized || normalized.ok !== true) {
            const code = normalized?.code ?? "EVENT_INVALID";
            bumpRejected(code);
            return { accepted: false, code };
        }

        const payload = normalized.text !== undefined
            ? { text: normalized.text }
            : normalized.payload;
        if (payload === undefined || payload === null) {
            bumpRejected("EVENT_PAYLOAD_EMPTY");
            return { accepted: false, code: "EVENT_PAYLOAD_EMPTY" };
        }

        // claimedIdentity harus berupa record terbatas di envelope bus:
        // identitas eksternal berbentuk string dibungkus sebagai klaim `id`.
        let claimed = normalized.claimedIdentity;
        if (typeof claimed === "string") claimed = { id: claimed.slice(0, 128) };
        else if (claimed !== null && claimed !== undefined && typeof claimed !== "object") {
            bumpRejected("CLAIMED_IDENTITY_INVALID");
            return { accepted: false, code: "CLAIMED_IDENTITY_INVALID" };
        }

        let result;
        try {
            result = bus.submit({
                transportId,
                kind: normalized.kind ?? "MESSAGE",
                sessionId: normalized.sessionId ?? undefined,
                payload,
                metadata: normalized.metadata,
                claimedIdentity: claimed ?? undefined
            });
        } catch {
            bumpRejected("SUBMIT_FAULT");
            return { accepted: false, code: "SUBMIT_FAULT" };
        }

        if (result && result.accepted === true) {
            counters.accepted += 1;
            return { accepted: true, interactionId: result.interactionId, state: result.state };
        }
        const code = result?.reason ?? result?.code ?? "SUBMIT_REJECTED";
        bumpRejected(code);
        return { accepted: false, code, interactionId: result?.interactionId ?? null };
    }

    /** Transport terputus: bus diberi tahu agar sesi dibersihkan sisi bus. */
    function disconnect() {
        if (disconnected) return { disconnected: true };
        disconnected = true;
        try { bus.transportDisconnect(transportId); } catch { /* idempoten */ }
        return { disconnected: true };
    }

    function snapshot() {
        return Object.freeze({
            transportId,
            origin,
            capabilities: descriptor.capabilities,
            disconnected,
            counters: Object.freeze({ ...counters }),
            rejectionReasons: Object.freeze(Object.fromEntries(rejectionReasons))
        });
    }

    return Object.freeze({
        transportId,
        origin,
        ingestExternalEvent,
        disconnect,
        snapshot
    });
}

module.exports = Object.freeze({
    createTransportAdapter,
    defaultNormalize,
    slugSessionId,
    fallbackSessionId
});
