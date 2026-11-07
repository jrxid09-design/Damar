"use strict";

/**
 * WAVE 6 L3 — public surface (Lane 3: Distributed Capability & Execution Routing).
 *
 * The router sits AFTER the canonical Authority gate. Leases reference
 * authority decisions; they never replace them. REMOTE EXECUTION !=
 * AUTHORITY TRANSFER; UNKNOWN_EXECUTION_STATE never blind-retries.
 *
 * W6-R2-02/R3-01/R4-01: there is NO public authority-bridge factory, NO
 * exported canonical factory, NO installer, and NO first-bind surface. The
 * canonical AuthorityRegistry is constructed + marked + installed exclusively
 * inside `src/authority/canonicalComposition.js` (deep-internal composition
 * closure). Routing resolves authority LIVE at route time against that single
 * module-private owner.
 */

const contracts = require("./contracts");
const { isCanonicalAuthorityBound, getCanonicalAuthorityBridge } = require("./authoritySource");
const { LeaseConsumptionLedger } = require("./leaseLedger");
const authorityAdapter = require("./authorityAdapter");
const { DistributedExecutionRouter, isCanonicalExecutionRouter, PRIVACY_CLASSES, DEFAULT_LOCALITY } = require("./router");

module.exports = Object.freeze({
    contracts,
    // R4-01: installCanonicalAuthorityRegistry is NOT exported here. It lives
    // inside dexec/authoritySource.js and is invoked only by the production
    // composition closure (canonicalComposition.js) which is itself not part
    // of any public/package export surface.
    isCanonicalAuthorityBound,
    LeaseConsumptionLedger,
    authorityAdapter,
    DistributedExecutionRouter,
    isCanonicalExecutionRouter,
    PRIVACY_CLASSES,
    DEFAULT_LOCALITY,
    laws: Object.freeze({
        REMOTE_EXECUTION_NOT_AUTHORITY_TRANSFER: true,
        WORKLOAD_ROUTING_NOT_AUTHORITY_ROUTING: true,
        FAILOVER_NOT_PRIVILEGE_ESCALATION: true,
        LEASE_IS_NOT_AUTHORITY: true,
        UNKNOWN_STATE_NEVER_BLIND_RETRIES: true,
        CALLER_SUPPLIED_BRIDGE_NOT_CANONICAL_AUTHORITY: true,
        SERIALIZED_SECURITY_OBJECT_NOT_LIVE_AUTHORITY: true
    })
});
