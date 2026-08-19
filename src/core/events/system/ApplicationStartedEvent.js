const { BaseEvent } = require("..");

class ApplicationStartedEvent extends BaseEvent {

    constructor() {

        super(

            "application.started"

        );

    }

}

module.exports = ApplicationStartedEvent;