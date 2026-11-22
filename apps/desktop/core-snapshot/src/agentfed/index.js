"use strict";

const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { LAWS } = require("./laws");
const { STATES } = require("./agent");
const { makeAgentFedStore } = require("./store");
const { makeLifecycle } = require("./lifecycle");
const { makeMessageHandler } = require("./message");
const { makeQuarantine } = require("./quarantine");
const { makeReliability } = require("./reliability");
const { makeEgress } = require("./egress");

function makeAgentFed(acc) {
    const store = makeAgentFedStore(acc);
    const lifecycle = makeLifecycle(store);
    const messages = makeMessageHandler(store);
    const quarantine = makeQuarantine(store);
    const reliability = makeReliability(store);
    const egress = makeEgress();
    return { lifecycle, messages, quarantine, reliability, egress };
}

module.exports = { makeAgentFed, BOUNDS, LAWS, STATES, SCHEMA_VERSION };
