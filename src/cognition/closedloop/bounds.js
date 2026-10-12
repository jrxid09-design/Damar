"use strict";

const SCHEMA_VERSION = "closedloop.v1";

/**
 * W8-L6 bounds. Loop rate inherits L4's 20 Hz adapter cap (the loop cannot
 * busy-spin on a failing actuator); the rest are conservative safe defaults
 * (AMB-W8-03: safe default, replace only with measured evidence). The
 * completion-record bound is the L2 handoff's dedup ceiling, not a wall-clock
 * authority cache.
 */
const BOUNDS = Object.freeze({
    MAX_LOOP_RATE_HZ: 20,
    MAX_CONCURRENT_LOOPS: 1,
    MAX_STAGES: 9,
    MAX_COMPLETION_RECORDS: 1024,
    MIN_LOOP_INTERVAL_MS: 50
});

module.exports = { SCHEMA_VERSION, BOUNDS };
