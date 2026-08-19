const BaseProvider = require("../../../core/providers/BaseProvider");
const HttpClient = require("../../http/services/HttpClient");

class GeocodingProvider extends BaseProvider {

    constructor() {
        super("Geocoding");
    }

    async search(city) {

        this.debug(`Searching "${city}"`);

        const url =
            `https://geocoding-api.open-meteo.com/v1/search` +
            `?name=${encodeURIComponent(city)}` +
            `&count=1`;

        const result = await HttpClient.get(url);

        if (!result.success) {
            return this.fail(result.error);
        }

        return this.ok(result.data);

    }

}

module.exports = new GeocodingProvider();