class AIToolRegistry {

    constructor() {

        this.tools = new Map();

    }

    register(tool) {

        this.tools.set(tool.name, tool);

        return this;

    }

    unregister(name) {

        this.tools.delete(name);

        return this;

    }

    has(name) {

        return this.tools.has(name);

    }

    get(name) {

        return this.tools.get(name);

    }

    all() {

        return [...this.tools.values()];

    }

}

module.exports = AIToolRegistry;