"use strict";

/**
 * Recovery Capsule manifest + wire format.
 *
 * A capsule on the wire is an UNTRUSTED object:
 *   {
 *     manifest: {...},          // described by buildManifestMaterial
 *     sections: { [sectionId]: { schemaVersion, data } }
 *   }
 *
 * The manifest digest covers canonical manifest material (R6). Section
 * digests cover canonical bytes of each section payload. Nothing here is
 * trusted until validateCapsule() re-derives every digest and runs the
 * semantic provider validation.
 */

const CAPSULE_FORMAT_VERSION = 1;

const CAPSULE_STATUS = Object.freeze({
    BUILDING: "BUILDING",
    COMPLETE: "COMPLETE",
    INVALID: "INVALID",
    INCOMPATIBLE: "INCOMPATIBLE"
});

const CHECKPOINT_REASONS = Object.freeze([
    "MANUAL",
    "SCHEDULED",
    "PRE_UPGRADE",
    "SHUTDOWN",
    "OPERATOR_REQUESTED",
    "TEST"
]);

function buildManifestMaterial({
    capsuleId,
    parentCapsuleId,
    epochId,
    runtimeGenerationId,
    createdAtMs,
    reason,
    status,
    sections
}) {
    return {
        capsuleFormatVersion: CAPSULE_FORMAT_VERSION,
        capsuleId,
        parentCapsuleId: parentCapsuleId ?? null,
        epochId,
        runtimeGenerationId,
        createdAtMs,
        reason,
        status,
        sections: [...sections].sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1)).map((s) => ({
            sectionId: s.sectionId,
            schemaVersion: s.schemaVersion,
            classification: s.classification,
            required: s.required,
            byteLength: s.byteLength,
            digest: s.digest
        }))
    };
}

module.exports = Object.freeze({
    CAPSULE_FORMAT_VERSION,
    CAPSULE_STATUS,
    CHECKPOINT_REASONS,
    buildManifestMaterial
});
