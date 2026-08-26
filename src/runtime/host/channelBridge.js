"use strict";

/**
 * CHANNEL BRIDGE V1 — integrasi transport nyata yang sudah ada ke
 * InteractionBus TANPA menulis ulang arsitektur Telegram/WhatsApp.
 *
 * Mekanisme paling invasif-minimal: layanan kanal lama sudah menerbitkan
 * peristiwa telemetry (EventEmitter). Bridge hanya BERLANGGANAN pada
 * peristiwa itu dan menormalkannya menjadi interaksi MESSAGE di bus.
 * Jalur lama (converse → aiRuntime) tidak disentuh sama sekali.
 *
 * HUKUM:
 *   - external event → normalize → InteractionBus. Tidak ada eksekusi.
 *   - claimedIdentity (chat id) hanyalah KLAIM provenance di envelope.
 *   - Kegagalan bridge tidak boleh mematikan layanan sumber (fail-soft).
 */

const { createTransportAdapter, slugSessionId, fallbackSessionId } = require("./transportAdapter");

const CHANNEL_SPECS = Object.freeze({
    telegram: Object.freeze({
        transportId: "bridge.telegram",
        origin: "TELEGRAM",
        telemetryType: "telegram:message",
        normalize(raw) {
            if (!raw || typeof raw !== "object") return { ok: false, code: "EVENT_INVALID" };
            const chatId = raw.chatId === undefined || raw.chatId === null
                ? null : String(raw.chatId);
            const sessionId = slugSessionId(`telegram-${chatId ?? ""}`) ??
                (chatId ? fallbackSessionId("telegram") : null);
            const text = typeof raw.text === "string" ? raw.text.trim()
                : typeof raw.preview === "string" ? raw.preview.trim() : "";
            if (!text) return { ok: false, code: "EVENT_TEXT_EMPTY" };
            return {
                ok: true,
                kind: "MESSAGE",
                text,
                sessionId,
                claimedIdentity: chatId,
                metadata: undefined
            };
        }
    }),
    whatsapp: Object.freeze({
        transportId: "bridge.whatsapp",
        origin: "WHATSAPP",
        telemetryType: "whatsapp:message",
        normalize(raw) {
            if (!raw || typeof raw !== "object") return { ok: false, code: "EVENT_INVALID" };
            const jid = raw.jid === undefined || raw.jid === null ? null : String(raw.jid);
            const sessionId = slugSessionId(`whatsapp-${jid ?? ""}`) ??
                (jid ? fallbackSessionId("whatsapp") : null);
            const text = typeof raw.text === "string" ? raw.text.trim() : "";
            if (!text) return { ok: false, code: "EVENT_TEXT_EMPTY" };
            return {
                ok: true,
                kind: "MESSAGE",
                text,
                sessionId,
                claimedIdentity: jid,
                metadata: undefined
            };
        }
    })
});

/**
 * createChannelBridge({ bus, channels = ["telegram"], emitter = null })
 * emitter: EventEmitter gaya telemetry (opsional saat konstruksi; dapat
 * dipasang belakangan lewat attachEmitter).
 */
function createChannelBridge({ bus, channels = ["telegram"], emitter = null } = {}) {
    const adapters = new Map();
    const unsubscribers = [];
    let attached = false;
    let counters = { eventsSeen: 0, forwarded: 0 };

    for (const name of channels) {
        const spec = CHANNEL_SPECS[name];
        if (!spec) throw new TypeError(`CHANNEL_BRIDGE_UNKNOWN_CHANNEL:${name}`);
        const adapter = createTransportAdapter({
            bus,
            transportId: spec.transportId,
            origin: spec.origin,
            capabilities: { acceptsText: true },
            normalize: spec.normalize
        });
        adapters.set(name, adapter);
    }

    function makeListener(name, adapter) {
        return (payload) => {
            counters.eventsSeen += 1;
            let result;
            try {
                result = adapter.ingestExternalEvent(payload);
            } catch {
                return; // fail-soft: bridge tidak boleh menjatuhkan sumber
            }
            if (result && result.accepted) counters.forwarded += 1;
        };
    }

    /** Pasang listener telemetry. Idempoten per channel. */
    function attachEmitter(telemetryEmitter) {
        if (!telemetryEmitter || typeof telemetryEmitter.on !== "function") {
            throw new TypeError("CHANNEL_BRIDGE_EMITTER_INVALID");
        }
        detach();
        for (const [name, adapter] of adapters) {
            const spec = CHANNEL_SPECS[name];
            const listener = makeListener(name, adapter);
            telemetryEmitter.on(spec.telemetryType, listener);
            unsubscribers.push(() => telemetryEmitter.off(spec.telemetryType, listener));
        }
        attached = true;
        return { ok: true, channels: [...adapters.keys()] };
    }

    function detach() {
        while (unsubscribers.length) {
            try { unsubscribers.pop()(); } catch { /* idempoten */ }
        }
        attached = false;
        return { ok: true, wasAttached: !attached };
    }

    if (emitter) attachEmitter(emitter);

    return Object.freeze({
        get attached() { return attached; },
        attachEmitter,
        detach,
        ingest(channel, rawEvent) {
            const adapter = adapters.get(channel);
            if (!adapter) return { accepted: false, code: "CHANNEL_NOT_BRIDGED" };
            return adapter.ingestExternalEvent(rawEvent);
        },
        snapshot() {
            return Object.freeze({
                attached,
                counters: Object.freeze({ ...counters }),
                channels: Object.freeze(
                    [...adapters.values()].map((a) => a.snapshot())
                )
            });
        }
    });
}

module.exports = Object.freeze({
    createChannelBridge,
    CHANNEL_SPECS
});
