const GeocodingService = require("../plugins/weather/services/GeocodingService");

(async () => {

    const result = await GeocodingService.search("Jakarta");

    console.dir(result, {
        depth: null
    });

})();