"use strict";

const SCHEMA_VERSION = "longhorizon.v1";

const BOUNDS = Object.freeze({
    MAX_AUDIT_EVENTS_PER_CYCLE: 256,
    MAX_TRACKED_CAPABILITY_IDS: 4096
});

const MODES = Object.freeze(["off", "shadow", "governed"]);

module.exports = { SCHEMA_VERSION, BOUNDS, MODES };
