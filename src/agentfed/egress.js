"use strict";

const ALWAYS_REDACTED = new Set(["internalState", "ownerToken", "authToken", "secret"]);

function redactEgress(payload, ownerAllowList = []) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const result = {};
    for (const [k, v] of Object.entries(payload)) {
        result[k] = (ALWAYS_REDACTED.has(k) && !ownerAllowList.includes(k)) ? "[REDACTED]" : v;
    }
    return result;
}

function makeEgress() {
    function send(agentId, payload, { ownerAllowList = [] } = {}) {
        return redactEgress(payload, ownerAllowList);
    }
    return { send };
}

module.exports = { makeEgress, redactEgress };
