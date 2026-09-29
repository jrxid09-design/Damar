"use strict";

const { HEALTH_STATES, HEALTH_SCHEMA_VERSION } = require("./laws");

function makeHealthOps() {
    // RT-W10-47: signals are raw data — never auto-approve actions from health signals
    function assessHealth(signals) {
        if (!Array.isArray(signals)) signals = [];
        const critical = signals.filter(s => s.severity === "CRITICAL");
        const warnings = signals.filter(s => s.severity === "WARNING");
        let state = HEALTH_STATES.HEALTHY;
        if (critical.length > 0) state = HEALTH_STATES.CRITICAL;
        else if (warnings.length > 0) state = HEALTH_STATES.DEGRADED;
        return {
            schemaVersion: HEALTH_SCHEMA_VERSION,
            state,
            rawSignals: signals,
            assessedAt: Date.now(),
        };
    }

    // RT-W10-46: self-preservation never overrides a denied action
    function continueDeniedAction(action, context) {
        if (!action || action.denied) {
            throw new Error(
                "Self-preservation is not authority — denied action cannot be continued (W10-L6/RT-W10-46)"
            );
        }
        throw new Error(
            "continueDeniedAction: action must be explicitly denied to apply this guard"
        );
    }

    return { assessHealth, continueDeniedAction };
}

module.exports = { makeHealthOps };
