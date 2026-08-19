class BaseLifecycle {

    constructor() {

        this.initialized = false;
        this.started = false;
        this.disposed = false;

    }

    async initialize(context) {

        this.initialized = true;

    }

    async start(context) {

        this.started = true;

    }

    async stop(context) {

        this.started = false;

    }

    async dispose(context) {

        this.disposed = true;

    }

}

module.exports = BaseLifecycle;