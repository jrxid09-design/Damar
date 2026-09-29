"use strict";

const { BOUNDS } = require("./laws");

function checkDrift(preference, newStrength) {
    // RT-W10-34: weekly drift cap — delta per week must not exceed MAX_STRENGTH_DELTA_PER_WEEK
    const current = preference.strength || 0;
    const delta = Math.abs(newStrength - current);
    if (delta > BOUNDS.MAX_STRENGTH_DELTA_PER_WEEK) {
        throw new Error(`Preference drift exceeds weekly cap (${BOUNDS.MAX_STRENGTH_DELTA_PER_WEEK}) — drift capped (W10-L4/RT-W10-34). Requested delta: ${delta.toFixed(3)}`);
    }
    return { allowed: true, clampedStrength: newStrength };
}

module.exports = { checkDrift };
