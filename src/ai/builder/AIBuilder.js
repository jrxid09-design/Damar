const HttpClient = require("../../plugins/http/services/HttpClient");

const AIEngine = require("../engine/AIEngine");

const AIRuntime = require("../runtime/AIRuntime");

const RuntimeOptions = require("../runtime/RuntimeOptions");

const { AIToolRegistry } = require("../tools");

const { AIProviderFactory } = require("../providers");

/**
 * Builder untuk merakit AIEngine.
 *
 * Beberapa provider boleh didaftarkan sekaligus supaya Aether
 * Console bisa berpindah antara AI lokal (Ollama) dan cloud
 * (OpenRouter) saat runtime tanpa merakit ulang engine.
 */
class AIBuilder {

    constructor() {

        this.httpClient = null;

        this.context = null;

        /** @type {Map<string, object>} */
        this.providers = new Map();

        this.activeProviderId = null;

        this._defaultModel = null;

        this._options = {};

        this.toolRegistry = new AIToolRegistry();

        this.middlewares = [];

    }

    withHttpClient(httpClient) {

        this.httpClient = httpClient;

        return this;

    }

    withContext(context) {

        this.context = context;

        return this;

    }

    /**
     * Daftarkan provider apa pun berdasarkan id.
     * Provider pertama yang didaftarkan menjadi yang aktif.
     */
    provider(id, options = {}) {

        const key = String(id).toLowerCase();

        this.providers.set(key, options);

        if (!this.activeProviderId) {
            this.activeProviderId = key;
        }

        return this;

    }

    openRouter(options = {}) {

        return this.provider("openrouter", options);

    }

    ollama(options = {}) {

        return this.provider("ollama", options);

    }

    /** Tentukan provider mana yang dipakai saat engine dibangun. */
    use(id) {

        this.activeProviderId = String(id).toLowerCase();

        return this;

    }

    defaultModel(model) {

        this._defaultModel = model;

        return this;

    }

    timeout(ms) {

        this._options.timeout = ms;

        return this;

    }

    retry(retry) {

        this._options.retry = retry;

        return this;

    }

    maxToolIterations(count) {

        this._options.maxToolIterations = count;

        return this;

    }

    registerTool(tool) {

        this.toolRegistry.register(tool);

        return this;

    }

    registerTools(tools = []) {

        for (const tool of tools) {
            this.toolRegistry.register(tool);
        }

        return this;

    }

    useMiddleware(middleware) {

        this.middlewares.push(middleware);

        return this;

    }

    build() {

        if (this.providers.size === 0) {

            throw new Error(
                "No AI provider has been configured."
            );

        }

        const httpClient = this.httpClient || HttpClient;

        const options = new RuntimeOptions(this._options);

        if (this._options.maxToolIterations != null) {
            options.maxToolIterations = this._options.maxToolIterations;
        }

        const runtime = new AIRuntime(this.context, options);

        const engine = new AIEngine(runtime);

        for (const [id, providerOptions] of this.providers) {

            const provider = AIProviderFactory.create(id, {
                ...providerOptions,
                httpClient
            });

            engine.registerProvider(id, provider);

        }

        engine.use(
            this.activeProviderId ?? [...this.providers.keys()][0]
        );

        if (this._defaultModel) {
            runtime.setDefaultModel(this._defaultModel);
        }

        runtime.setToolRegistry(this.toolRegistry);

        for (const middleware of this.middlewares) {
            runtime.useMiddleware(middleware);
        }

        return engine;

    }

}

module.exports = AIBuilder;
