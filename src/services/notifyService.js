const telemetry = require("./telemetryService");

/**
 * notifyService — kanal notifikasi terpadu Damar.
 *
 * Sekarang lewat WhatsApp (broadcast ke nomor pemilik yang sudah
 * diizinkan). Kanal lain (email/SMTP) bisa ditambah di sini tanpa
 * mengubah pemanggil. Selalu best-effort: gagal kirim tak pernah
 * melempar (agar tak menggagalkan backup/monitor).
 */
async function send(text) {
    try {
        const wa = require("./whatsappService");
        const sent = await wa.broadcast(String(text ?? ""));
        if (sent > 0) telemetry.info(`[notify] WhatsApp terkirim ke ${sent} nomor`);
        else telemetry.info("[notify] tak ada penerima WhatsApp aktif (lewati).");
        return { channel: "whatsapp", sent };
    }
    catch (error) {
        telemetry.warn(`[notify] gagal: ${error.message}`);
        return { channel: "whatsapp", sent: 0, error: error.message };
    }
}

module.exports = { send };
