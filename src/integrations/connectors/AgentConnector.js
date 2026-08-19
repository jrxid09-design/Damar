const BaseConnector = require("../BaseConnector");

/**
 * Konektor generik untuk agent eksternal berbasis HTTP.
 *
 * Endpoint tiap agent berbeda-beda dan bisa berubah antar versi,
 * jadi alih-alih mengunci satu path, konektor ini mencoba
 * beberapa kandidat health path lalu MENGINGAT mana yang berhasil.
 * Path hasil temuan dilaporkan ke UI sehingga bisa dikunci lewat
 * konfigurasi bila sudah pasti.
 */
class AgentConnector extends BaseConnector {

    constructor(options = {}) {

        super({
            kind: "agent",
            ...options
        });

        /** Kandidat path health, terurut dari yang paling spesifik. */
        this.healthCandidates =
            options.healthCandidates ?? [
                "/health",
                "/healthz",
                "/api/health",
                "/status",
                "/api/status",
                "/"
            ];

        // Path yang dikonfigurasi eksplisit selalu dicoba pertama.
        if (this.paths.health) {
            this.healthCandidates = [
                this.paths.health,
                ...this.healthCandidates.filter(p => p !== this.paths.health)
            ];
        }

        /** Diisi setelah probe pertama yang berhasil. */
        this.resolvedHealthPath = null;

        /** Diisi setelah task pertama yang berhasil (auto-discovery). */
        this.resolvedChatPath = null;

        /** Kandidat endpoint TASK — beda agent beda API (OpenClaw ≠ chat-LLM). */
        this.chatCandidates = options.chatCandidates ?? [
            "/v1/chat/completions", "/api/chat", "/chat",
            "/api/run", "/run", "/api/task", "/api/execute", "/execute"
        ];

    }

    async probe() {

        const candidates = this.resolvedHealthPath
            ? [this.resolvedHealthPath]
            : this.healthCandidates;

        let lastError = "unreachable";

        for (const path of candidates) {

            const started = Date.now();

            const response = await this.httpClient.get(this.url(path), {
                headers: this.requestHeaders(),
                timeout: this.timeout
            });

            if (response.success) {

                this.resolvedHealthPath = path;

                return {

                    online: true,

                    latency: Date.now() - started,

                    version: this.readVersion(response.data),

                    detail: {

                        healthPath: path,

                        payload:
                            typeof response.data === "object" && response.data !== null
                                ? response.data
                                : { raw: String(response.data ?? "").slice(0, 200) }

                    }

                };

            }

            lastError =
                response.error ??
                response.statusText ??
                `HTTP ${response.status}`;

            // 401/403 berarti servicenya HIDUP, hanya butuh kredensial.
            if (response.status === 401 || response.status === 403) {

                this.resolvedHealthPath = path;

                return {
                    online: true,
                    latency: Date.now() - started,
                    detail: {
                        healthPath: path,
                        authRequired: true
                    },
                    error: "authentication required"
                };

            }

        }

        return {
            online: false,
            latency: null,
            error: lastError,
            detail: {
                triedPaths: candidates
            }
        };

    }

    readVersion(data) {

        if (!data || typeof data !== "object") {
            return null;
        }

        return data.version ?? data.build ?? data.commit ?? null;

    }

    /**
     * Kirim tugas ke agent. Endpoint & bentuk body BERBEDA tiap agent:
     * server chat-LLM pakai {messages}, sementara agent otomasi (OpenClaw)
     * biasanya pakai {instruction|prompt|task}. Karena itu:
     *   - path task: coba yang dikonfigurasi (paths.chat) dulu, lalu kandidat
     *     umum, dan INGAT yang berhasil (seperti health).
     *   - body: bila metadata.taskField diisi (mis. "instruction"), kirim
     *     { [taskField]: teks }; kalau tidak, pakai gaya OpenAI {messages}.
     * Error menyertakan METHOD + URL + STATUS supaya 404 mudah didiagnosis.
     */
    async chat({ messages, model = null, ...rest }) {

        const text = Array.isArray(messages)
            ? messages.map(m => m?.content ?? "").filter(Boolean).join("\n")
            : String(messages ?? "");

        const taskField = this.metadata.taskField ?? null;
        const buildBody = () => taskField
            ? { [taskField]: text, ...rest }
            : { model: model ?? this.metadata.defaultModel ?? undefined, messages, ...rest };

        const candidates = this.resolvedChatPath
            ? [this.resolvedChatPath]
            : [this.paths.chat, ...this.chatCandidates].filter(Boolean);

        let last = { url: null, status: null, error: "unreachable" };

        for (const path of candidates) {

            const url = this.url(path);

            const response = await this.httpClient.post(url, {
                headers: this.requestHeaders(),
                body: buildBody(),
                timeout: this.metadata.chatTimeout ?? 120000
            });

            if (response.success) {
                this.resolvedChatPath = path;   // ingat endpoint yang benar
                return response.data;
            }

            last = {
                url,
                status: response.status ?? null,
                error: response.data?.error?.message ?? response.error ?? response.statusText ?? "gagal"
            };

            // 404/405 = path salah → coba kandidat berikutnya. Selain itu
            // (401/403/5xx/timeout) servicenya ada tapi menolak → berhenti.
            if (response.status !== 404 && response.status !== 405) break;
        }

        throw new Error(
            `${this.label}: POST ${last.url} → ${last.status ?? "?"} (${last.error}). ` +
            `Endpoint task ${this.label} kemungkinan berbeda. Atur "paths.chat" dan (bila perlu) ` +
            `"metadata.taskField" di configs/integrations.json sesuai API ${this.label}.`
        );

    }

}

module.exports = AgentConnector;
