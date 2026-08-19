const response = require("../utils/response");
const telegram = require("../services/telegramService");

class TelegramController {

    status(req, res) {
        return response.success(res, "Status Telegram", telegram.status());
    }

    saveConfig(req, res) {

        try {

            const { token, allowed, groups } = req.body ?? {};

            const state = telegram.setConfig({ token, allowed, groups });

            return response.success(res, "Konfigurasi Telegram disimpan", state);

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async test(req, res) {

        try {

            // Kirim pesan uji ke chat id pertama yang diizinkan.
            const target = req.body?.chatId ?? [...telegram.allowedIds()][0];

            if (!target) {
                return response.error(res, "Belum ada chat id yang diizinkan.", 400);
            }

            const result = await telegram.send(
                target,
                "Aether terhubung ke Telegram. ✅"
            );

            return response.success(res, "Pesan uji terkirim", result);

        }
        catch (error) {
            return response.error(res, error.message, 502);
        }

    }

    async reconnect(req, res) {

        telegram.stop();

        try {
            await telegram.start();
        }
        catch (error) {
            return response.error(res, error.message, 502);
        }

        return response.success(res, "Telegram disambung ulang", telegram.status());

    }

}

module.exports = new TelegramController();
