const response = require("../utils/response");

const forge = require("../services/toolForge");

class ForgeController {

    list(req, res, next) {

        try {
            return response.success(res, "Forge tools", forge.list());
        }
        catch (error) {
            next(error);
        }

    }

    read(req, res, next) {

        try {

            const spec = forge.read(req.params.id);

            if (!spec) {
                return response.error(res, "Tool tidak ditemukan.", 404);
            }

            return response.success(res, "Tool", spec);

        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Buat/perbarui tool manual dari Console. Body:
     * { id, name, description, tool:{ name, parameters, code }, activate }
     */
    create(req, res, next) {

        try {

            const body = req.body ?? {};

            const result = forge.create(
                { ...body, origin: body.origin ?? "manual" },
                { activate: body.activate === true }
            );

            return response.success(res, "Tool disimpan", result, 201);

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    approve(req, res, next) {

        try {
            return response.success(res, "Draft disetujui", forge.approve(req.params.id));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    reject(req, res, next) {

        try {
            return response.success(res, "Draft ditolak", {
                rejected: forge.reject(req.params.id)
            });
        }
        catch (error) {
            next(error);
        }

    }

    remove(req, res, next) {

        try {
            return response.success(res, "Tool dihapus", {
                removed: forge.remove(req.params.id)
            });
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

}

module.exports = new ForgeController();
