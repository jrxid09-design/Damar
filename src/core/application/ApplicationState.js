const ApplicationState = Object.freeze({

    CREATED: "created",

    INITIALIZING: "initializing",

    INITIALIZED: "initialized",

    STARTING: "starting",

    RUNNING: "running",

    STOPPING: "stopping",

    STOPPED: "stopped",

    DISPOSED: "disposed"

});

module.exports = ApplicationState;