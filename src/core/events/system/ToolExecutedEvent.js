const { BaseEvent } = require("..");

class ToolExecutedEvent extends BaseEvent {

    constructor(tool, args, result) {

        super(

            "tool.executed",

            {

                tool,

                args,

                result

            }

        );

    }

}

module.exports = ToolExecutedEvent;