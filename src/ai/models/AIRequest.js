class AIRequest {

    constructor({

        model,

        messages = [],

        temperature = 0.7,

        maxTokens = null,

        stream = false,

        tools = [],

        toolChoice = undefined,

        metadata = {}

    } = {}) {

        this.model = model;
        this.messages = messages;
        this.temperature = temperature;
        this.maxTokens = maxTokens;
        this.stream = stream;
        this.tools = tools;
        this.toolChoice = toolChoice;
        this.metadata = metadata;

    }

}

module.exports = AIRequest;