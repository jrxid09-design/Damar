"use strict";

/**
 * WAVE 6 L7 — public surface (Governed Evolution & Continuous Self-Improvement).
 */

const evo = require("./evolution");

module.exports = Object.freeze({
    ...evo,
    laws: Object.freeze({
        SELF_IMPROVEMENT_NOT_SELF_AUTHORIZATION: true,
        EVOLUTION_PROPOSAL_NOT_EVOLUTION_APPROVAL: true,
        LEARNED_BEHAVIOR_NOT_POLICY_CHANGE: true,
        SHADOW_NEVER_CONTROLS_ACTIONS: true,
        CANARY_REQUIRES_APPROVED_PROPOSAL: true,
        ROLLBACK_ALWAYS_AVAILABLE: true,
        NO_PARALLEL_EVOLUTION_AUTHORITY: true
    })
});
