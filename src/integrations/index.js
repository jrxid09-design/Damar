const IntegrationManager = require("./IntegrationManager");

module.exports = {

    IntegrationManager,

    BaseConnector: require("./BaseConnector"),

    AgentConnector: require("./connectors/AgentConnector"),

    /** Instance tunggal yang dipakai server. */
    manager: new IntegrationManager({
        logger: require("../utils/logger")
    })

};
