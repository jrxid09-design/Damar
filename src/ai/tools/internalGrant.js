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

    function registerExec(exec) {
        if (exec === null || typeof exec !== "object" || utilTypes.isProxy(exec)) return null;
        const capSet = exec.capabilitySet;
        const scope = Array.isArray(capSet) ? Object.freeze([...capSet]) : Object.freeze([]);
        grantSet.add(exec);
        scopeByGrant.set(exec, scope);
        return exec;
    }

    // P1-H-FIX: adopt a grant minted by another domain so cross-boundary
    // isCanonicalInternalGrant checks pass. Grants minted by per-executor
    // domains must also live in the global singleton WeakSet.
    function registerGrant(grant, authorizedTools) {
        if (grant === null || typeof grant !== "object" || utilTypes.isProxy(grant)) return;
        const scope = Object.freeze([...new Set((authorizedTools ?? []).map(n => String(n)))]);
        grantSet.add(grant);
        scopeByGrant.set(grant, scope);
    }

    return Object.freeze({ mintCanonicalInternalGrant, isCanonicalInternalGrant, isToolAuthorizedByGrant, registerExec, registerGrant });
}

const _singleton = createInternalGrantDomain();

module.exports = {
    createInternalGrantDomain,
    mintCanonicalInternalGrant: (opts) => _singleton.mintCanonicalInternalGrant(opts),
    isCanonicalInternalGrant: (value) => _singleton.isCanonicalInternalGrant(value),
    isToolAuthorizedByGrant: (value, toolName) => _singleton.isToolAuthorizedByGrant(value, toolName),
    registerGrant: (grant, authorizedTools) => _singleton.registerGrant(grant, authorizedTools)
};
