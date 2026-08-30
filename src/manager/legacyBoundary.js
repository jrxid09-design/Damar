"use strict";

/** External legacy action ingress guard. */
const LEGACY_ACTION_ROUTE_DISABLED = "LEGACY_ACTION_ROUTE_DISABLED";

function rejectLegacyActionRoute(surface) {
    const error = new Error(
        `External ${surface} action ingress is disabled; use the canonical Damar Manager`
    );
    error.code = LEGACY_ACTION_ROUTE_DISABLED;
    error.surface = String(surface || "unknown");
    throw error;
}

module.exports = Object.freeze({
    LEGACY_ACTION_ROUTE_DISABLED,
    rejectLegacyActionRoute
});
