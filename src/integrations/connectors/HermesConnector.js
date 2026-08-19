const AgentConnector = require("./AgentConnector");

/**
 * Konektor untuk hermes-agent (Nous Research) — DIREVERSE dari source
 * terpasang (hermes_agent 0.19.x).
 *
 * Hermes API server (gateway/platforms/api_server.py, aiohttp) MEMANG
 * OpenAI-compatible, jadi AgentConnector.chat() (POST /v1/chat/completions,
 * Bearer) sudah cocok. Yang penting:
 *   - Port API server default = 8642 (env API_SERVER_PORT). CATATAN: 9119
 *     itu web/dashboard (`hermes serve`), BUKAN API server — arahkan Aether
 *     ke port API server.
 *   - Auth = "Authorization: Bearer <API_SERVER_KEY>" (isi sebagai apiKey /
 *     AETHER_HERMES_KEY). API server menolak start tanpa API_SERVER_KEY.
 *   - Endpoint: /v1/chat/completions (chat) + /v1/runs (agent run) +
 *     /api/sessions/*. Health: /health atau /v1/health.
 */
class HermesConnector extends AgentConnector {

    constructor(options = {}) {

        super({
            label: "Hermes Agent",
            baseUrl: "http://127.0.0.1:8642",
            ...options,
            id: options.id ?? "hermes",
            healthCandidates: options.healthCandidates ?? [
                "/health",
                "/v1/health",
                "/health/detailed",
                "/v1/models",
                "/"
            ],
            chatCandidates: options.chatCandidates ?? ["/v1/chat/completions"]
        });

        // API server Hermes memakai model id "hermes-agent".
        this.metadata.defaultModel = this.metadata.defaultModel ?? "hermes-agent";
    }

    async listModels() {

        const path = this.paths.models ?? "/v1/models";

        const response = await this.httpClient.get(this.url(path), {
            headers: this.requestHeaders(),
            timeout: this.timeout
        });

        if (!response.success) {
            return [];
        }

        const data = response.data;

        const models = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);

        return models.map(model => ({
            id: model.id ?? model.name,
            name: model.name ?? model.id
        }));

    }

}

module.exports = HermesConnector;
