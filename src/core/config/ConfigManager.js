class ConfigManager {

    constructor() {

        this.config = {

            app: {
                name: "Aether",
                version: "0.1.0"
            },

            http: {
                timeout: 30000
            },

            weather: {
                provider: "open-meteo",
                cacheTTL: 300
            },

            logger: {
                level: "INFO"
            }

        };

    }

    get(path, defaultValue = null) {

        const keys = path.split(".");

        let value = this.config;

        for (const key of keys) {

            if (value[key] === undefined) {
                return defaultValue;
            }

            value = value[key];

        }

        return value;

    }

    set(path, newValue) {

        const keys = path.split(".");

        let current = this.config;

        while (keys.length > 1) {

            const key = keys.shift();

            if (!current[key]) {
                current[key] = {};
            }

            current = current[key];

        }

        current[keys[0]] = newValue;

    }

}

module.exports = new ConfigManager();