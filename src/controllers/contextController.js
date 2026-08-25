const response = require("../utils/response");

const context = require("../services/contextService");

class ContextController {

    async snapshot(req, res, next) {
        try {
            return response.success(res, "Context snapshot", await context.snapshot());
        }
        catch (error) {
            next(error);
        }
    }

    async brief(req, res, next) {
        try {
            // N2-FINAL: giliran narasi mewarisi identitas pemanggil HTTP.
            return response.success(res, "Context brief", await context.brief(req.authIdentity ?? null));
        }
        catch (error) {
            return response.error(res, error.message, 500);
        }
    }

}

module.exports = new ContextController();
