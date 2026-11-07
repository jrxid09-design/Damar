const ApplicationContext =
    require("./ApplicationContext");

const ApplicationState =
    require("./ApplicationState");

const {
    EventBus
} = require("../events");

const {
    LifecycleManager
} = require("../lifecycle");

class Application {

    constructor(services = {}) {

        this.state =
            ApplicationState.CREATED;

        this.context =
            new ApplicationContext({

                ...services,

                eventBus: EventBus

            });

    }

    async initialize() {

        if (
            this.state !==
            ApplicationState.CREATED
        ) {

            return;

        }

        this.state =
            ApplicationState.INITIALIZING;

        await LifecycleManager.initialize(

            this.context,

            this.context

        );

        this.state =
            ApplicationState.INITIALIZED;

    }

    async start() {

        if (

            this.state !==

            ApplicationState.INITIALIZED

        ) {

            return;

        }

        this.state =
            ApplicationState.STARTING;

        await LifecycleManager.start(

            this.context,

            this.context

        );

        await EventBus.emit(

            "application.started"

        );

        this.state =
            ApplicationState.RUNNING;

    }

    async stop() {

        if (

            this.state !==

            ApplicationState.RUNNING

        ) {

            return;

        }

        this.state =
            ApplicationState.STOPPING;

        await EventBus.emit(

            "application.stopping"

        );

        await LifecycleManager.stop(

            this.context,

            this.context

        );

        this.state =
            ApplicationState.STOPPED;

    }

    async dispose() {

        await LifecycleManager.dispose(

            this.context,

            this.context

        );

        this.state =
            ApplicationState.DISPOSED;

    }

}

module.exports = Application;