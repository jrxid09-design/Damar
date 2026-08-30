const snapshots = new WeakMap();

class AIToolRegistry {

    constructor() {

        snapshots.set(this, new Map());

    }

    register(tool) {

        snapshots.get(this).set(tool.name, tool);

        return this;

    }

    unregister(name) {

        snapshots.get(this).delete(name);

        return this;

    }

    has(name) {

        return snapshots.get(this).has(name);

    }

    get(name) {

        return snapshots.get(this).get(name);

    }

    all() {

        return [...snapshots.get(this).values()];

    }

    replaceSnapshot(tools) {
        if (!Array.isArray(tools)) throw new TypeError("tools must be an array");
        const next = new Map();
        for (const tool of tools) {
            if (!tool || typeof tool.name !== "string") throw new TypeError("invalid tool");
            next.set(tool.name, tool);
        }
        snapshots.set(this, next);
        return this;

    }

}

module.exports = AIToolRegistry;
