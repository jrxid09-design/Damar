class BaseEvent {

    constructor(name, payload = {}, metadata = {}) {

        this.name = name;

        this.payload = payload;

        this.metadata = {

            timestamp: new Date(),

            ...metadata

        };

    }

}

module.exports = BaseEvent;