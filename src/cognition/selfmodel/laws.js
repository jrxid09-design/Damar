"use strict";

/**
 * W7-L1 SELF-MODEL — pernyataan struktural invarian yang ditegakkan
 * (konvensi rumah: `laws` yang bisa di-grep, bukan dekorasi).
 */
const laws = Object.freeze({
    SELF_MODEL_NOT_AUTHORITY: true,
    SELF_BELIEF_NOT_FACT: true,
    SELF_ASSESSMENT_MUST_CITE_SOURCE: true,
    CAPABILITY_AVAILABILITY_NOT_AUTHORITY: true,
    UNKNOWN_NEVER_PROMOTED_WITHOUT_EVIDENCE: true,
    NODE_PRESENCE_NOT_CAPABILITY_AUTHORITY: true,
    RESTART_NEVER_RESTORES_AVAILABILITY_FRESH: true,
    DENIED_EVALUATION_NEVER_CHANGES_SELF_BELIEF: true
});

module.exports = { laws };
