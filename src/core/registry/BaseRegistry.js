class BaseRegistry {

    constructor() {

        this.items = new Map();

    }

    register(id, item) {

        this.items.set(id, item);

        return item;

    }

    unregister(id) {

        return this.items.delete(id);

    }

    get(id) {

        return this.items.get(id);

    }

    has(id) {

        return this.items.has(id);

    }

    list() {

    return this.entries().map(

        ([id, item]) => ({

            id,

            item

        })

    );

}

    ids() {

        return Array.from(
            this.items.keys()
        );

    }

    values() {

        return Array.from(
            this.items.values()
        );

    }

    count() {

        return this.items.size;

    }

    clear() {

        this.items.clear();

    }

    find(predicate) {

        return this.values().filter(
            predicate
        );

    }

    forEach(callback) {

        this.items.forEach(
            (item, id) =>
                callback(item, id)
        );

    }
    entries() {

    return Array.from(
        this.items.entries()
    );

}

}

module.exports = BaseRegistry;