const BaseCache = require("./BaseCache");
const CacheEntry = require("./CacheEntry");

class MemoryCache extends BaseCache {

    constructor() {

        super();

        this.store = new Map();

    }

    get(key) {

        const entry = this.store.get(key);

        if (!entry)
            return null;

        if (entry.isExpired()) {

            this.store.delete(key);

            return null;

        }

        return entry.value;

    }

    set(key, value, ttl = 0) {

        this.store.set(
            key,
            new CacheEntry(value, ttl)
        );

    }

    has(key) {

        return this.get(key) !== null;

    }

    delete(key) {

        this.store.delete(key);

    }

    clear() {

        this.store.clear();

    }

}

module.exports = MemoryCache;