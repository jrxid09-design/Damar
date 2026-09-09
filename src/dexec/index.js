"use strict";

/**
 * WAVE 6 L3 — public surface (Lane 3: Distributed Capability & Execution Routing).
 *
 * The router sits AFTER the canonical Authority gate. Leases reference
 * authority decisions; they never replace them. REMOTE EXECUTION !=
 * AUTHORITY TRANSFER; UNKNOWN_EXECUTION_STATE never blind-retries.
 */

const contracts = require("./contracts");
const { createCanonicalAuthorityBridge } = require("./authorityBridge");
const { LeaseConsumptionLedger } = require("./leaseLedger");
const authorityAdapter = require("./authorityAdapter");
const { DistributedExecutionRouter, PRIVACY_CLASSES, DEFAULT_LOCALITY } = require("./router");

module.exports = Object.freeze({
    contracts,
    createCanonicalAuthorityBridge,
    LeaseConsumptionLedger,
    authorityAdapter,
    DistributedExecutionRouter,
    PRIVACY_CLASSES,
    DEFAULT_LOCALITY,
    laws: Object.freeze({
        REMOTE_EXECUTION_NOT_AUTHORITY_TRANSFER: true,
        WORKLOAD_ROUTING_NOT_AUTHORITY_ROUTING: true,
        FAILOVER_NOT_PRIVILEGE_ESCALATION: true,
        LEASE_IS_NOT_AUTHORITY: true,
        UNKNOWN_STATE_NEVER_BLIND_RETRIES: true
    })
});
