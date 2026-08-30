const { types } = require("node:util");
const snapshots = new WeakMap();
const owners = new WeakMap();

function snapshotFrom(tools) {
    if (!Array.isArray(tools)) throw new TypeError("tools must be an array");
    const next = new Map();
    for (const tool of tools) {
        if (!tool || typeof tool !== "object" || types.isProxy?.(tool)) throw new TypeError("invalid tool");
        const name = Object.getOwnPropertyDescriptor(tool, "name");
        const execute = Object.getOwnPropertyDescriptor(tool, "execute");
        if (!name || !execute || name.get || name.set || execute.get || execute.set ||
            typeof name.value !== "string" || name.value.length === 0 ||
            typeof execute.value !== "function") throw new TypeError("invalid tool contract");
        const record = Object.freeze(Object.fromEntries(Reflect.ownKeys(tool).map(key => { const d = Object.getOwnPropertyDescriptor(tool, key); if (!d || d.get || d.set) throw new TypeError("invalid tool accessor"); return [key, d.value]; })));
        next.set(name.value, record);
    }
    return next;
}

class AIToolRegistry {

    constructor() {

        snapshots.set(this, new Map());
        owners.set(this, Object.freeze({ replaceSnapshot: (tools) => { snapshots.set(this, snapshotFrom(tools)); return this; } }));

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

}

function createOwnedAIToolRegistry() {
    const registry = new AIToolRegistry();
    return Object.freeze({ registry, owner: owners.get(registry) });
}

module.exports = AIToolRegistry;
module.exports.createOwnedAIToolRegistry = createOwnedAIToolRegistry;
