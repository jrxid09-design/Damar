class AIResponse {

    constructor({

        id = null,

        model = null,

        provider = null,

        role = "assistant",

        content = "",

        finishReason = null,

        usage = {

            promptTokens: 0,

            completionTokens: 0,

            totalTokens: 0,

            reasoningTokens: 0

        },

        toolCalls = [],

        reasoning = null,

        metadata = {},

        raw = null

    } = {}) {

        this.id = id;

        this.model = model;

        this.provider = provider;

        this.role = role;

        this.content = content;

        this.finishReason = finishReason;

        this.usage = usage;

        this.toolCalls = toolCalls;

        this.reasoning = reasoning;

        this.metadata = metadata;

        this.raw = raw;

    }

}

module.exports = AIResponse;