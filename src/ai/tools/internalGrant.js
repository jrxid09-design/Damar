"use strict";

// Trusted runtime-only grant domain.  This module is consumed by trusted
// runtime wiring/tests, never by transport, model, channel, or planner code.
const utilTypes = require("util").types;
const grantSet = new WeakSet();
const GRANT_MARKER = Symbol("damar.internalGrant");

function mintCanonicalInternalGrant({ authorizedTools = [], provenance = "runtime", role = "system" } = {}) {
    if (!Array.isArray(authorizedTools)) throw new TypeError("authorizedTools must be an array");
    const scope = Object.freeze([...new Set(authorizedTools.map(name => String(name)))]);
    const grant = Object.freeze({
        role: String(role),
        source: `autonomous:${String(provenance || "runtime").slice(0, 40)}`,
        sessionId: String(provenance || "runtime").slice(0, 60),
        authorizedTools: scope,
        [GRANT_MARKER]: true
    });
    grantSet.add(grant);
    return grant;
}

function isCanonicalInternalGrant(value) {
    if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
    return grantSet.has(value);
}

function isToolAuthorizedByGrant(value, toolName) {
    return isCanonicalInternalGrant(value) &&
        Array.isArray(value.authorizedTools) &&
        value.authorizedTools.includes(String(toolName));
}

module.exports = {
    mintCanonicalInternalGrant,
    isCanonicalInternalGrant,
    isToolAuthorizedByGrant
};
