"use strict";

const { createResourceGovernor, ResourceGovernor } = require("./governor");

module.exports = {
    createResourceGovernor,
    ResourceGovernor,
    createResourceDemand: require("./model").createResourceDemand,
    model: require("./model"),
    ids: require("./ids"),
    config: require("./config"),
    pressure: require("./pressure"),
    observer: require("./observer"),
    integrationPorts: require("./integrationPorts")
};
