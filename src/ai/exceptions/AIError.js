class AIError extends Error {

    constructor(message = "AI Error") {

        super(message);

        this.name = this.constructor.name;

        Error.captureStackTrace?.(
            this,
            this.constructor
        );

    }

}

module.exports = AIError;