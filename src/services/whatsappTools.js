const { AITool } = require("../ai/tools");

const whatsapp = require("./whatsappService");
const { submitGovernedService } = require("./governedServiceBoundary");

/**
 * Tool agar Damar bisa mengirim media saat mengobrol via WhatsApp —
 * gambar, berkas, atau stiker — ke chat yang sedang dilayani.
 */
function whatsappTools() {

    const ensureChat = () => {

        // Konteks permintaan menang (AsyncLocalStorage) — tujuan yang
        // benar saat dua obrolan berjalan bersamaan.
        const ctx = require("../channels").manager.currentContext();

        if (ctx?.channel === "whatsapp" && whatsapp.running) {
            return ctx.chatId;
        }

        if (!whatsapp.running || !whatsapp.currentChatId) {
            throw new Error("Tool ini hanya bisa dipakai saat sedang mengobrol via WhatsApp.");
        }
        return whatsapp.currentChatId;
    };

    return [

        new AITool({
            name: "whatsapp_send_photo",
            description:
                "Kirim gambar ke percakapan WhatsApp yang sedang berlangsung (via URL). " +
                "Pakai saat pengguna minta dikirimi gambar/foto (mis. snapshot CCTV).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL gambar (http/https)." },
                    caption: { type: "string", description: "Keterangan (opsional)." }
                },
                required: ["url"]
            },
            execute: async ({ url, caption }, ctx) => {
                const result = await submitGovernedService({ execution: ctx?.exec ?? null, capabilityId: "messaging.whatsapp", operation: "sendPhoto", arguments: { number: ensureChat(), url, caption }, expectedPostcondition: { kind: "notification-delivery" } });
                if (result?.outcome !== "COMPLETED") throw new Error(result?.detail ?? result?.reason ?? "canonical authority required");
                return { sent: true, result, governed: true };
            }
        }),

        new AITool({
            name: "whatsapp_send_document",
            description: "Kirim berkas/dokumen ke percakapan WhatsApp yang sedang berlangsung (via URL).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL berkas." },
                    caption: { type: "string", description: "Keterangan (opsional)." },
                    fileName: { type: "string", description: "Nama berkas (opsional)." }
                },
                required: ["url"]
            },
            execute: async ({ url, caption, fileName }, ctx) => {
                const result = await submitGovernedService({ execution: ctx?.exec ?? null, capabilityId: "messaging.whatsapp", operation: "sendDocument", arguments: { number: ensureChat(), url, caption, fileName }, expectedPostcondition: { kind: "notification-delivery" } });
                if (result?.outcome !== "COMPLETED") throw new Error(result?.detail ?? result?.reason ?? "canonical authority required");
                return { sent: true, result, governed: true };
            }
        }),

        new AITool({
            name: "whatsapp_send_sticker",
            description: "Kirim stiker ke percakapan WhatsApp yang sedang berlangsung (URL .webp).",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "URL stiker .webp." }
                },
                required: ["url"]
            },
            execute: async ({ url }, ctx) => {
                const result = await submitGovernedService({ execution: ctx?.exec ?? null, capabilityId: "messaging.whatsapp", operation: "sendSticker", arguments: { number: ensureChat(), url }, expectedPostcondition: { kind: "notification-delivery" } });
                if (result?.outcome !== "COMPLETED") throw new Error(result?.detail ?? result?.reason ?? "canonical authority required");
                return { sent: true, result, governed: true };
            }
        })

    ];

}

module.exports = { whatsappTools };
