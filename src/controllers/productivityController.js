const response = require("../utils/response");

/**
 * ProductivityController — permukaan Control Dashboard untuk suite
 * MCP Produktivitas (src/mcp/productivity).
 *
 *   GET  /mcp/productivity                 registry + status koneksi (metadata saja)
 *   GET  /mcp/productivity/health/:id      tes koneksi hidup satu server
 *   POST /mcp/productivity/client/:id      simpan kredensial klien OAuth → vault
 *   DELETE /mcp/productivity/client/:id    lupakan kredensial klien + token
 *   POST /mcp/productivity/connect/:id     mulai connect → { authorizeUrl }
 *   POST /mcp/productivity/disconnect/:id  revoke + hapus token lokal
 *   POST /mcp/productivity/services/:id    nyala/matikan layanan suite (gmail/drive/…)
 *   POST /mcp/productivity/filesystem/grants  folder yang diberikan akses
 *   POST /mcp/productivity/blender/target     host/port jembatan Blender
 *   POST /mcp/productivity/seed               tanam server suite ke configs/mcp.json
 *   GET  /mcp/oauth/:providerId/callback      callback browser OAuth (state = bukti)
 *
 * Mutasi dirutekan lewat gerbang managerOnly yang sama dengan
 * administrasi MCP yang sudah ada (console.js). Nilai rahasia tidak
 * pernah masuk respons: status hanya metadata (lihat tokenStore).
 */

let suiteSingleton = null;
function getSuite() {
    if (!suiteSingleton) {
        const { createProductivitySuite } = require("../mcp/productivity");
        suiteSingleton = createProductivitySuite();
    }
    return suiteSingleton;
}

/** Untuk tes: suntik suite pengganti / reset singleton. */
function _setSuiteForTests(suite) {
    suiteSingleton = suite;
}

class ProductivityController {

    /** GET /mcp/productivity — registry + status semua server. */
    list(req, res, next) {
        try {
            const suite = getSuite();
            return response.success(res, "MCP Produktivitas", suite.connect.status());
        } catch (error) { next(error); }
    }

    /** GET /mcp/productivity/health/:serverId — tes hidup. */
    async health(req, res, next) {
        try {
            const suite = getSuite();
            const out = await suite.connect.health(req.params.serverId);
            return response.success(res, "MCP Produktivitas", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/client/:serverId — { clientId, clientSecret } → vault. */
    saveClient(req, res, next) {
        try {
            const suite = getSuite();
            const out = suite.connect.saveClientCredentials(req.params.serverId, {
                clientId: req.body?.clientId,
                clientSecret: req.body?.clientSecret
            });
            return response.success(res, "Kredensial klien tersimpan di vault", out);
        } catch (error) { next(error); }
    }

    /** DELETE /mcp/productivity/client/:serverId — lupakan klien + token. */
    forgetClient(req, res, next) {
        try {
            const suite = getSuite();
            const out = suite.connect.forgetClientCredentials(req.params.serverId);
            return response.success(res, "Kredensial dilupakan", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/connect/:serverId — mulai alur consent. */
    startConnect(req, res, next) {
        try {
            const suite = getSuite();
            const server = suite.registry.SERVER_BY_ID.get(req.params.serverId);
            if (!server?.provider) {
                return res.status(400).json({ success: false, message: "Server tidak memakai OAuth" });
            }
            const host = req.headers.host || "127.0.0.1";
            const redirectUri = `http://${host}/api/v1/console/mcp/oauth/${server.provider}/callback`;
            const out = suite.connect.startConnect(req.params.serverId, { redirectUri });
            return response.success(res, "Alur connect dimulai", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/disconnect/:serverId */
    async disconnect(req, res, next) {
        try {
            const suite = getSuite();
            const out = await suite.connect.disconnect(req.params.serverId);
            return response.success(res, "Terputus", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/services/:serverId — { service, enabled } */
    setService(req, res, next) {
        try {
            const suite = getSuite();
            const out = suite.connect.setServiceEnabled(
                req.params.serverId, req.body?.service, req.body?.enabled === true);
            return response.success(res, "Layanan diperbarui", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/filesystem/grants — { grants: [absPath, …] } */
    setGrants(req, res, next) {
        try {
            const suite = getSuite();
            const out = suite.connect.setFilesystemGrants(
                Array.isArray(req.body?.grants) ? req.body.grants : []);
            return response.success(res, "Folder akses diperbarui", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/blender/target — { host, port } */
    setBlenderTarget(req, res, next) {
        try {
            const suite = getSuite();
            const out = suite.connect.setBlenderTarget({
                host: req.body?.host, port: req.body?.port
            });
            return response.success(res, "Target Blender diperbarui", out);
        } catch (error) { next(error); }
    }

    /** POST /mcp/productivity/seed — tanam server suite ke configs/mcp.json. */
    seed(req, res, next) {
        try {
            const { seedMcpConfig } = require("../mcp/productivity");
            const seeded = seedMcpConfig({});
            return response.success(res, "Server suite terdaftar di configs/mcp.json", { seeded });
        } catch (error) { next(error); }
    }

    /**
     * GET /mcp/oauth/:providerId/callback — callback browser dari
     * provider. TANPA kredensial Damar, by design: state sekali pakai
     * (TTL 10 menit) adalah bukti CSRF-nya — pola localhost OAuth yang
     * sama dengan oauth-login OpenRouter di desktop core-host.
     */
    async callback(req, res) {
        const suite = getSuite();
        let result;
        try {
            result = await suite.connect.handleCallback(req.params.providerId, {
                code: req.query?.code,
                state: req.query?.state,
                error: req.query?.error
            });
        } catch (e) {
            result = { ok: false, error: e?.message || "OAUTH_FAILED" };
        }
        const msg = result.ok
            ? "Terhubung. Layanan sekarang terhubung ke DAMAR — kembali ke Control Dashboard."
            : `Login tidak selesai (${String(result.error || "gagal").slice(0, 80)}). Kembali ke Control Dashboard dan coba lagi.`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=\"utf-8\"><title>DAMAR — Connect</title>"
            + "<body style=\"font-family:system-ui;background:#0b0b0d;color:#e8e3d8;display:grid;place-items:center;height:100vh;margin:0\">"
            + `<div style="text-align:center;max-width:420px;padding:20px"><h2>DAMAR</h2><p>${msg}</p></div>`);
    }
}

module.exports = new ProductivityController();
module.exports._setSuiteForTests = _setSuiteForTests;
