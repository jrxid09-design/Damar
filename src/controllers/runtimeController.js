const response = require("../utils/response");

const runtime = require("../runtime/runtimeService");
const { rejectLegacyActionRoute } = require("../manager/legacyBoundary");

// Runtime disembunyikan dari Console bila perlu (diganti MCP).
const HIDDEN_RUNTIME = new Set();

class RuntimeController {

    async status(req, res, next) {
        try {
            return response.success(res, "Runtime status", {
            runtimes: (await runtime.status()).filter(
                r => !HIDDEN_RUNTIME.has(String(r.key))
            )
        });
        }
        catch (error) { next(error); }
    }

    async restart(req, res, next) {
        try {
            rejectLegacyActionRoute("Console runtime");
            return response.success(res, "Restart", await runtime.restart(req.params.key));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

}

module.exports = new RuntimeController();
