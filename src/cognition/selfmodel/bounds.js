"use strict";

/**
 * W7-L1 SELF-MODEL — batas eksplisit (spec §9, provisional; doc 53 prep
 * adalah otoritatif untuk revisi nanti).
 */

const SCHEMA_VERSION = "selfmodel.v1";
const ASSESSMENT_SCHEMA_VERSION = "selfmodel.capabilityAssessment.v1";

const BOUNDS = Object.freeze({
    MAX_CAPABILITY_ASSESSMENTS: 2048,
    MAX_SUCCESS_WINDOW: 32,
    MAX_UNKNOWNS: 256,
    MAX_ACTIVE_LIMITATIONS: 128,
    MAX_DEGRADED_SUBSYSTEMS: 64,
    MAX_KNOWN_NODES: 256,
    MAX_SNAPSHOT_BYTES: 262144,
    SNAPSHOT_TTL_MS: 5000,
    AVAILABILITY_TTL_MS: 30000,
    MAX_FUTURE_SKEW_MS: 5000
});

module.exports = { SCHEMA_VERSION, ASSESSMENT_SCHEMA_VERSION, BOUNDS };
