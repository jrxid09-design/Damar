"use strict";

/**
 * DCD PRODUCTION LAW CONSTANTS
 *
 * Re-exports the DC-* law constants from the production contracts module.
 * Also declares the security constraint invariants from the DCD Master
 * Execution Contract (§12) as frozen law objects.
 *
 * These are GREPPABLE constants, not executable rules. The enforcement
 * lives in the plane modules and in the canonical authority substrate.
 *
 * Inherited Damar invariants (I-*) are NOT redeclared here; they remain
 * in the authority/governance substrate and DCD must not weaken them.
 */

const { laws: dcLaws } = require("./contracts");

// §12 security constraints — verbatim from Master Execution Contract
const SECURITY_CONSTRAINTS = Object.freeze({
    DETECTION_NEQ_AUTHORITY:            true,
    INCIDENT_CONFIRMED_NEQ_AUTHORIZED:  true,
    THREAT_SCORE_NEQ_AUTHORITY:         true,
    SECURITY_AGENT_NEQ_AUTHORITY:       true,
    VULNERABILITY_NEQ_EXPLOIT_AUTH:     true,
    SIMULATION_NEQ_EXECUTION:           true,
    TOOL_NEQ_AUTHORITY:                 true,
    KALI_NEQ_AUTHORITY:                 true,
    MODEL_OUTPUT_NEQ_AUTHORITY:         true,
    CAPABILITY_AVAILABLE_NEQ_AUTHORITY: true,
    CAPABILITY_REGISTERED_NEQ_AUTHORITY:true,
    VALID_ALERT_NEQ_AUTHORITY:          true,
    VALID_SIGNATURE_NEQ_AUTHORITY:      true,
    FORENSIC_EVIDENCE_NEQ_AUTHORITY:    true,
    AUDIT_RECORD_NEQ_AUTHORITY:         true,
    REPLAY_CACHE_NEQ_REPLAY_AUTHORITY:  true,
    UNCERTAIN_PRIOR_NEQ_SAFE_TO_RETRY:  true,
    OWNER_POLICY_DENY_UNTIL_RATIFIED:   true,
});

// DCD may recommend/detect/analyze/simulate/prepare ActionIntent.
// DCD may NOT self-authorize consequential execution.
const AUTHORITY_POSTURE = Object.freeze({
    DCD_RECOMMENDS_NEVER_AUTHORIZES:    true,
    NO_DIRECT_DCD_TO_SHELL:             true,
    NO_DIRECT_DCD_TO_KALI:              true,
    NO_DIRECT_DCD_TO_EXECUTOR:          true,
    NO_DIRECT_DCD_TO_NETWORK:           true,
    KALI_GOVERNED_CAPABILITY_ONLY:      true,
    CANONICAL_AUTHORITY_PATH_REQUIRED:  true,
});

module.exports = Object.freeze({
    dcLaws,
    SECURITY_CONSTRAINTS,
    AUTHORITY_POSTURE,
});
