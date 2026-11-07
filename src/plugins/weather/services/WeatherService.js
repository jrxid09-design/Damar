const BaseService = require("../../../core/services/BaseService");
const CacheManager = require("../../../core/cache/CacheManager");

const GeocodingService = require("./GeocodingService");
const OpenMeteoProvider = require("../providers/OpenMeteoProvider");
const WeatherMapper = require("../mappers/WeatherMapper");

class WeatherService extends BaseService {

    constructor() {
        super("Weather");

        this.cache = CacheManager.get("weather");
    }

    async current(city) {

        this.debug(`Fetching weather for "${city}"`);

        const cacheKey = city.toLowerCase();

        // ==========================
        // Cek cache
        // ==========================
        const cached = this.cache.get(cacheKey);

        if (cached) {

            this.debug(`Cache hit for "${city}"`);

            return this.ok(cached);

        }

        this.debug(`Cache miss for "${city}"`);

        // ==========================
        // Geocoding
        // ==========================
        const location = await GeocodingService.search(city);

        if (!location.success) {
            return location;
        }

        // ==========================
        // Ambil data dari provider
        // ==========================
        const provider = await OpenMeteoProvider.current(
            location.data.latitude,
            location.data.longitude
        );

        if (!provider.success) {
            return provider;
        }

        // ==========================
        // Mapping ke model Damar
        // ==========================
        const response = {

            location: location.data,

            current: WeatherMapper.map(
                provider.data
            )

        };

        // ==========================
        // Simpan ke cache
        // ==========================
        this.cache.set(
            cacheKey,
            response,
            this.getConfig("weather.cacheTTL", 300)
        );

        this.debug(`Weather cached for "${city}"`);

        return this.ok(response);

    }

}

module.exports = new WeatherService();