const response = require("../utils/response");

const pluginRegistry = require("../plugins/pluginRegistry");

const { ToolRegistry } = require("../core/tools");

const telemetry = require("../services/telemetryService");

class PluginController {

    list(req, res, next) {

        try {
            return response.success(res, "Loaded plugins", {
                total: pluginRegistry.count(),
                plugins: pluginRegistry.describe()
            });
        }
        catch (error) {
            next(error);
        }

    }

    tools(req, res, next) {

        try {

            const all = ToolRegistry.describe();

            const filtered = req.query.plugin
                ? all.filter(tool => tool.pluginId === req.query.plugin)
                : all;

            return response.success(res, "Registered tools", {
                total: filtered.length,
                tools: filtered
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** Jalankan tool langsung dari Console, tanpa lewat model. */
    async execute(req, res, next) {

        try {

            const { id } = req.params;

            if (!ToolRegistry.has(id)) {
                return response.error(res, `Tool '${id}' not found.`, 404);
            }

            const started = Date.now();

            const result = await ToolRegistry.execute(
                id,
                req.body?.args ?? {},
                { source: "console" }
            );

            telemetry.info(`Tool "${id}" dijalankan dari Console`);

            return response.success(res, "Tool executed", {
                tool: id,
                duration: Date.now() - started,
                result
            });

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

}

module.exports = new PluginController();
