"use strict";

/**
 * WAVE 6 L3 — public surface (Lane 3: Distributed Capability & Execution Routing).
 *
 * The router sits AFTER the canonical Authority gate. Leases reference
 * authority decisions; they never replace them. REMOTE EXECUTION !=
 * AUTHORITY TRANSFER; UNKNOWN_EXECUTION_STATE never blind-retries.
 *
 * W6-R2-02: there is NO public authority-bridge factory. Authority
 * provenance is bound exactly once by the canonical bootstrap through
 * `bindCanonicalAuthorityRegistry` (brand-checked against the canonical
 * AuthorityRegistry owner) and resolved LIVE at route time.
 */

const contracts = require("./contracts");
const { bindCanonicalAuthorityRegistry, isCanonicalAuthorityBound, getCanonicalAuthorityBridge } = require("./authoritySource");
const { LeaseConsumptionLedger } = require("./leaseLedger");
const authorityAdapter = require("./authorityAdapter");
const { DistributedExecutionRouter, isCanonicalExecutionRouter, PRIVACY_CLASSES, DEFAULT_LOCALITY } = require("./router");

module.exports = Object.freeze({
    contracts,
    // W6-R2-02: canonical authority binding (bootstrap-owned) — the
    // module-private bridge getter is NOT exported; consumers bind the
    // canonical registry and construct routers (or use the canonical
    // RuntimeHost composition).
    bindCanonicalAuthorityRegistry,
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
