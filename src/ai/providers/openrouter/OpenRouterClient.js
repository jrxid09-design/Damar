const SSEParser = require("../../../core/http/SSEParser");

class OpenRouterClient {

    constructor({

        httpClient,

        config

    } = {}) {

        if (!httpClient) {
            throw new Error("HttpClient is required.");
        }

        if (!config) {
            throw new Error("AIProviderConfig is required.");
        }

        this.httpClient = httpClient;
        this.config = config;

    }

    async chat(payload) {

        const url = `${this.config.baseUrl}/chat/completions`;

        const response = await this.httpClient.post(

            url,

            {

                headers: {

                    Authorization: `Bearer ${this.config.apiKey}`

                },

                body: payload,

                // Non-stream MENUNGGU seluruh jawaban selesai. Default 30 dtk
                // terlalu pendek: model reasoning + prompt besar bisa 30-90
                // dtk -> "This operation was aborted" (kerap di WhatsApp/
                // Telegram yang memakai jalur ini).
                timeout: 120000

            }

        );

        if (!response.success) {

            // Sertakan status HTTP pada error agar runtime bisa
            // bereaksi (mis. 404 model usang → fallback otomatis).
            const error = new Error(
                response.data?.error?.message ??
                response.error ??
                response.statusText ??
                "OpenRouter request failed."
            );
            error.status = response.status ?? null;
            throw error;

        }

        return response.data;

    }

    async *stream(payload) {

        const url = `${this.config.baseUrl}/chat/completions`;

        const stream = await this.httpClient.stream(

            url,

            {

                headers: {

                    Authorization: `Bearer ${this.config.apiKey}`

                },

                body: payload,

                // Batas ini hanya untuk WAKTU-KE-BYTE-PERTAMA (header),
                // lalu di-clear begitu respons tiba — tak membatasi durasi
                // stream. Default 30 dtk terlalu pendek: model reasoning
                // (mis. glm-5.2) dengan prompt besar butuh ~30-40 dtk
                // sampai token pertama, sehingga stream ter-abort dengan
                // "This operation was aborted" dan Damar tampak diam.
                timeout: 120000

            }

        );

        yield* SSEParser.parse(stream);

    }

    async models() {

        const response = await this.httpClient.get(
            `${this.config.baseUrl}/models`,
            {
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`
                },
                timeout: this.config.timeout
            }
        );

        if (!response.success) {

            throw new Error(
                response.data?.error?.message ??
                response.error ??
                "Failed to list OpenRouter models."
            );

        }

        return response.data?.data ?? [];

    }

    /**
     * Tanpa API key, endpoint /models tetap balas 200 sehingga
     * cocok dipakai sebagai probe konektivitas murni.
     */
    async health() {

        const started = Date.now();

        const response = await this.httpClient.get(
            `${this.config.baseUrl}/models`,
            {
                headers: this.config.apiKey
                    ? { Authorization: `Bearer ${this.config.apiKey}` }
                    : {},
                timeout: 8000
            }
        );

        return {
            online: response.success === true,
            latency: Date.now() - started,
            authenticated: Boolean(this.config.apiKey),
            error: response.success
                ? null
                : (response.error ?? response.statusText ?? "unreachable")
        };

    }

}

module.exports = OpenRouterClient;