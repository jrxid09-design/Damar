"use strict";

/**
 * Server Lifecycle State Machine, Admission Control & Bounded Timeout Policy.
 *
 * Distinct lifecycle states:
 *   BOOTING                  - Server socket opened, subsystems being initialized
 *   RUNNING                  - Outermost server and subsystems ready (admission allowed)
 *   SHUTTING_DOWN            - Terminal teardown initiated, admission closed
 *   STOPPED                  - Clean teardown completed successfully (terminal)
 *   SHUTDOWN_FAILED_TERMINAL - Teardown encountered errors (terminal)
 */
const LIFECYCLE_STATES = Object.freeze({
    BOOTING: "BOOTING",
    RUNNING: "RUNNING",
    SHUTTING_DOWN: "SHUTTING_DOWN",
    STOPPED: "STOPPED",
    SHUTDOWN_FAILED_TERMINAL: "SHUTDOWN_FAILED_TERMINAL"
});

const ALLOWED_TRANSITIONS = Object.freeze({
    [LIFECYCLE_STATES.BOOTING]: Object.freeze([
        LIFECYCLE_STATES.RUNNING,
        LIFECYCLE_STATES.SHUTTING_DOWN,
        LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL
    ]),
    [LIFECYCLE_STATES.RUNNING]: Object.freeze([
        LIFECYCLE_STATES.SHUTTING_DOWN
    ]),
    [LIFECYCLE_STATES.SHUTTING_DOWN]: Object.freeze([
        LIFECYCLE_STATES.STOPPED,
        LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL
    ]),
    [LIFECYCLE_STATES.STOPPED]: Object.freeze([]),
    [LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL]: Object.freeze([])
});

const SHUTDOWN_TIMEOUT_MIN_MS = 1000;
const SHUTDOWN_TIMEOUT_MAX_MS = 60000;
const SHUTDOWN_TIMEOUT_DEFAULT_MS = 10000;

function parseShutdownTimeoutMs(rawInput = process.env.DAMAR_SHUTDOWN_TIMEOUT_MS) {
    if (rawInput === undefined || rawInput === null) {
        return SHUTDOWN_TIMEOUT_DEFAULT_MS;
    }
    const str = String(rawInput).trim();
    if (str === "") {
        return SHUTDOWN_TIMEOUT_DEFAULT_MS;
    }
    if (!/^-?\d+$/.test(str)) {
        return SHUTDOWN_TIMEOUT_DEFAULT_MS;
    }
    const val = Number(str);
    if (!Number.isSafeInteger(val)) {
        return SHUTDOWN_TIMEOUT_DEFAULT_MS;
    }
    if (val < SHUTDOWN_TIMEOUT_MIN_MS || val > SHUTDOWN_TIMEOUT_MAX_MS) {
        return SHUTDOWN_TIMEOUT_DEFAULT_MS;
    }
    return val;
}

let currentState = LIFECYCLE_STATES.BOOTING;

function getLifecycleState() {
    return currentState;
}

function transitionLifecycle(nextState) {
    if (!Object.values(LIFECYCLE_STATES).includes(nextState)) {
        const err = new Error(`Invalid lifecycle state: ${nextState}`);
        err.code = "INVALID_LIFECYCLE_STATE";
        throw err;
    }
    const allowed = ALLOWED_TRANSITIONS[currentState] || [];
    if (!allowed.includes(nextState)) {
        const err = new Error(`Illegal lifecycle transition from ${currentState} to ${nextState}`);
        err.code = "ILLEGAL_LIFECYCLE_TRANSITION";
        throw err;
    }
    currentState = nextState;
    return currentState;
}

function setLifecycleState(nextState) {
    return transitionLifecycle(nextState);
}

function isAdmissionAllowed() {
    return currentState === LIFECYCLE_STATES.RUNNING;
}

function resetServerLifecycleForTesting(state = LIFECYCLE_STATES.BOOTING) {
    if (!Object.values(LIFECYCLE_STATES).includes(state)) {
        const err = new Error(`Invalid lifecycle state for testing reset: ${state}`);
        err.code = "INVALID_LIFECYCLE_STATE";
        throw err;
    }
    currentState = state;
}

const resetLifecycleStateForTesting = resetServerLifecycleForTesting;

module.exports = {
    LIFECYCLE_STATES,
    ALLOWED_TRANSITIONS,
    getLifecycleState,
    transitionLifecycle,
    setLifecycleState,
    isAdmissionAllowed,
    resetServerLifecycleForTesting,
    resetLifecycleStateForTesting,
    SHUTDOWN_TIMEOUT_MIN_MS,
    SHUTDOWN_TIMEOUT_MAX_MS,
    SHUTDOWN_TIMEOUT_DEFAULT_MS,
    parseShutdownTimeoutMs
};
