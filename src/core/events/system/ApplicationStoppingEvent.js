const { BaseEvent } = require("..");

class ApplicationStoppingEvent extends BaseEvent {

    constructor() {

        super(

            "application.stopping"

        );

    }

}

module.exports = ApplicationStoppingEvent;