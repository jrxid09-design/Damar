class EventListener {

    constructor(callback, options = {}) {

        this.callback = callback;

        this.once = options.once ?? false;

        this.enabled = options.enabled ?? true;

        this.priority = options.priority ?? 0;

    }

    async execute(event) {

        if (!this.enabled) {
            return;
        }

        return await this.callback(event);

    }

}

module.exports = EventListener;