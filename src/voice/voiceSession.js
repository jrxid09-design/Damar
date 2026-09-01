/**
 * VoiceSession — satu putaran interaksi suara.
 *
 * Ini JEMBATAN ke AI Runtime yang SAMA dengan Telegram/WhatsApp/Console:
 * ia menyerahkan interaksi ke InteractionBus/Manager kanonik.
 *
 * Sesi suara punya konteks persisten lewat ChannelManager (SessionStore
 * SQLite): channel "voice", peer "owner". Riwayat obrolan suara selamat
 * dari restart dan bisa berlanjut.
 *
 * Yang TIDAK dilakukan: membangun ulang AI, tool, atau action system.
 */

const { manager: channelManager } = require("../channels");

const PEER = "owner";

class VoiceSession {

    constructor({ interactionIngress = null } = {}) {
        this.interactionIngress = interactionIngress;
    }

    bindInteractionIngress(interactionIngress) {
        if (!interactionIngress || typeof interactionIngress.request !== "function") {
            throw new TypeError("VOICE_INTERACTION_INGRESS_INVALID");
        }
        this.interactionIngress = interactionIngress;
        return this;
    }

    /** Muat riwayat suara (persisten). */
    history() {
        return channelManager.history("voice", PEER, "dm");
    }

    /** Catat satu giliran (user/assistant). */
    remember(role, content) {
        return channelManager.remember("voice", PEER, { role, content }, "dm");
    }

    /** Kosongkan konteks suara. */
    forget() {
        return channelManager.forget("voice", PEER, "dm");
    }

    /**
     * Kirim transkrip ke AI Runtime dan kembalikan balasan teks.
     *
     * cognition() fixes an external channel and an empty tool set. An action
     * proposal must enter the Damar Manager and Lane 2–4 path separately.
     *
     * @param {string} text transkrip perintah pengguna
     * @returns {Promise<{ answer: string }>}
     */
    async think(text, { signal } = {}) {
        if (!this.interactionIngress) throw new Error("VOICE_INTERACTION_INGRESS_UNBOUND");

        const history = await this.history();

        history.push({ role: "user", content: text });
        await this.remember("user", text);

        // Konteks permintaan: tool kirim-media & sejenisnya tahu ini dari voice.
        const rendered = await channelManager.runWithContext(
            { channel: "voice", chatId: PEER },
            () => this.interactionIngress.request("voice", {
                text,
                userId: PEER,
                sessionId: `ses_voice-${PEER}`,
                metadata: { historyTurns: history.length }
            }, { signal })
        );
        const answer = typeof rendered?.detail === "string" && rendered.detail.trim()
            ? rendered.detail.trim()
            : (rendered?.outcomeLabel || "(tidak ada jawaban)");

        await this.remember("assistant", answer);

        return { answer };

    }

    /**
     * Daftarkan kanal voice ke ChannelManager (agar muncul di /channels).
     */
    register() {
        channelManager.register("voice", {
            running: true,
            currentChatId: PEER,
            configured: true
        });
        return this;
    }

}

module.exports = { VoiceSession, PEER };
