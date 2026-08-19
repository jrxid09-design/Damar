const IntegrationManager = require("./IntegrationManager");

module.exports = {

    IntegrationManager,

    BaseConnector: require("./BaseConnector"),

    AgentConnector: require("./connectors/AgentConnector"),

    OllamaConnector: require("./connectors/OllamaConnector"),

    OpenClawConnector: require("./connectors/OpenClawConnector"),

    HermesConnector: require("./connectors/HermesConnector"),

    /** Instance tunggal yang dipakai server. */
    manager: new IntegrationManager({
        logger: require("../utils/logger")
    })

};
