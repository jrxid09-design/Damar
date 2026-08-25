const fs = require("fs");
const path = require("path");

const capabilityRegistry = require("./capabilityRegistry");
const capabilityValidator = require("./capabilityValidator");

class CapabilityLoader {

    load(directory) {

        const files = fs.readdirSync(directory);

        for (const file of files) {

            if (!file.endsWith(".json"))
                continue;

            const fullPath = path.join(directory, file);

            const capability = JSON.parse(
                fs.readFileSync(fullPath, "utf8")
            );

            capabilityValidator.validate(capability);

            capabilityRegistry.register(capability);

        }

    }

}

module.exports = new CapabilityLoader();