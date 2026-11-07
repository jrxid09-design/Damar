const response = require("../utils/response");
const filesService = require("../services/filesService");

class FilesController {
    async list(req, res, next) {
        try {
            return response.success(res, "Isi folder", await filesService.list(req.query.path || null));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }
}

module.exports = new FilesController();
