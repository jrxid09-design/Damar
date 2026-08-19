const response = require("../utils/response");

const telemetry = require("../services/telemetryService");

const config = require("../config/env");

const pluginRegistry = require("../plugins/pluginRegistry");

const { ToolRegistry } = require("../core/tools");

const { manager } = require("../integrations");

const deviceService = require("../services/deviceService");

const aiRuntime = require("../services/aiRuntimeService");

class TelemetryController {

    stats(req, res, next) {

        try {
            return response.success(res, "System stats", telemetry.stats());
        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Satu panggilan yang mengisi seluruh dashboard.
     *
     * Sengaja digabung agar Console tidak perlu enam request
     * paralel setiap kali menyegarkan tampilan.
     */
    async overview(req, res, next) {

        try {

            const integrations = manager.snapshot();

            const [providers] = await Promise.all([
                aiRuntime.providers().catch(error => ({
                    active: null,
                    providers: [],
                    error: error.message
                }))
            ]);

            return response.success(res, "Aether overview", {

                daemon: {
                    name: config.appName,
                    version: config.version,
                    environment: config.environment,
                    port: config.port
                },

                stats: telemetry.stats(),

                ai: {
                    ...providers,
                    defaultModel: aiRuntime.defaultModel,
                    metrics: aiRuntime.metrics()
                },

                integrations: {
                    summary: manager.summary(),
                    items: integrations
                },

                plugins: {
                    total: pluginRegistry.count(),
                    items: pluginRegistry.describe()
                },

                tools: {
                    total: ToolRegistry.count(),
                    items: ToolRegistry.describe()
                },

                devices: deviceService.readiness()

            });

        }
        catch (error) {
            next(error);
        }

    }

    logs(req, res, next) {

        try {

            const limit = Number(req.query.limit ?? 200);

            return response.success(res, "Recent logs", {
                logs: telemetry.logs({
                    limit: Number.isFinite(limit) ? limit : 200,
                    level: req.query.level ?? null
                })
            });

        }
        catch (error) {
            next(error);
        }

    }

    /**
     * Aliran realtime untuk Console: log baru, perubahan status
     * integrasi, dan event tool. Heartbeat berkala menjaga koneksi
     * tidak diputus proxy/OS saat sedang sepi.
     */
    events(req, res) {

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        send("hello", {
            connectedAt: new Date().toISOString(),
            backlog: telemetry.logs({ limit: 50 })
        });

        const onLog = entry => send("log", entry);
        const onEvent = event => send("event", event);

        telemetry.on("log", onLog);
        telemetry.on("event", onEvent);

        const heartbeat = setInterval(() => {
            res.write(": ping\n\n");
        }, 20000);

        req.on("close", () => {
            clearInterval(heartbeat);
            telemetry.off("log", onLog);
            telemetry.off("event", onEvent);
            res.end();
        });

    }

}

module.exports = new TelemetryController();
