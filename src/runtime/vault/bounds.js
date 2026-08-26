"use strict";

const { invalidInput } = require("./errors");

/**
 * Central resource bounds. Every bound is a positive safe integer.
 * No unbounded maps, arrays, or histories anywhere in the Vault.
 */

const DEFAULT_VAULT_CONFIG = Object.freeze({
    maxSecrets: 256,
    maxSecretBytes: 64 * 1024,
    maxLabelLength: 128,
    maxMetadataBytes: 4096,
    maxDiagnosticHistory: 200,
    maxScopeKeyLength: 64,
    maxRedactionTrackedValues: 128,
    maxRedactionValueBytes: 4096,
    maxEvidenceImports: 512
});

const CONFIG_KEYS = Object.keys(DEFAULT_VAULT_CONFIG);

function resolveVaultConfig(overrides) {
    if (overrides === undefined || overrides === null) {
        return DEFAULT_VAULT_CONFIG;
    }
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
        throw invalidInput("vault config overrides must be a plain object");
    }
    const merged = { ...DEFAULT_VAULT_CONFIG };
    for (const key of Object.keys(overrides)) {
        if (!CONFIG_KEYS.includes(key)) {
            throw invalidInput("unknown vault config key", key.slice(0, 32));
        }
        merged[key] = overrides[key];
    }
    for (const key of CONFIG_KEYS) {
        const v = merged[key];
        if (!Number.isSafeInteger(v) || v < 1) {
            throw invalidInput(`vault config ${key} must be a positive safe integer`);
        }
    }
    return Object.freeze(merged);
}

module.exports = Object.freeze({
    DEFAULT_VAULT_CONFIG,
    resolveVaultConfig
});
