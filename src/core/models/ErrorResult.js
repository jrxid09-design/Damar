const Result = require("./Result");

class ErrorResult extends Result {

    constructor(error) {
        super(false, null, error);
    }

}

module.exports = ErrorResult;