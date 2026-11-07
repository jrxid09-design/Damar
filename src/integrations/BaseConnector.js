const HttpClient = require("../plugins/http/services/HttpClient");

/**
 * Kontrak dasar untuk semua sistem eksternal yang disambungkan
 * ke Damar (runtime AI lokal, gateway agen, dst).
 *
 * Yang wajib disediakan turunan hanyalah `probe()`. Sisanya
 * opsional dan otomatis dilaporkan sebagai kapabilitas yang
 * tidak tersedia bila tidak diimplementasikan.
 */
class BaseConnector {

    /**
     * @param {object} options
     * @param {string} options.id      identitas unik
     * @param {string} options.label   nama tampilan di UI
     * @param {string} options.kind    "runtime" | "agent" | "service"
     * @param {string} options.baseUrl root HTTP instance
     */
    constructor({
        id,
        label = null,
        kind = "service",
        baseUrl = null,
        apiKey = null,
        enabled = true,
        timeout = 8000,
        headers = {},
        paths = {},
        metadata = {},
        httpClient = HttpClient
    } = {}) {

        if (!id) {
            throw new Error("Connector id is required.");
        }

        this.id = id;

        this.label = label ?? id;

        this.kind = kind;

        this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, "") : null;

        this.apiKey = apiKey;

        this.enabled = enabled;

        this.timeout = timeout;

        this.headers = headers;

        this.paths = paths;

        this.metadata = metadata;

        this.httpClient = httpClient;

        /** Snapshot status terakhir, dipakai UI saat probe belum selesai. */
        this.lastStatus = {
            online: false,
            latency: null,
            checkedAt: null,
            error: enabled ? "not checked yet" : "disabled",
            detail: {}
        };

    }

    url(path = "") {

        return `${this.baseUrl}${path}`;

    }

    requestHeaders() {

        const headers = { ...this.headers };

        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }

        return headers;

    }

    /**
     * Kapabilitas apa yang ditawarkan konektor ini. Dipakai UI
     * untuk memutuskan tombol mana yang aktif.
     */
    capabilities() {

        return {
            chat: typeof this.chat === "function",
            stream: typeof this.stream === "function",
            models: typeof this.listModels === "function",
            tools: typeof this.listTools === "function"
        };

    }

    /**
     * Harus mengembalikan { online, latency, version?, detail? }
     * dan TIDAK boleh melempar — status "mati" adalah hasil yang
     * sah, bukan kegagalan.
     */
    async probe() {

        throw new Error(
            `${this.constructor.name} must implement probe().`
        );

    }

    /** Probe generik: GET pada path health, cukup untuk sebagian besar service. */
    async probeHttp(path = this.paths.health ?? "/health") {

        const started = Date.now();

        if (!this.baseUrl) {

            return {
                online: false,
                latency: null,
                error: "baseUrl is not configured"
            };

        }

        const response = await this.httpClient.get(this.url(path), {
            headers: this.requestHeaders(),
            timeout: this.timeout
        });

        return {

            online: response.success === true,

            latency: Date.now() - started,

            status: response.status ?? null,

            detail:
                typeof response.data === "object" && response.data !== null
                    ? response.data
                    : {},

            error: response.success
                ? null
                : (response.error ?? response.statusText ?? `HTTP ${response.status}`)

        };

    }

    /** Jalankan probe dan simpan hasilnya sebagai lastStatus. */
    async check() {

        if (!this.enabled) {

            this.lastStatus = {
                online: false,
                latency: null,
                checkedAt: new Date().toISOString(),
                error: "disabled",
                detail: {}
            };

            return this.toJSON();

        }

        try {

            const result = await this.probe();

            this.lastStatus = {
                online: false,
                latency: null,
                detail: {},
                error: null,
                ...result,
                checkedAt: new Date().toISOString()
            };

        }

        catch (error) {

            this.lastStatus = {
                online: false,
                latency: null,
                detail: {},
                error: error.message,
                checkedAt: new Date().toISOString()
            };

        }

        return this.toJSON();

    }

    toJSON() {

        return {

            id: this.id,

            label: this.label,

            kind: this.kind,

            baseUrl: this.baseUrl,

            enabled: this.enabled,

            capabilities: this.capabilities(),

            status: this.lastStatus,

            metadata: this.metadata

        };

    }

}

module.exports = BaseConnector;
