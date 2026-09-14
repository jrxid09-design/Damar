"use strict";

const SCHEMA_VERSION = "goals.v1";

const BOUNDS = Object.freeze({
    MAX_ACTIVE_GOALS: 256,
    MAX_TOTAL_GOALS_RETAINED: 10000,
    MAX_GOAL_DEPTH: 5,
    MAX_CHILDREN_PER_GOAL: 32,
    MAX_GOAL_CREATION_RATE_PER_MINUTE: 20,
    MAX_PLAN_VERSIONS_RETAINED: 16,
    MAX_STEPS_PER_PLAN: 256,
    MAX_ATTEMPTS_PER_TASK: 5,
    MAX_OPEN_COMMITMENTS: 512,
    MAX_TRANSITION_LOG_PER_GOAL: 256,
    MAX_TOTAL_COMMITMENTS_RETAINED: 20000,
    MAX_TOTAL_TASKS_RETAINED: 20000,
    MAX_TOTAL_PLANS_RETAINED: 20000,
    // Bug review independen (audit putaran-57, OpenCode, W7R57-P2-1):
    // invalidatePlanIfAssumptionBroken menambah invalidatedBy tanpa
    // batas -- MAX_PLAN_VERSIONS_RETAINED/MAX_TOTAL_PLANS_RETAINED
    // membatasi JUMLAH plan, tapi tidak field turunan di dalam SATU
    // plan. Ditambahkan di sini, dipakai lewat slice(-bound).
    MAX_INVALIDATED_BY_PER_PLAN: 256
});

module.exports = { SCHEMA_VERSION, BOUNDS };
