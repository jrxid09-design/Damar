/**
 * Titik masuk subsistem kanal.
 *
 * `src/channels/` adalah lapisan abstraksi jalur pesan
 * yang menyatukan WhatsApp & Telegram ke satu registry berbagi sesi
 * persisten + konteks permintaan. Lihat channelManager.js.
 */
const { channelManager } = require("./channelManager");
const { SessionStore, sessionStore } = require("./sessionStore");

module.exports = {
    manager: channelManager,
    sessionStore,
    SessionStore
};
