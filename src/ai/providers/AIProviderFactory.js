const AIProviderConfig = require("./AIProviderConfig");

const {
    OpenRouterProvider,
    OpenRouterClient,
    OpenRouterMapper
} = require("./openrouter");

const {
    OllamaProvider,
    OllamaClient,
    OllamaMapper
} = require("./ollama");

const { LlamaCppProvider } = require("./llamacpp");

class AIProviderFactory {

    static create(type, options = {}) {

        switch (type.toLowerCase()) {

            case "openrouter":
                return this.createOpenRouter(options);

            // Semua platform OpenAI-compatible (OpenAI, Google AI
            // Studio, Groq, 9router, custom, ...) memakai jalur yang
            // sama — hanya baseUrl + key yang berbeda.
            case "openai":
            case "openai-compatible":
                return this.createOpenAICompatible(options);

            case "ollama":
                return this.createOllama(options);

            // Otak lokal in-process (node-llama-cpp) — pengganti Ollama.
            case "llamacpp":
            case "local":
                return this.createLlamaCpp(options);

            default:
                throw new Error(
                    `Unsupported AI provider "${type}".`
                );

        }

    }

    static createOpenAICompatible(options = {}) {

        const config = new AIProviderConfig({

            apiKey: options.apiKey,

            baseUrl: options.baseUrl,

            timeout: options.timeout,

            headers: options.headers

        });

        return new OpenRouterProvider({

            httpClient: options.httpClient,

            config,

            // Label/id platform untuk pelaporan (mis. "google").
            providerId: options.providerId ?? "openai"

        });

    }

    static createOpenRouter(options = {}) {

    const config = new AIProviderConfig({

        apiKey: options.apiKey,

        baseUrl: options.baseUrl ??
            "https://openrouter.ai/api/v1",

        timeout: options.timeout,

        headers: options.headers

    });

    return new OpenRouterProvider({

        httpClient: options.httpClient,

        config

    });

}

    static createOllama(options = {}) {

        const config = new AIProviderConfig({

            baseUrl:
                options.baseUrl ??
                "http://localhost:11434",

            timeout:
                options.timeout,

            headers:
                options.headers

        });

        const mapper = new OllamaMapper();

        const client = new OllamaClient({

            httpClient: options.httpClient,

            config

        });

        return new OllamaProvider({

            client,

            mapper,

            defaultOptions: options.defaultOptions,

            keepAlive: options.keepAlive

        });

    }

    static createLlamaCpp(options = {}) {

        return new LlamaCppProvider({

            context: options.context,

            modelPath: options.modelPath,

            contextSize: options.contextSize,

            gpuLayers: options.gpuLayers

        });

    }

}

module.exports = AIProviderFactory;