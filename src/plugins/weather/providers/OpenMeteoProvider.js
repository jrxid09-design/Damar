const HttpClient = require("../../http/services/HttpClient");
const BaseProvider = require("../../../core/providers/BaseProvider");

class OpenMeteoProvider extends BaseProvider {

    constructor() {
        super("OpenMeteo");
    }

    async current(latitude, longitude) {

        const url =
            `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${latitude}` +
            `&longitude=${longitude}` +
            `&current=` +
            `temperature_2m,relative_humidity_2m,apparent_temperature,` +
            `is_day,precipitation,rain,showers,snowfall,weather_code,` +
            `cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m`;

        const result = await HttpClient.get(url);

        if (!result.success) {
            return this.fail(result.error);
        }

        return this.ok(result.data.current);

    }

}

module.exports = new OpenMeteoProvider();