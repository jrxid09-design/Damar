const toolGuard = require("../../core/safety/toolGuard");

/**
 * Titik tunggal yang dilalui setiap pemanggilan tool oleh model.
 *
 * Dulu di sini hanya ada kill switch, dengan asumsi sisa rantai
 * keselamatan sudah dijalankan `ToolRegistry.execute`. Asumsi itu
 * hanya benar untuk tool plugin yang dijembatani; tool asli model —
 * memori, rumah, WhatsApp, terminal, coding — didaftarkan langsung
 * ke registry AI dan tidak pernah menyentuh registry inti. Akibatnya
 * `terminal_run` dan `code_commit` berjalan tanpa otorisasi risiko,
 * tanpa rem kebuntuan, tanpa batas jalur, dan tanpa verifikasi.
 *
 * Sekarang rantai yang sama (`core/safety/toolGuard`) berlaku di
 * kedua jalur. Tool jembatan dilewati di sini justru supaya TIDAK
 * dijaga dua kali: penjagaan ganda membuat rem kebuntuan menghitung
 * satu panggilan sebagai dua, sehingga tool sah tertahan lebih cepat
 * daripada yang dirancang.
 */
class ToolExecutor {

    constructor(registry) {

        this.registry = registry;

    }

    async execute(call) {

        const tool = this.registry.get(call.name);

        if (!tool) {

            throw new Error(`Tool '${call.name}' not found.`);

        }

        // Tool jembatan membawa id registry intinya; registry itulah
        // yang menjaga dan memverifikasinya sesaat lagi.
        const bridged = Boolean(tool.bridged);

        if (!bridged) {
            toolGuard.before(call.name, call.arguments ?? {}, tool);
        }

        let result;

        try {
            result = await tool.execute(call.arguments);
        }
        catch (error) {

            if (!bridged) {
                toolGuard.failed(call.name, error);
            }

            throw error;

        }

        if (!bridged) {
            await toolGuard.after(call.name, call.arguments ?? {}, result);
        }

        return {

            toolCallId: call.id,

            name: call.name,

            result

        };

    }

}

module.exports = ToolExecutor;
