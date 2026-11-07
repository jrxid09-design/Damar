const Application = require("./Application");

class ApplicationBuilder {

    constructor() {

        this.services = {};

    }

    use(name, service) {

        this.services[name] = service;

        return this;

    }

    build() {

        return new Application(
            this.services
        );

    }

}

module.exports = ApplicationBuilder;