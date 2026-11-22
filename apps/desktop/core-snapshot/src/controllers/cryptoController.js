const response = require("../utils/response");
const binance = require("../services/binanceService");

/**
 * Konfigurasi & status integrasi Binance untuk panel Settings.
 * Secret tak pernah dikembalikan mentah — hanya status + hint (mask).
 */
class CryptoController {

    /** Konfigurasi saat ini (tanpa membocorkan secret). */
    async config(req, res) {
        try {
            return response.success(res, "Crypto config", binance.configView());
        }
        catch (error) {
            return response.error(res, error.message, 500);
        }
    }

    /** Simpan apiKey/secret/testnet/proxyUrl. */
    async saveConfig(req, res) {
        try {
            return response.success(res, "Konfigurasi Binance disimpan", binance.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /**
     * Uji koneksi: data publik (harga) dan — bila terkonfigurasi —
     * akun (saldo). Membedakan geo-block (public jalan, account 403)
     * agar pengguna tahu ia butuh proxy.
     */
    async status(req, res) {
        const out = {
            configured: binance.configured,
            testnet: binance.testnet,
            proxy: Boolean(binance.proxyUrl),
            public: false,
            account: false
        };

        try {
            const p = await binance.price("BTCUSDT");
            out.public = true;
            out.btcUsdt = p.price;
        }
        catch (error) {
            out.publicError = error.message;
        }

        if (binance.configured) {
            try {
                const balances = await binance.spotBalances();
                out.account = true;
                out.spotAssets = balances.length;
            }
            catch (error) {
                out.accountError = error.message;
                if (/403|restricted|location|Eligibility/i.test(error.message)) {
                    out.hint = "Akun ditolak (kemungkinan geo-block). Set proxyUrl ke region yang diizinkan.";
                }
            }
        }

        return response.success(res, "Crypto status", out);
    }
}

module.exports = new CryptoController();
