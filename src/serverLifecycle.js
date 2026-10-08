"use strict";

/**
 * Server Lifecycle State Machine & Admission Control.
 *
 * Distinct lifecycle states:
 *   BOOTING                  - Server socket opened, subsystems being initialized
 *   RUNNING                  - Outermost server and subsystems ready
 *   SHUTTING_DOWN            - Terminal teardown initiated, admission closed
 *   STOPPED                  - Clean teardown completed successfully
 *   SHUTDOWN_FAILED_TERMINAL - Teardown encountered errors, terminal failure
 */
const LIFECYCLE_STATES = Object.freeze({
    BOOTING: "BOOTING",
    RUNNING: "RUNNING",
    SHUTTING_DOWN: "SHUTTING_DOWN",
    STOPPED: "STOPPED",
    SHUTDOWN_FAILED_TERMINAL: "SHUTDOWN_FAILED_TERMINAL"
});

let currentState = LIFECYCLE_STATES.BOOTING;

function getLifecycleState() {
    return currentState;
}

function setLifecycleState(nextState) {
    currentState = nextState;
}

function isAdmissionAllowed() {
    return currentState === LIFECYCLE_STATES.BOOTING || currentState === LIFECYCLE_STATES.RUNNING;
}

function resetLifecycleStateForTesting(state = LIFECYCLE_STATES.BOOTING) {
    currentState = state;
}

module.exports = {
    LIFECYCLE_STATES,
    getLifecycleState,
    setLifecycleState,
    isAdmissionAllowed,
    resetLifecycleStateForTesting
};
