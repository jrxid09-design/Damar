class AIContext {

    constructor({
        application = null,
        logger = null,
        config = null,
        cache = null,
        container = null,
        eventBus = null,
        toolRegistry = null,
        pluginRegistry = null
    } = {}) {

        this.application = application;
        this.logger = logger;
        this.config = config;
        this.cache = cache;
        this.container = container;
        this.eventBus = eventBus;
        this.toolRegistry = toolRegistry;
        this.pluginRegistry = pluginRegistry;

    }

    resolve(service) {

        if (!this.container) {
            throw new Error("ServiceContainer is not available.");
        }

        return this.container.resolve(service);

    }

    getTool(id) {

        if (!this.toolRegistry) {
            return null;
        }

        return this.toolRegistry.get(id);

    }

    getPlugin(id) {

        if (!this.pluginRegistry) {
            return null;
        }

        return this.pluginRegistry.get(id);

    }

    emit(event) {

        if (!this.eventBus) {
            return;
        }

        return this.eventBus.emit(event);

    }

}

module.exports = AIContext;