const EventEmitter = require("node:events");

const fs = require("node:fs");
const path = require("node:path");

const OllamaConnector = require("./connectors/OllamaConnector");
const OpenClawConnector = require("./connectors/OpenClawConnector");
const HermesConnector = require("./connectors/HermesConnector");
const AgentConnector = require("./connectors/AgentConnector");

const CONNECTOR_TYPES = {
    ollama: OllamaConnector,
    openclaw: OpenClawConnector,
    hermes: HermesConnector,
    agent: AgentConnector,
    http: AgentConnector
};

const DEFAULT_CONFIG_PATH = path.join(
    __dirname,
    "..",
    "..",
    "configs",
    "integrations.json"
);

/**
 * Mengelola seluruh sambungan Aether ke sistem luar dan
 * memantau kesiapannya secara berkala.
 *
 * Konfigurasi sengaja berbasis file supaya kode yang sama bisa
 * jalan di laptop (semua localhost) maupun di PC rumah (Ollama
 * lokal, agent di host lain) tanpa perubahan kode.
 */
class IntegrationManager extends EventEmitter {

    constructor({
        configPath = DEFAULT_CONFIG_PATH,
        pollInterval = 15000,
        logger = null
    } = {}) {

        super();

        this.configPath = configPath;

        this.pollInterval = pollInterval;

        this.logger = logger;

        /** @type {Map<string, import("./BaseConnector")>} */
        this.connectors = new Map();

        this.timer = null;

        this.config = { integrations: [] };

    }

    load() {

        this.config = this.readConfig();

        this.connectors.clear();

        for (const entry of this.config.integrations ?? []) {

            try {

                this.connectors.set(
                    entry.id,
                    this.createConnector(entry)
                );

            }

            catch (error) {

                this.logger?.error(
                    `[integrations] failed to create "${entry.id}": ${error.message}`
                );

            }

        }

        return this;

    }

    readConfig() {

        if (!fs.existsSync(this.configPath)) {

            return { pollInterval: this.pollInterval, integrations: [] };

        }

        try {

            const raw = fs.readFileSync(this.configPath, "utf8");

            const config = JSON.parse(raw);

            if (config.pollInterval) {
                this.pollInterval = config.pollInterval;
            }

            return config;

        }

        catch (error) {

            this.logger?.error(
                `[integrations] invalid config at ${this.configPath}: ${error.message}`
            );

            return { integrations: [] };

        }

    }

    createConnector(entry) {

        const Type =
            CONNECTOR_TYPES[String(entry.type ?? entry.id).toLowerCase()];

        if (!Type) {

            throw new Error(
                `Unknown integration type "${entry.type}".`
            );

        }

        return new Type(this.applyEnvOverrides(entry));

    }

    /**
     * Variabel lingkungan menang atas file konfigurasi supaya
     * deployment di PC rumah bisa mengubah alamat tanpa
     * menyentuh file yang ter-commit.
     * Contoh: AETHER_OLLAMA_URL, AETHER_HERMES_KEY.
     */
    applyEnvOverrides(entry) {

        const prefix = `AETHER_${String(entry.id).toUpperCase()}`;

        const url = process.env[`${prefix}_URL`];
        const key = process.env[`${prefix}_KEY`];
        const enabled = process.env[`${prefix}_ENABLED`];

        return {
            ...entry,
            baseUrl: url ?? entry.baseUrl,
            apiKey: key ?? entry.apiKey ?? null,
            enabled:
                enabled != null
                    ? enabled !== "false" && enabled !== "0"
                    : entry.enabled !== false
        };

    }

    get(id) {

        return this.connectors.get(id);

    }

    list() {

        return [...this.connectors.values()];

    }

    /** Probe semua konektor sekaligus dan kembalikan snapshot-nya. */
    async checkAll() {

        const results = await Promise.all(
            this.list().map(connector => this.check(connector.id))
        );

        this.emit("integrations:checked", results);

        return results;

    }

    async check(id) {

        const connector = this.get(id);

        if (!connector) {
            return null;
        }

        const before = connector.lastStatus.online;

        const snapshot = await connector.check();

        if (before !== snapshot.status.online) {

            this.emit("integration:changed", snapshot);

            this.logger?.info(
                `[integrations] ${connector.label} -> ${
                    snapshot.status.online ? "online" : "offline"
                }`
            );

        }

        return snapshot;

    }

    /** Snapshot tanpa memicu probe baru — murah, aman dipanggil sering. */
    snapshot() {

        return this.list().map(connector => connector.toJSON());

    }

    summary() {

        const items = this.snapshot();

        const enabled = items.filter(i => i.enabled);

        return {
            total: items.length,
            enabled: enabled.length,
            online: enabled.filter(i => i.status.online).length,
            offline: enabled.filter(i => !i.status.online).length
        };

    }

    startPolling() {

        if (this.timer) {
            return this;
        }

        // Probe pertama langsung, jangan tunggu satu interval.
        this.checkAll().catch(() => {});

        this.timer = setInterval(() => {
            this.checkAll().catch(() => {});
        }, this.pollInterval);

        this.timer.unref?.();

        return this;

    }

    stopPolling() {

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        return this;

    }

}

module.exports = IntegrationManager;
