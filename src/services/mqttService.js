const path = require("node:path");

const mqtt = require("mqtt");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Jembatan MQTT - tulang punggung rumah selain Home Assistant.
 *
 * Banyak perangkat rumah (Tasmota, Zigbee2MQTT, ESPHome, Shelly,
 * Sonoff LAN) bicara langsung ke broker MQTT. Dengan menyambung ke
 * broker yang sama, Aether bisa:
 *   - menemukan perangkat lewat HA MQTT Discovery (`homeassistant/#`),
 *   - membaca state mereka REALTIME (tanpa polling REST),
 *   - mengendalikan lewat command topic (lebih cepat dari REST).
 *
 * Format discovery mengikuti standar HA:
 *   homeassistant/<component>/<node_id>/<object_id>/config
 * Payload JSON berisi state_topic/command_topic (dengan substitusi `~`).
 *
 * Config disimpan di configs/mqtt.json (gitignored); password dimasking.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "mqtt.json"),
    { url: null, username: null, password: null, clientId: null, base: "aether" }
);

class MqttService {

    constructor() {
        this.client = null;
        this.state = "off";          // off | connecting | connected | reconnecting | error
        this.lastError = null;
        this.connectedAt = null;
        /** Registry hasil discovery: key -> entri entitas. */
        this.registry = new Map();
        /** Cache state terakhir per topic: topic -> {payload, ts}. */
        this.states = new Map();
    }

    cfg() {
        return store.read();
    }

    get url() {
        const u = String(this.cfg().url || process.env.AETHER_MQTT_URL || "").trim();
        return u ? u.replace(/\/+$/, "") : null;
    }
    get username() {
        return this.cfg().username ?? process.env.AETHER_MQTT_USERNAME ?? null;
    }
    get password() {
        return this.cfg().password ?? process.env.AETHER_MQTT_PASSWORD ?? null;
    }
    get base() {
        return String(this.cfg().base || "aether").replace(/\/+$/, "");
    }
    get configured() {
        return Boolean(this.url);
    }
    get connected() {
        return this.state === "connected";
    }

    setConfig({ url, username, password, base } = {}) {

        const prevUrl = this.cfg().url;

        store.write({
            url: url !== undefined ? (url || null) : this.cfg().url,
            username: username !== undefined ? (username || null) : this.cfg().username,
            // password undefined = jangan ubah; "" = hapus (pola sama dgn token HA).
            password: password === undefined ? this.cfg().password : (password || null),
            base: base !== undefined ? (base || "aether") : (this.cfg().base || "aether")
        });

        // Konfigurasi berubah -> sambung ulang agar efeknya langsung terasa.
        if ((prevUrl ?? "") !== (this.cfg().url ?? "")) {
            this.connect().catch(() => {});
        }

        return this.configView();

    }

    mask(s) {
        if (!s) return null;
        const t = String(s);
        return t.length <= 8 ? "\u2022\u2022\u2022\u2022" : `${t.slice(0, 4)}\u2026${t.slice(-4)}`;
    }

    maskUrl() {
        return String(this.url ?? "").replace(/\/\/[^@/]+@/, "//\u2022\u2022\u2022@");
    }

    configView() {
        const c = this.cfg();
        return {
            url: c.url ?? "",
            username: c.username ?? "",
            hasPassword: Boolean(this.password),
            passwordHint: this.mask(this.password),
            base: this.base,
            configured: this.configured,
            state: this.state,
            connected: this.connected
        };
    }

    statusView() {
        return {
            ...this.configView(),
            urlMasked: this.maskUrl(),
            uptime: this.connectedAt && this.connected ? Date.now() - this.connectedAt : 0,
            discovered: this.registry.size,
            topics: this.states.size,
            lastError: this.lastError
        };
    }

    /** Sambung ke broker. Idempoten: koneksi lama ditutup dulu. */
    connect() {

        if (!this.configured) {
            this.state = "off";
            return Promise.resolve(false);
        }

        if (this.client) {
            try { this.client.end(true); } catch { /* sudah mati */ }
            this.client = null;
        }

        this.state = "connecting";
        const clientId = this.cfg().clientId || `aether-${Date.now().toString(36)}`;

        return new Promise((resolve) => {

            let settled = false;
            const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

            const client = mqtt.connect(this.url, {
                clientId,
                username: this.username || undefined,
                password: this.password || undefined,
                keepalive: 30,
                reconnectPeriod: 5000,
                connectTimeout: 8000,
                clean: true
            });

            this.client = client;

            client.on("connect", () => {

                this.state = "connected";
                this.lastError = null;
                this.connectedAt = Date.now();

                // Discovery HA: config message biasanya RETAINED, jadi
                // broker langsung mengulurkan seluruh registry saat ini.
                client.subscribe(["homeassistant/#", `${this.base}/#`], (err) => {
                    if (err) this.lastError = err.message;
                    settle(true);
                });

                telemetry.publish("home:mqtt", { event: "connected", url: this.maskUrl() });

            });

            client.on("reconnect", () => {
                if (this.state !== "connected") this.state = "reconnecting";
            });

            client.on("close", () => {
                if (this.state === "connected") this.state = "reconnecting";
            });

            client.on("error", (err) => {
                this.state = "error";
                this.lastError = err.message;
                settle(false);
            });

            client.on("message", (topic, payload) => this.onMessage(topic, payload));

        });

    }

    disconnect() {
        if (this.client) {
            try { this.client.end(true); } catch { /* abaikan */ }
            this.client = null;
        }
        this.state = "off";
        this.registry.clear();
        this.states.clear();
        telemetry.publish("home:mqtt", { event: "disconnected" });
        return this.statusView();
    }

    /** Router pesan masuk: discovery config vs state biasa. */
    onMessage(topic, payloadBuf) {

        const payload = payloadBuf?.toString?.() ?? "";

        if (topic.startsWith("homeassistant/") && topic.endsWith("/config")) {
            this.onDiscovery(topic, payload);
            return;
        }

        this.onState(topic, payload);

    }

    /**
     * HA MQTT Discovery. Bentuk topik:
     *   homeassistant/<domain>/<node>/<object>/config
     * atau tanpa <node>. Simpan registry + berlangganan state_topic-nya
     * (state perangkat ditulis DI LUAR prefix homeassistant/).
     */
    onDiscovery(topic, payloadStr) {

        const parts = topic.split("/");
        const domain = parts[1] ?? "sensor";
        const objectId = parts.length >= 5 ? parts[parts.length - 2] : (parts[2] ?? "unknown");

        // Payload kosong = entitas dihapus dari registry.
        if (!payloadStr.trim()) {
            for (const [key, ent] of [...this.registry]) {
                if (ent.discoveryTopic === topic) {
                    if (ent.stateTopic) this.unsubscribeIfOrphan(ent.stateTopic);
                    this.registry.delete(key);
                }
            }
            return;
        }

        let cfg;
        try { cfg = JSON.parse(payloadStr); } catch { return; }

        const tilde = typeof cfg["~"] === "string" ? cfg["~"] : "";
        const expand = (t) => (tilde && typeof t === "string")
            ? t.replaceAll("~", tilde)
            : t;

        const entry = {
            key: cfg.unique_id || `${domain}.${objectId}`,
            domain,
            objectId,
            name: cfg.name ?? objectId,
            discoveryTopic: topic,
            stateTopic: expand(cfg.state_topic) ?? null,
            commandTopic: expand(cfg.command_topic),
            payloadOn: cfg.payload_on ?? "ON",
            payloadOff: cfg.payload_off ?? "OFF",
            optimistic: Boolean(cfg.optimistic),
            brightnessCommandTopic: expand(cfg.brightness_command_topic) ?? null,
            brightnessScale: Number(cfg.brightness_scale ?? 255),
            positionTopic: expand(cfg.position_topic) ?? null,
            positionCommandTopic: expand(cfg.set_position_topic) ?? null,
            stopCommandTopic: expand(cfg.stop_command_topic) ?? null,
            temperatureCommandTopic: expand(cfg.temperature_command_topic) ?? null,
            modeCommandTopic: expand(cfg.mode_command_topic) ?? null,
            unitOfMeasurement: cfg.unit_of_measurement ?? null,
            deviceClass: cfg.device_class ?? null,
            device: cfg.device?.name ?? null,
            icon: cfg.icon ?? null
        };

        // Key duplikat (entitas multi-config) -> timpa; konfigurasi
        // terbaru adalah yang sah menurut HA.
        this.registry.set(entry.key, entry);

        if (entry.stateTopic) this.subscribeSafe(entry.stateTopic);

    }

    subscribeSafe(topic) {
        try {
            this.client?.subscribe(topic, { qos: 0 }, () => {});
        } catch { /* belum tersambung */ }
    }

    unsubscribeIfOrphan(topic) {
        const stillUsed = [...this.registry.values()].some(e => e.stateTopic === topic);
        if (!stillUsed && !topic.startsWith("homeassistant/") && !topic.startsWith(`${this.base}/`)) {
            try { this.client?.unsubscribe(topic, () => {}); } catch { /* abaikan */ }
        }
    }

    /** Cache state + umumkan perubahan ke seluruh Console via SSE. */
    onState(topic, payloadStr) {

        const prev = this.states.get(topic);
        // Dedup: retained/QoS-1 sering mengirim ulang nilai sama persis.
        if (prev && prev.payload === payloadStr) return;

        this.states.set(topic, { payload: payloadStr, ts: Date.now() });

        const affected = [];
        for (const ent of this.registry.values()) {
            if (ent.stateTopic === topic) affected.push(ent.key);
        }

        // Hanya siarkan bila ada yang memperhatikan - menghindari banjir
        // event untuk topik internal yang tak dipetakan ke entitas.
        if (affected.length > 0) {
            telemetry.publish("home:mqtt", { topic, payload: payloadStr, entities: affected });
        }

    }

    /** Publikasi mentah ke broker. */
    async publish(topic, payload, { retain = false } = {}) {

        if (!this.connected) {
            const error = new Error("MQTT belum tersambung.");
            error.code = "MQTT_NOT_CONNECTED";
            throw error;
        }

        await new Promise((resolve, reject) => {
            this.client.publish(topic, String(payload), { qos: 0, retain }, (err) => {
                err ? reject(err) : resolve();
            });
        });

        telemetry.publish("home:action", { via: "mqtt", topic, payload: String(payload) });

    }

    /**
     * Kendali entitas hasil discovery: on|off|toggle|brightness|temperature.
     * Mengembalikan true bila entitasnya memang milik MQTT (dan
     * perintah terkirim); false berarti biarkan jalur lain (HA REST).
     */
    async control(key, action, value) {

        const ent = this.registry.get(key);
        if (!ent || !this.connected) return false;

        switch (action) {

            case "on":
            case "off":
            case "open":   // cover: buka/tutup = payload on/off (konvensi HA)
            case "close": {
                if (!ent.commandTopic) return false;
                const isOnPayload = ["on", "open"].includes(action);
                await this.publish(ent.commandTopic, isOnPayload ? ent.payloadOn : ent.payloadOff);
                break;
            }

            // Tirai: berhenti di tengah jalan.
            case "stop": {
                if (!ent.stopCommandTopic) return false;
                await this.publish(ent.stopCommandTopic, "STOP");
                break;
            }

            case "toggle": {
                if (!ent.commandTopic) return false;
                const cur = this.readState(ent)?.raw;
                const isOn = cur === ent.payloadOn || cur === "ON" || cur === "true";
                await this.publish(ent.commandTopic, isOn ? ent.payloadOff : ent.payloadOn);
                break;
            }

            case "brightness": {
                if (!ent.brightnessCommandTopic) return false;
                const scale = ent.brightnessScale || 255;
                const scaled = Math.max(0, Math.min(scale, Math.round((Number(value) / 100) * scale)));
                await this.publish(ent.brightnessCommandTopic, scaled);
                break;
            }

            case "temperature": {
                const topic = ent.temperatureCommandTopic ?? ent.modeCommandTopic;
                if (!topic) return false;
                await this.publish(topic, Number(value));
                break;
            }

            case "position": {
                if (!ent.positionCommandTopic) return false;
                await this.publish(ent.positionCommandTopic, Number(value));
                break;
            }

            default:
                return false;

        }

        // Optimistic update supaya kartu UI merespons instan walau
        // perangkat tidak menerbitkan state baru (perilaku HA sama).
        if (ent.optimistic && ent.stateTopic && ["on", "off", "toggle", "open", "close"].includes(action)) {
            const payload = action === "off" ? ent.payloadOff : ent.payloadOn;
            this.states.set(ent.stateTopic, { payload, ts: Date.now() });
            telemetry.publish("home:mqtt", {
                topic: ent.stateTopic, payload, entities: [ent.key], optimistic: true
            });
        }

        return true;

    }

    /** State tercache untuk satu entri registry. */
    readState(ent) {
        if (!ent?.stateTopic) return null;
        const raw = this.states.get(ent.stateTopic)?.payload ?? null;
        if (raw === null || raw === "") return null;
        // Angka/sensor: kirim apa adanya; on/off: petakan payload.
        const isBinary = ent.domain !== "sensor" && ent.domain !== "binary_sensor";
        let normalized = raw;
        if (isBinary) {
            normalized = (raw === ent.payloadOn || raw === "ON" || raw === "true" || raw === 1)
                ? "on" : "off";
        } else if (ent.domain === "binary_sensor") {
            normalized = (raw === ent.payloadOn || raw === "ON" || raw === "true") ? "on" : "off";
        }
        return { raw, state: normalized };
    }

    /**
     * Semua entitas MQTT untuk UI - digabungkan dengan state tercache.
     * source:"mqtt" membedakannya dari entitas HA REST.
     */
    entities() {

        return [...this.registry.values()].map(ent => {

            const st = this.readState(ent);

            return {
                id: `mqtt:${ent.key}`,
                key: ent.key,
                domain: ent.domain,
                name: ent.device ? `${ent.device} ${ent.name}`.trim() : ent.name,
                state: st?.state ?? st?.raw ?? "unknown",
                attributes: {
                    unit_of_measurement: ent.unitOfMeasurement,
                    device_class: ent.deviceClass,
                    icon: ent.icon,
                    via: "mqtt"
                },
                source: "mqtt",
                capabilities: {
                    toggle: Boolean(ent.commandTopic),
                    brightness: Boolean(ent.brightnessCommandTopic),
                    temperature: Boolean(ent.temperatureCommandTopic),
                    position: Boolean(ent.positionCommandTopic)
                }
            };

        });

    }

}

module.exports = new MqttService();
