"use strict";

const { MODES } = require("./laws");

function makeHeadroomOps(store) {
    // RT-W10-54: storage pressure never justifies silent data loss — READ_ONLY and ask
    function assessHeadroom(usage, capacity) {
        if (typeof usage !== "number" || typeof capacity !== "number" || capacity <= 0) {
            return { state: "UNKNOWN", mode: MODES.READ_ONLY, requiresOwnerDecision: true, silent: false };
        }
        const ratio = usage / capacity;
        if (ratio >= 1.0) {
            return { state: "FULL", mode: MODES.READ_ONLY, requiresOwnerDecision: true, silent: false };
        }
        if (ratio >= 0.9) {
            return { state: "PRESSURE", mode: MODES.READ_ONLY, requiresOwnerDecision: true, silent: false };
        }
        return { state: "OK", mode: MODES.NORMAL, requiresOwnerDecision: false, silent: false };
    }

    return { assessHeadroom };
}

module.exports = { makeHeadroomOps };
