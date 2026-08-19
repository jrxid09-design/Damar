const BaseConnector = require("../BaseConnector");

const NDJSONParser = require("../../core/http/NDJSONParser");

/**
 * Konektor untuk daemon Ollama — sumber AI lokal Aether.
 *
 * Berbagi endpoint yang sama dengan OllamaProvider, tetapi
 * dipakai untuk keperluan monitoring/manajemen (status, daftar
 * model, model yang sedang dimuat, unduh model), bukan inferensi.
 */
class OllamaConnector extends BaseConnector {

    constructor(options = {}) {

        super({
            kind: "runtime",
            label: "Ollama (Local AI)",
            baseUrl: "http://localhost:11434",
            ...options,
            id: options.id ?? "ollama"
        });

    }

    async probe() {

        const started = Date.now();

        const response = await this.httpClient.get(
            this.url("/api/version"),
            {
                headers: this.requestHeaders(),
                timeout: this.timeout
            }
        );

        if (!response.success) {

            return {
                online: false,
                latency: Date.now() - started,
                error: response.error ?? response.statusText ?? "unreachable"
            };

        }

        // Daftar model dipakai sebagai indikator "siap dipakai":
        // daemon hidup tapi tanpa model berarti belum bisa apa-apa.
        const [installed, loaded] = await Promise.all([
            this.safeGet("/api/tags"),
            this.safeGet("/api/ps")
        ]);

        return {

            online: true,

            latency: Date.now() - started,

            version: response.data?.version ?? null,

            detail: {

                version: response.data?.version ?? null,

                modelCount: installed?.models?.length ?? 0,

                loadedCount: loaded?.models?.length ?? 0,

                loadedModels:
                    (loaded?.models ?? []).map(m => m.name ?? m.model),

                ready: (installed?.models?.length ?? 0) > 0

            }

        };

    }

    async safeGet(path) {

        const response = await this.httpClient.get(this.url(path), {
            headers: this.requestHeaders(),
            timeout: this.timeout
        });

        return response.success ? response.data : null;

    }

    async listModels() {

        const data = await this.safeGet("/api/tags");

        return (data?.models ?? []).map(model => ({

            id: model.name ?? model.model,

            name: model.name ?? model.model,

            size: model.size ?? null,

            family: model.details?.family ?? null,

            parameterSize: model.details?.parameter_size ?? null,

            quantization: model.details?.quantization_level ?? null,

            modifiedAt: model.modified_at ?? null

        }));

    }

    async listLoadedModels() {

        const data = await this.safeGet("/api/ps");

        return (data?.models ?? []).map(model => ({

            id: model.name ?? model.model,

            name: model.name ?? model.model,

            sizeVram: model.size_vram ?? 0,

            expiresAt: model.expires_at ?? null

        }));

    }

    /** Unduh model; menghasilkan progress NDJSON bertahap. */
    async *pullModel(model) {

        const stream = await this.httpClient.stream(
            this.url("/api/pull"),
            {
                headers: this.requestHeaders(),
                body: { model, stream: true },
                timeout: 1000 * 60 * 60
            }
        );

        yield* NDJSONParser.parse(stream);

    }

}

module.exports = OllamaConnector;
