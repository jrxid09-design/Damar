const Result = require("../models/Result");

class ToolResult extends Result {

    constructor(success, data, error, metadata = {}) {

        super(success, data, error);

        this.metadata = metadata;

    }

    static ok(data, metadata = {}) {

        return new ToolResult(

            true,

            data,

            null,

            metadata

        );

    }

    static fail(error, metadata = {}) {

        return new ToolResult(

            false,

            null,

            error,

            metadata

        );

    }

}

module.exports = ToolResult;