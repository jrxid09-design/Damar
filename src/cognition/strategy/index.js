"use strict";

const { makeStrategyStore } = require("./store");
const { makeScenario } = require("./scenario");

function makeStrategy(acc) {
    const store = makeStrategyStore(acc);
    const scenario = makeScenario(store);
    return { scenario };
}

module.exports = { makeStrategy };
