"use strict";

const SCHEMA_VERSION = "simulation.v1";

/** W8-L5 bounds -- exact provisional numbers from the frozen contract (AMB-W8-03).
 * Token bounds neutralized 2026-11-28 (Owner rule: token spend is the user's
 * own affair; Damar imposes no token budget). Set to 1e12 so the checks in
 * records.js / index.js can never trip on tokens; step/concurrency bounds are
 * runaway protection, not budgets, and are unchanged. */
const BOUNDS = Object.freeze({
    MAX_CONCURRENT_RUNS: 2,
    MAX_STEPS_PER_RUN: 256,
    MAX_HORIZON_DAYS: 7,
    MAX_TOKENS_PER_RUN: 1000000000000,
    MAX_TOKENS_PER_HOUR: 1000000000000,
    MAX_RETAINED_RUNS: 1000,
    MAX_RESULT_BYTES: 262144,
    TTL_MS: 3600000
});

module.exports = { SCHEMA_VERSION, BOUNDS };
