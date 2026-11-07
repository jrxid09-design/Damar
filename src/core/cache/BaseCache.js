class BaseCache {

    get(key) {
        throw new Error("get() not implemented.");
    }

    set(key, value, ttl = 0) {
        throw new Error("set() not implemented.");
    }

    has(key) {
        throw new Error("has() not implemented.");
    }

    delete(key) {
        throw new Error("delete() not implemented.");
    }

    clear() {
        throw new Error("clear() not implemented.");
    }

}

module.exports = BaseCache;