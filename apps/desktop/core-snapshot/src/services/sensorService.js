const HttpClient = require("../plugins/http/services/HttpClient");

const deviceService = require("./deviceService");

/**
 * Membaca sensor eksternal lewat HTTP.
 *
 * Damar tidak menyentuh hardware secara langsung supaya daemon
 * tetap portabel: sensor apa pun — ESP32, Home Assistant, skrip
 * Python di PC rumah — cukup mengekspos satu endpoint JSON.
 */
class SensorService {

    async read(sensor) {

        if (!sensor.url) {

            return {
                id: sensor.id,
                ok: false,
                error: "sensor url is not configured"
            };

        }

        const started = Date.now();

        const response = await HttpClient.get(sensor.url, {
            timeout: 5000
        });

        if (!response.success) {

            return {
                id: sensor.id,
                label: sensor.label,
                ok: false,
                latency: Date.now() - started,
                error: response.error ?? response.statusText ?? "unreachable"
            };

        }

        return {
            id: sensor.id,
            label: sensor.label,
            type: sensor.type,
            unit: sensor.unit,
            ok: true,
            latency: Date.now() - started,
            value: this.extract(response.data, sensor.valuePath),
            readAt: new Date().toISOString()
        };

    }

    /** Ambil nilai lewat path bertitik, mis. "data.temperature". */
    extract(payload, valuePath) {

        if (!valuePath) {
            return payload;
        }

        return valuePath
            .split(".")
            .reduce(
                (value, key) =>
                    (value == null ? undefined : value[key]),
                payload
            );

    }

    async readAll() {

        const sensors = deviceService
            .get()
            .sensors
            .filter(sensor => sensor.enabled);

        return Promise.all(
            sensors.map(sensor => this.read(sensor))
        );

    }

}

module.exports = new SensorService();
