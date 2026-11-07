const response = require("../utils/response");

const roles = require("../services/roleService");

class RoleController {

    status(req, res, next) {
        try {
            return response.success(res, "Roles", roles.describe());
        }
        catch (error) {
            next(error);
        }
    }

    saveConfig(req, res, next) {
        try {
            const { superadmins, admins } = req.body ?? {};
            return response.success(res, "Peran disimpan", roles.setConfig({ superadmins, admins }));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

}

module.exports = new RoleController();
