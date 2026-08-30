"use strict";

const utilTypes = require("util").types;

function createInternalGrantDomain() {
    const grantSet = new WeakSet();
    const scopeByGrant = new WeakMap();

    function mintCanonicalInternalGrant({ authorizedTools = [], provenance = "runtime", role = "system" } = {}) {
        if (!Array.isArray(authorizedTools)) throw new TypeError("authorizedTools must be an array");
        const scope = Object.freeze([...new Set(authorizedTools.map(name => String(name)))]);
        const grant = Object.freeze({
            role: String(role),
            source: `autonomous:${String(provenance || "runtime").slice(0, 40)}`,
            sessionId: String(provenance || "runtime").slice(0, 60)
        });
        grantSet.add(grant);
        scopeByGrant.set(grant, scope);
        return grant;
    }

    function isCanonicalInternalGrant(value) {
        return value !== null && typeof value === "object" &&
            !utilTypes.isProxy(value) && grantSet.has(value);
    }

    function isToolAuthorizedByGrant(value, toolName) {
        return isCanonicalInternalGrant(value) &&
            scopeByGrant.get(value)?.includes(String(toolName)) === true;
    }

    return Object.freeze({ mintCanonicalInternalGrant, isCanonicalInternalGrant, isToolAuthorizedByGrant });
}

module.exports = { createInternalGrantDomain };
