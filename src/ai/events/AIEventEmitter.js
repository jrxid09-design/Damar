const EventEmitter = require("events");

class AIEventEmitter extends EventEmitter {

    emitAsync(event, payload) {

        this.emit(event, payload);

    }

}

module.exports = AIEventEmitter;