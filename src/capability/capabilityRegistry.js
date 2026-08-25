class CapabilityRegistry {

    constructor() {
        this.capabilities = new Map();
    }

    register(capability) {
        this.capabilities.set(capability.id, capability);
    }

    unregister(id) {
        this.capabilities.delete(id);
    }

    get(id) {
        return this.capabilities.get(id);
    }

    getAll() {
        return [...this.capabilities.values()];
    }

    getByType(type) {
        return this.getAll().filter(c => c.type === type);
    }

    getByCategory(category) {
        return this.getAll().filter(c => c.category === category);
    }

    has(id) {
        return this.capabilities.has(id);
    }

    clear() {
        this.capabilities.clear();
    }

}

module.exports = new CapabilityRegistry();