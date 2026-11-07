const HttpClient = require("../../http/services/HttpClient");

class GeocodingService {

    static async search(city) {

        const url =
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;

        const result = await HttpClient.get(url);

        if (!result.success) {
            return result;
        }

        if (
            !result.data.results ||
            result.data.results.length === 0
        ) {

            return {
                success: false,
                error: "Location not found."
            };

        }

        const location = result.data.results[0];

        return {
            success: true,
            data: {
                name: location.name,
                country: location.country,
                latitude: location.latitude,
                longitude: location.longitude,
                timezone: location.timezone
            }
        };

    }

}

module.exports = GeocodingService;