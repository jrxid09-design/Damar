const ConfigManager = require("./ConfigManager");

class Config {

    static get(path, defaultValue = null) {

        return ConfigManager.get(path, defaultValue);

    }

    static set(path, value) {

        ConfigManager.set(path, value);

    }

}

module.exports = Config;