const { AsyncLocalStorage } = require("node:async_hooks");

const { SessionStore, sessionStore } = require("./sessionStore");

/**
 * Abstraksi kanal — antarmuka seragam untuk semua jalur pesan.
 *
 * Sebelumnya WhatsApp & Telegram adalah dua service terpisah yang
 * menyalin logika `converse()` yang sama (±90% identik) dan menyimpan
 * sesi di `Map` dalam memori. Kini keduanya didaftarkan ke SATU
 * registry dan berbagi:
 *
 *   1. Penyimpanan sesi persisten (SessionStore, SQLite) — konteks
 *      obrolan selamat dari restart dan bisa berlanjut lintas kanal.
 *   2. Konteks permintaan via AsyncLocalStorage — tool kirim-media
 *      (whatsapp_send_photo, mediaShareTools) membaca tujuan dari
 *      konteks permintaan, bukan dari variabel global yang saling
 *      menimpa saat dua obrolan berjalan bersamaan.
 *
 * Kanal baru (Discord, email, dst) cukup `register()` + patuhi kontrak
 * kecil: punya `running` dan (opsional) `currentChatId` untuk fallback.
 */
const storage = new AsyncLocalStorage();

class ChannelManager {

    constructor(store = sessionStore) {

        /** @type {SessionStore} */
        this.store = store;

        /** id kanal → service (mis. "whatsapp" → WhatsAppService). */
        this.channels = new Map();

    }

    register(id, service) {

        this.channels.set(id, service);

        return this;

    }

    unregister(id) {

        this.channels.delete(id);

    }

    list() {

        return [...this.channels.entries()].map(([id, service]) => ({
            id,
            running: Boolean(service?.running),
            configured: Boolean(service?.configured ?? service?.running)
        }));

    }

    async start() {

        await this.store.open();

        return this;

    }

    stop() {

        this.store.close();

    }

    // ---- Sesi ------------------------------------------------------

    sessionKey(channel, peer, kind = "dm") {

        return SessionStore.sessionKey(channel, peer, kind);

    }

    history(channel, peer, kind = "dm") {

        return this.store.load(this.sessionKey(channel, peer, kind));

    }

    remember(channel, peer, turn, kind = "dm") {

        return this.store.append(
            this.sessionKey(channel, peer, kind),
            turn,
            { channel, kind, peer: String(peer) }
        );

    }

    forget(channel, peer, kind = "dm") {

        return this.store.clear(this.sessionKey(channel, peer, kind));

    }

    forgetKey(key) {

        return this.store.clear(key);

    }

    sessions(channel = null) {

        return this.store.list({ channel });

    }

    // ---- Konteks permintaan (AsyncLocalStorage) --------------------

    runWithContext(ctx, fn) {

        return storage.run(ctx, fn);

    }

    currentContext() {

        return storage.getStore();

    }

    /**
     * Kanal tujuan untuk tool kirim-media.
     *
     * Prioritas: konteks permintaan aktif (paling benar), lalu warisan
     * `currentChatId` service (fallback pertahanan berlapis). Ini
     * memperbaiki bug media salah tujuan saat dua obrolan berjalan.
     */
    activeChat() {

        const ctx = this.currentContext();

        if (ctx?.channel && this.channels.has(ctx.channel)) {

            const service = this.channels.get(ctx.channel);

            if (service?.running) {
                return { kind: ctx.channel, id: ctx.chatId };
            }

        }

        for (const [id, service] of this.channels) {

            if (service?.running && service.currentChatId) {
                return { kind: id, id: service.currentChatId };
            }

        }

        return { kind: "console", id: null };

    }

}

module.exports = { ChannelManager, channelManager: new ChannelManager() };
