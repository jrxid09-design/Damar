const {
    BaseEvent
} = require("../../core/events");

class AIRequestFailedEvent extends BaseEvent {

    constructor(payload = {}) {

        super(
            "ai.request.failed",
            payload
        );

    }

}

module.exports = AIRequestFailedEvent;