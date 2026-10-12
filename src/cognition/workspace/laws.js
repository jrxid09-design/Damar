"use strict";

const LAWS = Object.freeze({
    WORKSPACE_HOLDS_REFS_ONLY: true,
    NO_PRIVILEGED_OBJECTS: true,
    SINGLE_FOCUS: true,
    EVICTION_IS_AUDITED: true,
    DEDUP_REQUIRED: true,
});

// Kinds that represent authority objects — forbidden in workspace (W10-L1/RT-W10-02)
const PRIVILEGED_KINDS = new Set(["authority", "policy", "capability", "grant", "permission", "auth"]);

module.exports = { LAWS, PRIVILEGED_KINDS };
