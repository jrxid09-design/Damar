const BaseMapper = require("../../../core/mappers/BaseMapper");
const WeatherCodes = require("../constants/WeatherCodes");

class WeatherMapper extends BaseMapper {

    map(current) {

        const weather =
            WeatherCodes[current.weather_code] || {
                code: current.weather_code,
                description: "Unknown",
                icon: "❓"
            };

        return {

            timestamp: current.time,

            temperature: {
                actual: current.temperature_2m,
                feelsLike: current.apparent_temperature,
                unit: "°C"
            },

            humidity: current.relative_humidity_2m,

            wind: {
                speed: current.wind_speed_10m,
                direction: current.wind_direction_10m,
                unit: "km/h"
            },

            pressure: {
                value: current.surface_pressure,
                unit: "hPa"
            },

            cloudCover: current.cloud_cover,

            precipitation: {
                total: current.precipitation,
                rain: current.rain,
                showers: current.showers,
                snowfall: current.snowfall,
                unit: "mm"
            },

            isDay: Boolean(current.is_day),

            weather,

            summary:
                `${weather.icon} ${weather.description}, ${current.temperature_2m}°C`

        };

    }

}

module.exports = new WeatherMapper();