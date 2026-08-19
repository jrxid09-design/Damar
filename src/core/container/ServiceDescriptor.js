class ServiceDescriptor {

    constructor({

        name,

        factory,

        lifetime,

        instance = null

    }) {

        this.name = name;

        this.factory = factory;

        this.lifetime = lifetime;

        this.instance = instance;

    }

}

module.exports = ServiceDescriptor;