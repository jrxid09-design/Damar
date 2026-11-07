const CacheManager = require("../core/cache/CacheManager");

const cache = CacheManager.get();

cache.set("name", "Damar", 3);

console.log(

    cache.get("name")

);

setTimeout(() => {

    console.log(

        cache.get("name")

    );

}, 4000);