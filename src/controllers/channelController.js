const response = require("../utils/response");

const { manager } = require("../channels");

/**
 * Bidang kendali untuk lapisan kanal & sesi percakapan persisten.
 */
class ChannelController {

    /** Daftar kanal terdaftar + statusnya. */
    list(req, res, next) {

        try {
            return response.success(res, "Channels", {
                channels: manager.list(),
                sessions: manager.sessions().length
            });
        }
        catch (error) {
            next(error);
        }

    }

    /** Daftar sesi percakapan tersimpan (persisten lintas restart). */
    async sessions(req, res, next) {

        try {
            const channel = req.query.channel ?? null;
            const rows = await manager.sessions(channel);
            return response.success(res, "Sessions", { sessions: rows });
        }
        catch (error) {
            next(error);
        }

    }

    /** Kosongkan satu sesi (lupakan konteks). */
    async clearSession(req, res, next) {

        try {
            await manager.forgetKey(req.params.key);
            return response.success(res, "Session cleared");
        }
        catch (error) {
            next(error);
        }

    }

}

module.exports = new ChannelController();
