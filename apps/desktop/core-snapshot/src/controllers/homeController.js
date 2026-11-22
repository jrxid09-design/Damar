const response = require("../utils/response");

const home = require("../services/homeService");
const mqtt = require("../services/mqttService");
const { submitGovernedService } = require("../services/governedServiceBoundary");

function requestContext(req) {
    const identity = req.authIdentity ?? {};
    return {
        channelType: "console",
        channelId: String(identity.channelId ?? req.ip ?? "http"),
        sessionId: String(identity.sessionId ?? req.headers?.["x-session-id"] ?? "http-session"),
        authProof: req.body?.authProof ?? null,
        correlationId: req.headers?.["x-correlation-id"] ?? null
    };
}

/** Kegagalan HA: belum dikonfigurasi = 400, selebihnya 502 (gateway). */
function fail(res, error) {

    const code = error.code === "HASS_NOT_CONFIGURED" ? 400 : 502;

    return response.error(res, error.message, code);

}

class HomeController {

    async status(req, res, next) {

        try {
            return response.success(res, "Home status", {
                ...home.configView(),
                health: await home.health()
            });
        }
        catch (error) {
            next(error);
        }

    }

    config(req, res, next) {

        try {
            return response.success(res, "Home config", home.configView());
        }
        catch (error) {
            next(error);
        }

    }

    saveConfig(req, res, next) {

        try {
            return response.success(res, "Konfigurasi rumah disimpan",
                home.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    async devices(req, res, next) {

        try {

            const [entities, summary] = await Promise.all([
                home.listEntities({ domain: req.query.domain ?? null }),
                home.summary().catch(() => null)
            ]);

            return response.success(res, "Home devices", { summary, devices: entities });

        }
        catch (error) {
            return fail(res, error);
        }

    }

    /** Daftar CCTV yang dikenal Home Assistant. */
    async cameras(req, res, next) {

        try {
            return response.success(res, "Home cameras", { cameras: await home.cameras() });
        }
        catch (error) {
            return fail(res, error);
        }

    }

    /**
     * Gambar kamera diteruskan lewat daemon, bukan diambil renderer
     * langsung dari HA: URL HA menuntut long-lived token, dan token
     * itu tidak boleh ikut masuk ke dalam halaman.
     */
    async cameraSnapshot(req, res, next) {

        try {

            const { buffer, contentType } = await home.cameraSnapshot(req.params.id);

            res.setHeader("Content-Type", contentType);
            res.setHeader("Cache-Control", "no-store");

            return res.end(buffer);

        }
        catch (error) {
            return fail(res, error);
        }

    }

    async control(req, res, next) {

        try {

            const { entity_id, action, value } = req.body ?? {};

            if (!entity_id || !action) {
                return response.error(res, "entity_id dan action wajib diisi.", 400);
            }

            // External-device mutation is a canonical Manager action.  This
            // controller is an ingress adapter only; it never calls HA/MQTT
            // directly and has no local authority substitute.
            if (String(entity_id).startsWith("mqtt:")) {
                const result = await submitGovernedService({
                    context: requestContext(req),
                    capabilityId: "home.mqtt",
                    operation: "control",
                    arguments: { entityId: entity_id.slice(5), action, value },
                    expectedPostcondition: { kind: "mqtt-command-ack", entityId, action }
                });
                if (result?.outcome !== "COMPLETED") return response.error(res, result?.detail ?? result?.reason ?? "Canonical authority required.", 403, result);
                return response.success(res, "Perangkat dikendalikan (MQTT)", { entity_id, action, result });
            }

            const result = await submitGovernedService({
                context: requestContext(req),
                capabilityId: "home.assistant",
                operation: "control",
                arguments: { entityId: entity_id, action, value },
                expectedPostcondition: { kind: "home-state", entityId: entity_id, action, value }
            });
            if (result?.outcome !== "COMPLETED") return response.error(res, result?.detail ?? result?.reason ?? "Canonical authority required.", 403, result);
            return response.success(res, "Perangkat dikendalikan", { entity_id, action, result });

        }
        catch (error) {
            return fail(res, error);
        }

    }

    // ---- MQTT --------------------------------------------------------

    mqttStatus(req, res, next) {
        try {
            return response.success(res, "MQTT status", mqtt.statusView());
        }
        catch (error) {
            next(error);
        }
    }

    mqttConfig(req, res, next) {
        try {
            return response.success(res, "Konfigurasi MQTT disimpan", mqtt.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }
    }

    /** Sambung ulang manual dari Console. */
    async mqttConnect(req, res, next) {
        try {
            const ok = await mqtt.connect();
            return response.success(res, ok ? "MQTT tersambung" : "MQTT gagal tersambung", {
                ...mqtt.statusView(),
                connected: ok
            });
        }
        catch (error) {
            return response.error(res, error.message, 502);
        }
    }

    mqttDisconnect(req, res, next) {
        try {
            return response.success(res, "MQTT diputus", mqtt.disconnect());
        }
        catch (error) {
            next(error);
        }
    }

    /** Publikasi mentah ke topik apa pun (debug/integrasi lanjutan). */
    async mqttPublish(req, res, next) {
        try {
            const { topic, payload, retain } = req.body ?? {};
            if (!topic) return response.error(res, "topic wajib diisi.", 400);
            const result = await submitGovernedService({
                context: requestContext(req),
                capabilityId: "home.mqtt",
                operation: "publish",
                arguments: { topic, payload: String(payload ?? ""), retain: Boolean(retain) },
                expectedPostcondition: { kind: "mqtt-publish-ack", topic }
            });
            if (result?.outcome !== "COMPLETED") return response.error(res, result?.detail ?? result?.reason ?? "Canonical authority required.", 403, result);
            return response.success(res, "Terkirim", { topic, payload: String(payload ?? ""), result });
        }
        catch (error) {
            return response.error(res, error.message, error.code === "MQTT_NOT_CONNECTED" ? 400 : 502);
        }
    }

}

module.exports = new HomeController();
