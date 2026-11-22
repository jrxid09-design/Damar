"use strict";

const SCHEMA_VERSION = "perception.v1";
const BOUNDS = Object.freeze({
    MAX_QUESTIONS: 1024,
    // Runtime enforces a stricter per-instance lifetime ceiling until a
    // trusted scheduler-cycle identity is supplied by the canonical owner.
    MAX_PROBES_PER_CYCLE: 8,
    MAX_INTERACTIVE_PROBES_PER_HOUR: 4,
    MAX_ATTEMPTS_PER_QUESTION: 3,
    MAX_CONCURRENT_PROBES: 4,
    MAX_QUESTION_CHARS: 1024
});

module.exports = { SCHEMA_VERSION, BOUNDS };
