"use strict";

/**
 * Section trust classification (R14).
 *
 * PUBLIC_STATE / INTERNAL_STATE : normally checkpointable + restorable.
 * AUTHORITY_SENSITIVE           : checkpointed as OPAQUE data only.
 *                                 Recovery never interprets it; the future
 *                                 Authority subsystem must revalidate before
 *                                 any trust decision. Restoring it grants nothing.
 * EPHEMERAL                     : not checkpointed unless explicitly allowed.
 * NON_RESUMABLE                 : may be journaled as evidence but is NEVER
 *                                 automatically resumed. Recovers as
 *                                 INTERRUPTED / REQUIRES_REVALIDATION.
 */

const SECTION_CLASSIFICATION = Object.freeze({
    PUBLIC_STATE: "PUBLIC_STATE",
    INTERNAL_STATE: "INTERNAL_STATE",
    AUTHORITY_SENSITIVE: "AUTHORITY_SENSITIVE",
    EPHEMERAL: "EPHEMERAL",
    NON_RESUMABLE: "NON_RESUMABLE"
});

const CLASSIFICATION_VALUES = Object.freeze(
    Object.values(SECTION_CLASSIFICATION)
);

function isClassification(v) {
    return CLASSIFICATION_VALUES.includes(v);
}

/** Whether a classification may be captured at all under config. */
function isCheckpointable(classification, config) {
    if (classification === SECTION_CLASSIFICATION.EPHEMERAL) {
        return config.allowEphemeralCheckpoint === true;
    }
    return true;
}

/**
 * Whether a section may enter automatic prepare/commit restore.
 * AUTHORITY_SENSITIVE sections are opaque data: they may be materialized
 * into a restricted quarantine context by the caller, never auto-committed
 * into live interpretation by Recovery itself.
 */
function isAutoRestorable(classification) {
    return (
        classification === SECTION_CLASSIFICATION.PUBLIC_STATE ||
        classification === SECTION_CLASSIFICATION.INTERNAL_STATE
    );
}

module.exports = Object.freeze({
    SECTION_CLASSIFICATION,
    CLASSIFICATION_VALUES,
    isClassification,
    isCheckpointable,
    isAutoRestorable
});
