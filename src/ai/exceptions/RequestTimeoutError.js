const AIError = require("./AIError");

class RequestTimeoutError extends AIError {

    constructor(timeout) {

        super(
            `Request timed out after ${timeout} ms.`
        );

        this.timeout = timeout;

    }

}

module.exports = RequestTimeoutError;