"use strict";

const laws = Object.freeze({
    // W8-L3's single most safety-critical line (frozen contract): a region
    // with no evidence blocks physical preconditions, it never defaults to
    // "clear". Mirrors L4's "missing hazard defaults strict" convention.
    UNKNOWN_NEVER_MEANS_CLEAR: true,
    RF_SIGNAL_FRAME_INFERENCE_NOT_FACT_TRUST_AUTHORITY: true,
    SPATIAL_ESTIMATE_NOT_AUTHORITY: true,
    CONTESTED_GEOMETRY_BLOCKS_MOTION: true,
    NO_SECOND_SPATIAL_TRUTH_MODEL: true,
    L3_NEVER_MOVES_ANYTHING: true
});

module.exports = { laws };
