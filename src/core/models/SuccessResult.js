const Result = require("./Result");

class SuccessResult extends Result {

    constructor(data = null) {
        super(true, data, null);
    }

}

module.exports = SuccessResult;