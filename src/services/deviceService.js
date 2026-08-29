const path = require("node:path");

const JsonStore = require("../core/config/JsonStore");

const telemetry = require("./telemetryService");

const DEFAULTS = {

    audio: {
        inputDeviceId: null,
        inputLabel: null,
        outputDeviceId: null,
        outputLabel: null,
        sampleRate: 16000,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        /** Ambang RMS (0..1) untuk dianggap ada suara. */
        vadThreshold: 0.02,
        wakeWord: null,
        enabled: false
    },

    video: {
        deviceId: null,
        label: null,
        width: 1280,
        height: 720,
        frameRate: 30,
        /** Interval kirim frame ke model vision, dalam detik. */
        captureInterval: 5,
        enabled: false
    },

    /**
     * Sensor eksternal. Damar tidak membaca hardware langsung —
     * tiap sensor dibaca lewat endpoint HTTP yang didefinisikan
     * di sini, sehingga sensor di PC rumah, ESP32, atau Home
     * Assistant diperlakukan sama.
     */
    sensors: [],

    /**
     * Kamera/CCTV. Tiap kamera punya URL snapshot (gambar diam)
     * yang bisa diambil Damar untuk dianalisis model vision —
     * mis. entitas kamera Home Assistant, RTSP-to-JPEG, atau IP cam.
     */
    cameras: [],

    updatedAt: null

};

class DeviceService {

    constructor() {

        this.store = new JsonStore(
            path.join(__dirname, "..", "..", "configs", "devices.json"),
            DEFAULTS
        );

    }

    get() {

        return this.store.read();

    }

    /** Simpan sebagian konfigurasi; bagian yang tidak dikirim dibiarkan. */
    update(patch = {}) {

        const current = this.get();

        const next = {

            audio: { ...current.audio, ...(patch.audio ?? {}) },

            video: { ...current.video, ...(patch.video ?? {}) },

            sensors: patch.sensors ?? current.sensors,

            cameras: patch.cameras ?? current.cameras

        };

        const saved = this.store.write(next);

        telemetry.publish("devices:updated", {
            audio: saved.audio.enabled,
            video: saved.video.enabled,
            sensors: saved.sensors.length
        });

        return saved;

    }

    addSensor(sensor) {

        const current = this.get();

        if (!sensor?.id) {
            throw new Error("Sensor id is required.");
        }

        if (current.sensors.some(s => s.id === sensor.id)) {
            throw new Error(`Sensor "${sensor.id}" already exists.`);
        }

        const entry = {
            id: sensor.id,
            label: sensor.label ?? sensor.id,
            type: sensor.type ?? "generic",
            unit: sensor.unit ?? null,
            url: sensor.url ?? null,
            /** Path bertitik ke nilai di dalam response JSON. */
            valuePath: sensor.valuePath ?? "value",
            enabled: sensor.enabled !== false
        };

        this.store.write({
            sensors: [...current.sensors, entry]
        });

        return entry;

    }

    removeSensor(id) {

        const current = this.get();

        this.store.write({
            sensors: current.sensors.filter(sensor => sensor.id !== id)
        });

        return true;

    }

    // ---- Kamera --------------------------------------------------

    cameras() {
        return this.get().cameras ?? [];
    }

    getCamera(id) {
        return this.cameras().find(c => c.id === id) ?? null;
    }

    addCamera(camera) {

        const current = this.get();

        if (!camera?.id) {
            throw new Error("Id kamera wajib diisi.");
        }

        if (!camera?.snapshotUrl) {
            throw new Error("URL snapshot kamera wajib diisi.");
        }

        if ((current.cameras ?? []).some(c => c.id === camera.id)) {
            throw new Error(`Kamera "${camera.id}" sudah ada.`);
        }

        const entry = {
            id: camera.id,
            label: camera.label ?? camera.id,
            snapshotUrl: camera.snapshotUrl,
            // Header opsional (mis. Authorization untuk kamera HA).
            headers: camera.headers ?? {},
            enabled: camera.enabled !== false
        };

        this.store.write({
            cameras: [...(current.cameras ?? []), entry]
        });

        return entry;

    }

    removeCamera(id) {

        const current = this.get();

        this.store.write({
            cameras: (current.cameras ?? []).filter(c => c.id !== id)
        });

        return true;

    }

    /** Ringkasan kesiapan perangkat untuk kartu status di dashboard. */
    readiness() {

        const config = this.get();

        return {

            audio: {
                configured: Boolean(config.audio.inputDeviceId),
                enabled: config.audio.enabled,
                label: config.audio.inputLabel
            },

            video: {
                configured: Boolean(config.video.deviceId),
                enabled: config.video.enabled,
                label: config.video.label
            },

            sensors: {
                total: config.sensors.length,
                enabled: config.sensors.filter(s => s.enabled).length
            },

            cameras: {
                total: (config.cameras ?? []).length,
                enabled: (config.cameras ?? []).filter(c => c.enabled).length
            }

        };

    }

}

module.exports = new DeviceService();
