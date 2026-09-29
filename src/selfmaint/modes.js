"use strict";

const { MODES, BOUNDS } = require("./laws");

function makeModeOps(store) {
    // RT-W10-51: degraded/critical modes must increase reporting, not reduce it
    function getReportingLevel(mode) {
        if (mode === MODES.HALTED) return "MAXIMUM";
        if (mode === MODES.DEGRADED || mode === MODES.CRITICAL) return "HIGH";
        if (mode === MODES.READ_ONLY) return "HIGH";
        return "NORMAL";
    }

    // RT-W10-52: flap detection — count transitions in window, refuse if over cap
    async function checkFlap(windowMs) {
        const transitions = await store.getTransitions();
        const cutoff = Date.now() - (windowMs || 3600000);
        const recent = transitions.filter(t => t.transitionedAt > cutoff);
        return recent.length;
    }

    async function transition(from, to, reason) {
        const flapCount = await checkFlap(3600000);
        // RT-W10-52: damp and audit mode flapping
        if (flapCount >= BOUNDS.MAX_MODE_FLAP_PER_HOUR) {
            const entry = {
                from, to, reason,
                flapCount: flapCount + 1,
                damped: true,
                transitionedAt: Date.now(),
            };
            await store.addTransition(entry);
            return { damped: true, flapCount: flapCount + 1, transition: entry };
        }
        const entry = { from, to, reason, flapCount, damped: false, transitionedAt: Date.now() };
        await store.addTransition(entry);
        return { damped: false, flapCount, transition: entry };
    }

    return { transition, getReportingLevel, checkFlap };
}

module.exports = { makeModeOps };
