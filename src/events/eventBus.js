const EventEmitter = require("events");

class EventBus extends EventEmitter {

    emitAsync(event, payload) {

        const listeners = this.listeners(event);

        return Promise.all(
            listeners.map(listener => listener(payload))
        );

    }

}

module.exports = new EventBus();