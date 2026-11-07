const {
    BaseEvent
} = require("../../core/events");

class AIRequestStartedEvent extends BaseEvent {

    constructor(payload = {}) {

        super(
            "ai.request.started",
            payload
        );

    }

}

module.exports = AIRequestStartedEvent;