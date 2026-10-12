"use strict";

const SCHEMA_VERSION = "strategy.v1";
const SCENARIO_SCHEMA_VERSION = "strategy.scenario.v1";

const BOUNDS = Object.freeze({
    MAX_SCENARIOS: 256,
    MAX_SCENARIO_BRANCHES: 32,
    MAX_SCENARIO_LABEL_BYTES: 512,
    MAX_SCENARIO_DEPTH: 5,
});

module.exports = { SCHEMA_VERSION, SCENARIO_SCHEMA_VERSION, BOUNDS };
