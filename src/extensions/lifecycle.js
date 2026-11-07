"use strict";

/**
 * EXTENSION KERNEL V1 — explicit lifecycle state machine.
 *
 * States form a closed enum with a closed transition table. Every transition
 * is validated BEFORE any mutation happens, so an invalid transition can
 * never leave partial state behind.
 *
 *   DISCOVERED  --install-->        INSTALLED
 *   INSTALLED   --enable-->         ENABLED
 *   DISABLED    --enable-->         ENABLED
 *   FAILED      --enable-->         ENABLED          (explicit retry)
 *   ENABLED     --disable-->        DISABLED
 *               --beginStop-->      STOPPING
 *   STARTING    --completeStart-->  ENABLED
 *               --disable-->        DISABLED         (abort start)
 *   HEALTHY/DEGRADED --disable-->   DISABLED
 *                    --beginStop-> STOPPING
 *   STOPPING    --completeStop-->   DISABLED
 *   any active  --reportHealth-->   HEALTHY | DEGRADED | FAILED
 *   several     --markUnavailable-> UNAVAILABLE      (terminal in V1)
 */

const { REASONS } = require("./errors");

const STATES = Object.freeze({
    DISCOVERED: "DISCOVERED",
    INSTALLED: "INSTALLED",
    DISABLED: "DISABLED",
    ENABLED: "ENABLED",
    STARTING: "STARTING",
    HEALTHY: "HEALTHY",
    DEGRADED: "DEGRADED",
    FAILED: "FAILED",
    STOPPING: "STOPPING",
    UNAVAILABLE: "UNAVAILABLE"
});

const EVENTS = Object.freeze({
    INSTALL: "INSTALL",
    ENABLE: "ENABLE",
    DISABLE: "DISABLE",
    START: "START",
    START_COMPLETE: "START_COMPLETE",
    STOP_BEGIN: "STOP_BEGIN",
    STOP_COMPLETE: "STOP_COMPLETE",
    MARK_UNAVAILABLE: "MARK_UNAVAILABLE"
});

// state -> event -> target state
const TRANSITIONS = Object.freeze({
    [STATES.DISCOVERED]: Object.freeze({
        [EVENTS.INSTALL]: STATES.INSTALLED,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.INSTALLED]: Object.freeze({
        [EVENTS.ENABLE]: STATES.ENABLED,
        [EVENTS.START]: STATES.STARTING,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.DISABLED]: Object.freeze({
        [EVENTS.ENABLE]: STATES.ENABLED,
        [EVENTS.START]: STATES.STARTING,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.ENABLED]: Object.freeze({
        [EVENTS.DISABLE]: STATES.DISABLED,
        [EVENTS.STOP_BEGIN]: STATES.STOPPING,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.STARTING]: Object.freeze({
        [EVENTS.START_COMPLETE]: STATES.ENABLED,
        [EVENTS.DISABLE]: STATES.DISABLED
    }),
    [STATES.HEALTHY]: Object.freeze({
        [EVENTS.DISABLE]: STATES.DISABLED,
        [EVENTS.STOP_BEGIN]: STATES.STOPPING,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.DEGRADED]: Object.freeze({
        [EVENTS.DISABLE]: STATES.DISABLED,
        [EVENTS.STOP_BEGIN]: STATES.STOPPING,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.FAILED]: Object.freeze({
        [EVENTS.ENABLE]: STATES.ENABLED,
        [EVENTS.DISABLE]: STATES.DISABLED,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.STOPPING]: Object.freeze({
        [EVENTS.STOP_COMPLETE]: STATES.DISABLED,
        [EVENTS.MARK_UNAVAILABLE]: STATES.UNAVAILABLE
    }),
    [STATES.UNAVAILABLE]: Object.freeze({})
});

/** States in which the extension is considered functionally active. */
const ACTIVE_STATES = Object.freeze(new Set([
    STATES.ENABLED, STATES.HEALTHY, STATES.DEGRADED
]));

/** States from which a health report is accepted. */
const HEALTH_REPORTABLE_STATES = Object.freeze(new Set([
    STATES.ENABLED, STATES.STARTING, STATES.HEALTHY, STATES.DEGRADED, STATES.FAILED
]));

function nextTarget(state, event) {
    const row = TRANSITIONS[state];
    if (!row) return undefined;
    return row[event];
}

module.exports = {
    STATES,
    EVENTS,
    TRANSITIONS,
    ACTIVE_STATES,
    HEALTH_REPORTABLE_STATES,
    nextTarget,
    REASONS
};
