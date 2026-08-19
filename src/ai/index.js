const AIBuilder = require("./builder/AIBuilder");

module.exports = {

    // Entry point utama: new Aether.Builder()...build()
    Builder: AIBuilder,

    AIBuilder,

    builder: require("./builder"),

    context: require("./context"),

    engine: require("./engine"),

    events: require("./events"),

    exceptions: require("./exceptions"),

    models: require("./models"),

    providers: require("./providers"),

    services: require("./services"),

    tools: require("./tools"),

    runtime: require("./runtime")

};
