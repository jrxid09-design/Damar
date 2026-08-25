const {
    BaseEvent
} = require("../../core/events");

class AIRequestCompletedEvent extends BaseEvent {

    constructor(payload = {}) {

        super(
            "ai.request.completed",
            payload
        );

    }

}

module.exports = AIRequestCompletedEvent;