const response = require("../utils/response");

const runtime = require("../runtime/runtimeService");

class RuntimeController {

    async status(req, res, next) {
        try {
            return response.success(res, "Runtime status", { runtimes: await runtime.status() });
        }
        catch (error) { next(error); }
    }

    async restart(req, res, next) {
        try {
            return response.success(res, "Restart", await runtime.restart(req.params.key));
        }
        catch (error) { return response.error(res, error.message, 400); }
    }

}

module.exports = new RuntimeController();
