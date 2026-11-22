"use strict";

/**
 * Damar Secret Vault V1 — CORE SUBSTRATE.
 *
 * CONSTITUTIONAL INVARIANT: SECRETS != AUTHORITY.
 * Possession of a credential never implies permission to act. This
 * subsystem stores pointers and values; it grants no capability,
 * ratifies no action, authorizes no tool or device, and never mutates
 * Authority state. Components holding credentials still require
 * canonical Authority for any Damar action where Authority applies.
 *
 * STORAGE GUARANTEES: values are persisted only as cipher-adapter
 * envelopes. No cryptography is invented here; platform adapters
 * (e.g., Windows DPAPI bridges) implement the CipherAdapter contract.
 * Adapters that do not protect at rest must be acknowledged explicitly
 * (`allowInsecure:true`) and are reported as PLAINTEXT-INSECURE in
 * every storage description. The deterministic test adapter is NOT
 * secure and exists so tests have a working boundary without pretending.
 */

const { createSecretVault } = require("./vault");
const ids = require("./ids");
const refs = require("./ref");
const scopeMod = require("./scope");
const valueMod = require("./value");
const metadata = require("./metadata");
const record = require("./record");
const digest = require("./digest");
const bounds = require("./bounds");
const cipherMod = require("./cipher");
const storeMod = require("./store");
const errors = require("./errors");
const redact = require("./redact");
const diagnostics = require("./diagnostics");

module.exports = Object.freeze({
    createSecretVault,

    // Identity / reference layer
    ids,
    refs,
    scope: scopeMod,

    // Value layer (defensive redaction container)
    SecretValue: valueMod.SecretValue,
    isSecretValue: valueMod.isSecretValue,
    REDACTED_MARKER: valueMod.REDACTED_MARKER,

    // Metadata / records
    metadata,
    record,
    digest,
    bounds,

    // Storage boundary
    cipher: cipherMod,
    store: storeMod,

    // Safety rails
    errors,
    redact,
    diagnostics
});
