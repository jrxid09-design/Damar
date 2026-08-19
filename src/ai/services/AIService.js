const BaseService = require("../../core/services/BaseService");

class AIService extends BaseService {

    constructor(provider = null) {

        super();

        this.provider = provider;

    }

    setProvider(provider) {

        this.provider = provider;

        return this;

    }

    getProvider() {

        return this.provider;

    }

    async chat(request) {

        if (!this.provider) {
            throw new Error("AI Provider has not been configured.");
        }

        return this.provider.chat(request);

    }

    async *stream(request) {

        if (!this.provider) {
            throw new Error("AI Provider has not been configured.");
        }

        yield* this.provider.stream(request);

    }

}

module.exports = AIService;