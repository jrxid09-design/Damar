const ServiceDescriptor =
    require("./ServiceDescriptor");

const ServiceLifetime =
    require("./ServiceLifetime");

class ServiceContainer {

    constructor() {

        this.services = new Map();

    }

    registerSingleton(name, factory) {

        this.services.set(

            name,

            new ServiceDescriptor({

                name,

                factory,

                lifetime:
                    ServiceLifetime.SINGLETON

            })

        );

        return this;

    }

    registerTransient(name, factory) {

        this.services.set(

            name,

            new ServiceDescriptor({

                name,

                factory,

                lifetime:
                    ServiceLifetime.TRANSIENT

            })

        );

        return this;

    }

    resolve(name) {

        const descriptor =
            this.services.get(name);

        if (!descriptor) {

            throw new Error(

                `Service '${name}' is not registered.`

            );

        }

        if (

            descriptor.lifetime ===

            ServiceLifetime.SINGLETON

        ) {

            if (!descriptor.instance) {

                descriptor.instance =
                    descriptor.factory(this);

            }

            return descriptor.instance;

        }

        return descriptor.factory(this);

    }

    has(name) {

        return this.services.has(name);

    }

    unregister(name) {

        return this.services.delete(name);

    }

    clear() {

        this.services.clear();

    }

    list() {

        return Array.from(

            this.services.keys()

        );

    }

}

module.exports = new ServiceContainer();