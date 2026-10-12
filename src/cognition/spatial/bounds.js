"use strict";

const SCHEMA_VERSION = "spatial.v1";

/**
 * W8-L3 bounds. The frozen contract (WAVE8_CONTRACTS_FROZEN.md, AMB-W8-03)
 * deliberately left exact scene/transform/grid/query-depth caps for
 * benchmark-time determination rather than committing to a fixed number the
 * way L1/L2/L4/L5 do -- these are disclosed PROVISIONAL defaults (safe,
 * conservative), not measured, per AMB-W8-03's "safe default already
 * defined, replace only with measured evidence" principle. Callers may
 * override any of these via sanitizeBounds, same as every Wave7 lane.
 */
const BOUNDS = Object.freeze({
    MAX_FRAMES: 4096,
    MAX_TRANSFORMS: 16384,
    MAX_SCENE_NODES: 65536,
    MAX_REACHABILITY_PATH_LENGTH: 256,
    MAX_STALE_REGIONS_EVICTED_PER_CALL: 4096
});

module.exports = { SCHEMA_VERSION, BOUNDS };
