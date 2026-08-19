class CacheEntry {

    constructor(value, ttl = 0) {

        this.value = value;

        this.createdAt = Date.now();

        this.expiresAt =
            ttl > 0
                ? Date.now() + ttl * 1000
                : null;

    }

    isExpired() {

        return this.expiresAt !== null &&
            Date.now() > this.expiresAt;

    }

}

module.exports = CacheEntry;