const response = require("../utils/response");

const whatsapp = require("../services/whatsappService");

class WhatsAppController {

    status(req, res, next) {
        try {
            return response.success(res, "WhatsApp status", whatsapp.status());
        }
        catch (error) {
            next(error);
        }
    }

    /** Simpan nomor/izin/grup lalu (re)connect untuk pairing. */
    async saveConfig(req, res, next) {
        try {
            const { number, allowed, groups } = req.body ?? {};
            const status = await whatsapp.reconfigure({ number, allowed, groups });
            return response.success(res, "WhatsApp dikonfigurasi", status);
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /** Mulai koneksi → QR akan muncul untuk dipindai. */
    async connect(req, res, next) {
        try {
            await whatsapp.connect();
            return response.success(res, "Menyambungkan WhatsApp", whatsapp.status());
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /** Daftar grup yang nomor Damar sudah tergabung. */
    async groups(req, res, next) {
        try {
            return response.success(res, "WhatsApp groups", { groups: await whatsapp.listGroups() });
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    async logout(req, res, next) {
        try {
            return response.success(res, "WhatsApp logout", await whatsapp.logout());
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    async test(req, res, next) {
        try {
            if (!whatsapp.running) {
                return response.error(res, "WhatsApp belum tersambung.", 400);
            }
            const count = await whatsapp.broadcast(req.body?.text ?? "Uji dari Damar Console ✅");
            return response.success(res, "Terkirim", { recipients: count });
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

}

module.exports = new WhatsAppController();
