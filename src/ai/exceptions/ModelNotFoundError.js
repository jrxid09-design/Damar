const AIError = require("./AIError");

class ModelNotFoundError extends AIError {

    constructor(model) {

        super(
            `Model '${model}' was not found.`
        );

        this.model = model;

    }

}

module.exports = ModelNotFoundError;