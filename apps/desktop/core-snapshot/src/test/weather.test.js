const WeatherService = require("../plugins/weather/services/WeatherService");

(async () => {

    const result = await WeatherService.current("Jakarta");

    console.dir(result, {
        depth: null
    });

})();