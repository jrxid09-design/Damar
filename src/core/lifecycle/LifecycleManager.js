class LifecycleManager {

    async initialize(component, context) {

        if (
            component &&
            typeof component.initialize === "function"
        ) {

            await component.initialize(context);

        }

    }

    async start(component, context) {

        if (
            component &&
            typeof component.start === "function"
        ) {

            await component.start(context);

        }

    }

    async stop(component, context) {

        if (
            component &&
            typeof component.stop === "function"
        ) {

            await component.stop(context);

        }

    }

    async dispose(component, context) {

        if (
            component &&
            typeof component.dispose === "function"
        ) {

            await component.dispose(context);

        }

    }

}

module.exports = new LifecycleManager();