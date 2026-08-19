const registry = require("./registry/toolRegistry");

registry.register(
    require("./implementations/timeTool")
);

module.exports = registry;