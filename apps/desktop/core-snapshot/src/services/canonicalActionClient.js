"use strict";

/*
 * Legacy service adapters may request an action only when an ingress caller
 * supplies the complete transport/authentication envelope.  This helper does
 * not mint identity, authority, sessions, or execution runtimes.  Missing
 * context is an honest fail-closed denial and never falls back to a direct
 * process launcher.
 */

const { createDamarManager } = require("../manager");

const CONTEXT_KEYS = Object.freeze([
    "channelType", "channelId", "sessionId", "peer", "authProof",
    "continuitySessionId", "continuityContext", "correlationId"
]);

function contextOrNull(context) {
    if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
    for (const key of ["channelType", "channelId", "sessionId"]) {
        if (typeof context[key] !== "string" || context[key].length === 0) return null;
    }
    const out = {};
    for (const key of CONTEXT_KEYS) if (context[key] !== undefined) out[key] = context[key];
    return Object.freeze(out);
}

function contextFromExecution(execution = null) {
    if (execution === null || typeof execution !== "object") return null;
    const source = execution.ingress && typeof execution.ingress === "object"
        ? execution.ingress : execution;
    const channelType = source.channelType ?? source.channel ?? null;
    const channelId = source.channelId ?? source.sessionId ?? null;
    const sessionId = source.sessionId ?? null;
    if (typeof channelType !== "string" || typeof channelId !== "string" || typeof sessionId !== "string") return null;
    return contextOrNull({
        ...source,
        channelType,
        channelId,
        sessionId
    });
}

async function executeCanonicalAction({ context, capabilityId, operation, arguments: parameters = {}, expectedPostcondition = null, signal = null } = {}) {
    const ingress = contextOrNull(context);
    if (!ingress || typeof capabilityId !== "string" || typeof operation !== "string") {
        return Object.freeze({ outcome: "AUTHENTICATION_REQUIRED", effectInvoked: false, reason: "CANONICAL_MANAGER_CONTEXT_REQUIRED" });
    }
    try {
        return await createDamarManager().handle({
            ...ingress,
            requestedOperation: {
                capabilityId,
                operation,
                arguments: parameters,
                ...(expectedPostcondition === null ? {} : { expectedPostcondition })
            }
        }, { signal });
    } catch (error) {
        return Object.freeze({ outcome: "INVALID_REQUEST", effectInvoked: false, reason: String(error?.reasonCode ?? error?.message ?? "CANONICAL_MANAGER_REJECTED") });
    }
}

module.exports = Object.freeze({ executeCanonicalAction, contextFromExecution });
