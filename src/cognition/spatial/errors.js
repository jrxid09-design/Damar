"use strict";

const REASONS = Object.freeze({
    INVALID_RECORD: "INVALID_RECORD",
    UNKNOWN_FRAME: "UNKNOWN_FRAME",
    TRANSFORM_CYCLE_REJECTED: "TRANSFORM_CYCLE_REJECTED",
    BOUND_EXCEEDED: "BOUND_EXCEEDED",
    EXECUTABLE_MATERIAL_REJECTED: "EXECUTABLE_MATERIAL_REJECTED"
});

class SpatialError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "SpatialError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new SpatialError(reason, message, details);
}

module.exports = { REASONS, SpatialError, fail };
