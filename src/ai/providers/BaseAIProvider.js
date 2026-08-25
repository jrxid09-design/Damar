const BaseProvider = require("../../core/providers/BaseProvider");

class BaseAIProvider extends BaseProvider {

    constructor(context) {

        super();

        this.context = context;

    }

    /**
     * Send a chat request.
     *
     * @param {AIRequest} request
     * @returns {Promise<AIResponse>}
     */
    async chat(request) {

        throw new Error(
            `${this.constructor.name} must implement chat().`
        );

    }

    /**
     * Stream chat response.
     *
     * @param {AIRequest} request
     * @returns {AsyncGenerator<AIStreamChunk>}
     */
    async *stream(request) {

        throw new Error(
            `${this.constructor.name} must implement stream().`
        );

    }

}

module.exports = BaseAIProvider;