const response = require("../utils/response");

const automation = require("../services/automationService");

class AutomationController {

    status(req, res, next) {
        try {
            return response.success(res, "Automation status", automation.status());
        }
        catch (error) {
            next(error);
        }
    }

    saveConfig(req, res, next) {
        try {
            const { enabled, time } = req.body ?? {};
            return response.success(res, "Automation disimpan", automation.configure({ enabled, time }));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /** Kirim brief sekarang (uji / manual). */
    async run(req, res, next) {
        try {
            const result = await automation.runBrief();
            return response.success(res, "Brief terkirim", result);
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

}

module.exports = new AutomationController();
