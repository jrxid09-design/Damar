class AIToolResult {

    constructor({

        toolCallId,

        name,

        result

    }) {

        this.toolCallId = toolCallId;
        this.name = name;
        this.result = result;

    }

}

module.exports = AIToolResult;