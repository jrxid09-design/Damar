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

function rejectLegacyActionMiddleware(surface) {
    return (_req, res) => res.status(503).json({
        success: false,
        code: LEGACY_ACTION_ROUTE_DISABLED,
        message: `External ${surface} action ingress is disabled; use the canonical Damar Manager`
    });
}

module.exports = Object.freeze({
    LEGACY_ACTION_ROUTE_DISABLED,
    rejectLegacyActionRoute,
    rejectLegacyActionMiddleware
});
