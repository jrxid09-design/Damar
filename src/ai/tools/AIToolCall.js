class AIToolCall {

    constructor({

        id,

        name,

        arguments: args = {}

    }) {

        this.id = id;

        this.name = name;

        this.arguments = args;

    }

}

module.exports = AIToolCall;