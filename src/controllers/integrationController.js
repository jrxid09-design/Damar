const response = require("../utils/response");

const { manager } = require("../integrations");

class IntegrationController {

    list(req, res, next) {

        try {
            return response.success(res, "Integrations", {
                summary: manager.summary(),
                integrations: manager.snapshot()
            });
        }
        catch (error) {
            next(error);
        }

    }

    async check(req, res, next) {

        try {

            const { id } = req.params;

            const snapshot = await manager.check(id);

            if (!snapshot) {
                return response.error(res, `Integration '${id}' not found.`, 404);
            }

            return response.success(res, "Integration checked", snapshot);

        }
        catch (error) {
            next(error);
        }

    }

    async checkAll(req, res, next) {

        try {
            return response.success(res, "Integrations checked", {
                summary: manager.summary(),
                integrations: await manager.checkAll()
            });
        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Perubahan di sini hanya berlaku selama proses berjalan;
     * konfigurasi permanen tetap di configs/integrations.json
     * supaya sumber kebenarannya satu dan bisa di-review.
     */
    async update(req, res, next) {

        try {

            const { id } = req.params;

            const connector = manager.get(id);

            if (!connector) {
                return response.error(res, `Integration '${id}' not found.`, 404);
            }

            const { baseUrl, enabled, apiKey } = req.body;

            if (baseUrl !== undefined) {
                connector.baseUrl = String(baseUrl).replace(/\/+$/, "");
                connector.resolvedHealthPath = null;
            }

            if (enabled !== undefined) {
                connector.enabled = Boolean(enabled);
            }

            if (apiKey !== undefined) {
                connector.apiKey = apiKey || null;
            }

            return response.success(
                res,
                "Integration updated (runtime only)",
                await manager.check(id)
            );

        }
        catch (error) {
            next(error);
        }

    }

    async models(req, res, next) {

        try {

            const connector = manager.get(req.params.id);

            if (!connector) {
                return response.error(res, "Integration not found.", 404);
            }

            if (typeof connector.listModels !== "function") {
                return response.error(
                    res,
                    `Integration '${connector.id}' does not expose models.`,
                    400
                );
            }

            return response.success(res, "Integration models", {
                models: await connector.listModels()
            });

        }
        catch (error) {
            next(error);
        }

    }

}

module.exports = new IntegrationController();
