const BaseEvent = require("./BaseEvent");
const EventListener = require("./EventListener");
const EventSubscription = require("./EventSubscription");

class EventBus {

    constructor() {

        this.listeners = new Map();

    }

    on(eventName, callback, options = {}) {

        const listener =

            callback instanceof EventListener

                ? callback

                : new EventListener(

                    callback,

                    options

                );

        if (!this.listeners.has(eventName)) {

            this.listeners.set(

                eventName,

                []

            );

        }

        const listeners =

            this.listeners.get(eventName);

        listeners.push(listener);

        listeners.sort(

            (a, b) =>

                b.priority - a.priority

        );

        return new EventSubscription(

            this,

            eventName,

            listener

        );

    }

    once(eventName, callback, options = {}) {

        return this.on(

            eventName,

            callback,

            {

                ...options,

                once: true

            }

        );

    }

    off(eventName, listener) {

        const listeners =

            this.listeners.get(eventName);

        if (!listeners) {

            return false;

        }

        const index =

            listeners.indexOf(listener);

        if (index === -1) {

            return false;

        }

        listeners.splice(index, 1);

        if (listeners.length === 0) {

            this.listeners.delete(eventName);

        }

        return true;

    }

    async emit(event, payload = {}, metadata = {}) {

        const evt =

            event instanceof BaseEvent

                ? event

                : new BaseEvent(

                    event,

                    payload,

                    metadata

                );

        const listeners =

            this.listeners.get(evt.name);

        if (!listeners) {

            return evt;

        }

        for (const listener of [...listeners]) {

            await listener.execute(evt);

            if (listener.once) {

                this.off(

                    evt.name,

                    listener

                );

            }

        }

        return evt;

    }

    has(eventName) {

        return this.listeners.has(eventName);

    }

    listenerCount(eventName) {

        return (

            this.listeners.get(eventName)?.length

            ?? 0

        );

    }

    eventNames() {

        return Array.from(

            this.listeners.keys()

        );

    }

    clear(eventName = null) {

        if (eventName) {

            this.listeners.delete(eventName);

            return;

        }

        this.listeners.clear();

    }

}

module.exports = new EventBus();