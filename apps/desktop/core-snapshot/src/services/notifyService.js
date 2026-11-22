const telemetry = require("./telemetryService");

/**
 * notifyService — kanal notifikasi terpadu Damar.
 *
 * Menyusun permintaan notifikasi dan menyerahkannya ke jalur kanonik.
 * Service ini bukan sumber authority dan tidak menyentuh transport WhatsApp.
 * Tanpa konteks Manager/authenticated standing grant, permintaan ditolak
 * tanpa side effect.
 */
async function send(text, { context = null, execution = null } = {}) {
    try {
        const { submitGovernedService } = require("./governedServiceBoundary");
        const result = await submitGovernedService({ context, execution, capabilityId: "messaging.whatsapp", operation: "broadcast", arguments: { text: String(text ?? "") }, expectedPostcondition: { kind: "notification-delivery" } });
        const sent = result?.outcome === "COMPLETED" ? (result.recipients ?? 0) : 0;
        if (sent > 0) telemetry.info(`[notify] WhatsApp terkirim ke ${sent} nomor`);
        else telemetry.info(`[notify] tidak terkirim (${result?.outcome ?? "UNKNOWN"}); fail-closed.`);
        return { channel: "whatsapp", sent, outcome: result?.outcome ?? "UNKNOWN", result };
    }
    catch (error) {
        telemetry.warn(`[notify] gagal: ${error.message}`);
        return { channel: "whatsapp", sent: 0, outcome: "FAILED", error: error.message };
    }
}

module.exports = { send };
