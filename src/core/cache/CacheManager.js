const MemoryCache = require("./MemoryCache");

class CacheManager {

    constructor() {

        this.caches = new Map();

    }

    get(name = "default") {

        if (!this.caches.has(name)) {

            this.caches.set(
                name,
                new MemoryCache()
            );

        }

        return this.caches.get(name);

    }

}

module.exports = new CacheManager();