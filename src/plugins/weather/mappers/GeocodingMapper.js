class GeocodingMapper {

    static map(data) {

        if (!data.results || data.results.length === 0) {

            return null;

        }

        const item = data.results[0];

        return {

            name: item.name,

            country: item.country,

            latitude: item.latitude,

            longitude: item.longitude,

            timezone: item.timezone

        };

    }

}

module.exports = GeocodingMapper;