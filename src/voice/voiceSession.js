/**
 * VoiceSession — satu putaran interaksi suara.
 *
 * Ini JEMBATAN ke AI Runtime yang SAMA dengan Telegram/WhatsApp/Console:
 * ia memanggil aiRuntime.chat({ messages, tools: undefined, channel: "voice" })
 * sehingga ToolSelector, context budgeting, memory, mind/consciousness,
 * MCP tools, dan audit trail SEMUA berjalan otomatis — tanpa AI loop kedua.
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

    constructor({ aiRuntime = null } = {}) {
        this.aiRuntime = aiRuntime ?? null;
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
     * tools: undefined → AIRuntime.resolveTools() menjalankan ToolSelector
     * (jalur superadmin, sama dengan Telegram/Console).
     *
     * @param {string} text transkrip perintah pengguna
     * @returns {Promise<{ answer: string }>}
     */
    async think(text) {

        const aiRuntime = this.aiRuntime ?? require("../services/aiRuntimeService");

        const history = await this.history();

        history.push({ role: "user", content: text });
        await this.remember("user", text);

        // Konteks permintaan: tool kirim-media & sejenisnya tahu ini dari voice.
        const answer = await channelManager.runWithContext(
            { channel: "voice", chatId: PEER },
            async () => {
                const res = await aiRuntime.chat({
                    messages: history.map(({ role, content }) => ({ role, content })),
                    tools: undefined,
                    channel: "voice"
                });
                return res.content?.trim() || "(tidak ada jawaban)";
            }
        );

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
