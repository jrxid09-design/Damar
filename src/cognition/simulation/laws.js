"use strict";

const laws = Object.freeze({
    SIMULATION_NOT_REALITY: true,
    PREDICTION_NOT_FACT: true,
    // Results are ALWAYS tier T10 at storage -- never any other tier. T10 is
    // absent from worldmodel's ADMISSIBLE_TIERS (T1/T2/T4 only), so this is
    // a structural, doubly-enforced guarantee, not merely a policy: even a
    // mistaken attempt to feed a simulation result into
    // worldmodel.ingestObservation is rejected by W7-L2's own, unmodified
    // tier-admission guard.
    FORCED_T10: true,
    NEVER_REPLICATED: true,
    NO_AUTHORITY_CLIENT: true,
    NO_ACTUATOR_HANDLE: true,
    NO_EXTERNAL_STORE_WRITER: true,
    NOT_GOAL_SATISFACTION_EVIDENCE: true,
    NOT_AUTOBIOGRAPHY_EVIDENCE: true,
    SNAPSHOT_INPUTS_FROZEN_AT_RUN_START: true
});

module.exports = { laws };
