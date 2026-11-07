const BaseTool = require("../../../core/tools/BaseTool");

const WeatherService = require("../services/WeatherService");

class CurrentWeatherTool extends BaseTool {

    constructor() {

        super({

            name: "currentWeather",

            description: "Current weather.",

            parameters: {

                city: {

                    type: "string",

                    required: true

                }

            }

        });

    }

    async execute(args) {

        return WeatherService.current(args.city);

    }

}

module.exports = CurrentWeatherTool;