"use strict";

const REASONS = Object.freeze({
    INVALID_PROJECTION: "INVALID_PROJECTION",
    AUTHORITY_SHAPED_FIELD_REJECTED: "AUTHORITY_SHAPED_FIELD_REJECTED"
});

class GovernedError extends Error {
    constructor(reason, message, details = null) {
        super(message);
        this.name = "GovernedError";
        this.reason = reason;
        this.details = details;
    }
}

function fail(reason, message, details) {
    throw new GovernedError(reason, message, details);
}

module.exports = Object.freeze({ REASONS, GovernedError, fail });
