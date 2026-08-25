const BasePlugin = require("../../base/BasePlugin");
const TimeTool = require("./tools/TimeTool");
const manifest = require("./manifest.json");

class TimePlugin extends BasePlugin {

    get manifest() {
        return manifest;
    }

    get tools() {
        return [
            new TimeTool()
        ];
    }

}

module.exports = new TimePlugin();