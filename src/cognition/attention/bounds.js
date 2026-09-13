"use strict";

const SCHEMA_VERSION = "attention.v1";

const PRIORITY_CLASSES = Object.freeze(["P0_SAFETY", "P1_OWNER", "P2_COMMITMENT", "P3_GOAL", "P4_BACKGROUND"]);

/** §4: kuota cadangan per kelas (persen, jumlah 100). */
const CLASS_QUOTA = Object.freeze({
    P0_SAFETY: 20, P1_OWNER: 35, P2_COMMITMENT: 20, P3_GOAL: 15, P4_BACKGROUND: 10
});

/** Basis effectivePriority — hanya untuk pengurutan DALAM kelas yang sama terpilih. */
const CLASS_BASE = Object.freeze({
    P0_SAFETY: 1000, P1_OWNER: 800, P2_COMMITMENT: 600, P3_GOAL: 400, P4_BACKGROUND: 200
});

const BOUNDS = Object.freeze({
    MAX_QUEUED_TARGETS: 4096,
    MAX_SIGNALS_PER_SOURCE_PER_MINUTE: 120,
    MAX_DISTINCT_SOURCES_COUNTED: 8,
    MAX_WAIT_MS: 60_000,
    MAX_PREEMPTIONS: 3,
    MAX_OVERFLOW_JOURNAL: 100000,
    AGING_BONUS_MAX: 100,
    DECAY_PER_MS: 0.0005,
    CORROBORATION_BONUS_MAX: 50,
    MAX_SUPPORTING_SIGNALS_PER_TARGET: 64
});

module.exports = { SCHEMA_VERSION, PRIORITY_CLASSES, CLASS_QUOTA, CLASS_BASE, BOUNDS };
