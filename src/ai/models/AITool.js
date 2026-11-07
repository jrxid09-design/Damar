class AITool {

    constructor({

        name,

        description = "",

        parameters = {},

        execute

    }) {

        if (!name) {

            throw new Error("Tool name is required.");

        }

        if (typeof execute !== "function") {

            throw new Error("Tool execute must be a function.");

        }

        this.name = name;

        this.description = description;

        this.parameters = parameters;

        this.execute = execute;

    }

}

module.exports = AITool;