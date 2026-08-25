"use strict";

/**
 * Central resource bounds (R18). Every bound is a positive safe integer.
 * No unbounded arrays or maps anywhere in Recovery.
 */

const DEFAULT_RECOVERY_CONFIG = Object.freeze({
    maxCapsuleBytes: 4 * 1024 * 1024,
    maxSectionBytes: 512 * 1024,
    maxSections: 16,
    maxCandidateCapsules: 16,
    maxDiagnostics: 200,
    maxLineageDepth: 64,
    maxProviderCount: 32,
    maxMetadataKeys: 32,
    maxMetadataStringLength: 512,
    maxCheckpointReasonLength: 256,
    allowEphemeralCheckpoint: false
});

const CONFIG_KEYS = Object.keys(DEFAULT_RECOVERY_CONFIG);
const NUMERIC_KEYS = CONFIG_KEYS.filter((k) => k !== "allowEphemeralCheckpoint");

function resolveRecoveryConfig(overrides) {
    if (overrides === undefined || overrides === null) {
        return DEFAULT_RECOVERY_CONFIG;
    }
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new TypeError("recovery config overrides must be a plain object");
    }
    const merged = { ...DEFAULT_RECOVERY_CONFIG };
    for (const key of Object.keys(overrides)) {
        if (!CONFIG_KEYS.includes(key)) {
            throw new RangeError(`unknown recovery config key: ${key}`);
        }
        merged[key] = overrides[key];
    }
    for (const key of NUMERIC_KEYS) {
        const v = merged[key];
        if (!Number.isSafeInteger(v) || v < 1) {
            throw new RangeError(`recovery config ${key} must be a positive safe integer`);
        }
    }
    if (typeof merged.allowEphemeralCheckpoint !== "boolean") {
        throw new TypeError("allowEphemeralCheckpoint must be boolean");
    }
    return Object.freeze(merged);
}

module.exports = Object.freeze({
    DEFAULT_RECOVERY_CONFIG,
    resolveRecoveryConfig
});
