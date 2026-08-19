const AIRuntime = require("../runtime/AIRuntime");

class AIEngine {

    constructor(runtime = new AIRuntime()) {

        this.runtime = runtime;

    }

    registerProvider(id, provider) {

        this.runtime.registerProvider(id, provider);

        return this;

    }

    use(id) {

        this.runtime.use(id);

        return this;

    }

    get activeProviderId() {

        return this.runtime.currentProviderId;

    }

    getProvider(id = this.runtime.currentProviderId) {

        return this.runtime.getProvider(id);

    }

    listProviders() {

        return this.runtime.listProviders().map(({ id }) => id);

    }

    async chat(request) {

        return this.runtime.chat(request);

    }

    async *stream(request) {

        yield* this.runtime.stream(request);

    }

    /**
     * Status satu provider. Provider yang tidak mengimplementasikan
     * health() dianggap online tanpa detail, bukan error.
     */
    async health(id = this.runtime.currentProviderId) {

        const provider = this.getProvider(id);

        if (!provider) {
            return { id, online: false, error: "provider not registered" };
        }

        if (typeof provider.health !== "function") {
            return { id, online: true, error: null };
        }

        try {
            return { id, ...(await provider.health()) };
        }
        catch (error) {
            return { id, online: false, error: error.message };
        }

    }

    async healthAll() {

        return Promise.all(
            this.listProviders().map(id => this.health(id))
        );

    }

    async listModels(id = this.runtime.currentProviderId) {

        const provider = this.getProvider(id);

        if (!provider || typeof provider.listModels !== "function") {
            return [];
        }

        return provider.listModels();

    }

    getMetrics() {

        return this.runtime.metrics.toJSON();

    }

    getToolRegistry() {

        return this.runtime.getToolRegistry();

    }

    getEventEmitter() {

        return this.runtime.getEventEmitter();

    }

}

module.exports = AIEngine;
