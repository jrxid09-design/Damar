class EventSubscription {

    constructor(bus, eventName, listener) {

        this.bus = bus;

        this.eventName = eventName;

        this.listener = listener;

    }

    unsubscribe() {

        this.bus.off(

            this.eventName,

            this.listener

        );

    }

}

module.exports = EventSubscription;