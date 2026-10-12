"use strict";

/*
 * Legacy service callers are adapters, never authority owners.  A service
 * effect must be admitted by the canonical Manager before any lower-level
 * service is touched.  This module intentionally has no fallback executor.
 */
const { executeCanonicalAction, contextFromExecution } = require("./canonicalActionClient");

async function submitGovernedService({ execution = null, context = null, capabilityId, operation, arguments: parameters = {}, expectedPostcondition = null } = {}) {
    const ingress = context ?? contextFromExecution(execution);
    return executeCanonicalAction({
        context: ingress,
        capabilityId,
        operation,
        arguments: parameters,
        expectedPostcondition
    });
}

function isCompleted(result) {
    return Boolean(result && result.outcome === "COMPLETED");
}

module.exports = Object.freeze({ submitGovernedService, isCompleted });
