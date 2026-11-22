"use strict";

const { freezeDeep } = require("./model");

const PORT_NAMES = Object.freeze([
    "presenceRuntime", "agentRuntime", "reIntelligence",
    "voice", "interactionBus", "actuationFabric", "watchdog"
]);

function createIntegrationPort(name) {
    if (!PORT_NAMES.includes(name)) {
        throw new Error(`UNKNOWN_INTEGRATION_PORT: ${name}`);
    }
    let listener = null;
    return freezeDeep({
        name,
        kind: "ResourceGovernorIntegrationPort",
        registerPressureListener(fn) {
            if (typeof fn !== "function") throw new TypeError("listener must be a function");
            if (listener) throw new Error("PORT_ALREADY_BOUND");
            listener = fn;
            return true;
        },
        publish(recommendations) {
            if (!listener) return 0;
            const payload = freezeDeep({
                source: "resource-governor",
                port: name,
                atMs: Date.now(),
                recommendations: Object.freeze([...recommendations])
            });
            listener(payload);
            return 1;
        }
    });
}

function createIntegrationPorts() {
    const ports = {};
    for (const name of PORT_NAMES) ports[name] = createIntegrationPort(name);
    return freezeDeep(ports);
}

module.exports = { createIntegrationPorts, createIntegrationPort, PORT_NAMES };
