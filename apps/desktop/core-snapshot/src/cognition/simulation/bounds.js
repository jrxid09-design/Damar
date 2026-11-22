"use strict";

const SCHEMA_VERSION = "simulation.v1";

/** W8-L5 bounds -- exact provisional numbers from the frozen contract (AMB-W8-03). */
const BOUNDS = Object.freeze({
    MAX_CONCURRENT_RUNS: 2,
    MAX_STEPS_PER_RUN: 256,
    MAX_HORIZON_DAYS: 7,
    MAX_TOKENS_PER_RUN: 100000,
    MAX_TOKENS_PER_HOUR: 500000,
    MAX_RETAINED_RUNS: 1000,
    MAX_RESULT_BYTES: 262144,
    TTL_MS: 3600000
});

module.exports = { SCHEMA_VERSION, BOUNDS };
