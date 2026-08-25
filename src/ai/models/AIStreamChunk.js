class AIStreamChunk {

    constructor({

        id = null,

        model = null,

        provider = null,

        role = "assistant",

        delta = "",

        reasoning = null,

        toolCalls = [],

        usage = null,

        finishReason = null,

        done = false,

        raw = null

    } = {}) {

        this.id = id;

        this.model = model;

        this.provider = provider;

        this.role = role;

        this.delta = delta;

        this.reasoning = reasoning;

        this.finishReason = finishReason;

        this.done = done;

        this.raw = raw;

        this.usage = usage;
        this.toolCalls = toolCalls;

    }

}

module.exports = AIStreamChunk;