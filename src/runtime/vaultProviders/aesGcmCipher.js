"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const { invalidInput, VaultError } = require("../vault/errors");

/**
 * PRODUCTION CIPHER PROVIDER — authenticated-encryption-at-rest boundary
 * (Trust Foundation stage, Wave 5 Lane 4).
 *
 * This is a PLATFORM PROVIDER implementing the Vault's EXISTING
 * CipherAdapter contract (src/runtime/vault/cipher.js).  The Vault core
 * deliberately invents NO cryptography and forbids crypto primitives inside
 * its own structural boundary (tests/vault/structural.test.js); the secure
 * adapter therefore lives HERE, at the provider layer the Vault's contract
 * names ("platform providers … implement it").  It is the secure counterpart
 * to the explicitly-insecure deterministic test adapter — it does NOT
 * replace the Vault, the store, or the cipher boundary.
 * test adapter.  It implements the EXISTING CipherAdapter contract
 * (cipher.js) — it does NOT replace the Vault, the store, or the cipher
 * boundary; it is one production adapter behind that existing boundary.
 *
 * LAW:
 *   - VAULT STORAGE != OWNER IDENTITY.
 *   - This adapter owns ONLY the cipher boundary.  How the canonical
 *     runtime obtains master protection material is decided by a LATER
 *     Owner Trust stage, NOT here.
 *
 * CRYPTOGRAPHY (node:crypto only — no new framework):
 *   - AES-256-GCM (AEAD): confidentiality + integrity in one primitive.
 *   - RANDOM 12-byte IV per envelope (never reused; envelopes for the
 *     same plaintext differ).
 *   - 16-byte GCM authentication tag: any tampering, truncation, or
 *     wrong-key decryption fails closed (GCM auth failure).
 *   - The version tag is bound as AAD so a foreign/rolled-back envelope
 *     version cannot be substituted.
 *
 * ENVELOPE (JSON-serializable, versioned for future migration):
 *   { k: "aead-gcm-v1", iv: <b64 12B>, tag: <b64 16B>, d: <b64 ct> }
 *
 * MASTER KEY PROVENANCE (sealed — NEVER hard-coded, NEVER committed):
 *   The 32-byte key is supplied by a sealed runtime provider.  This
 *   adapter does NOT invent a keystore; it resolves key material from,
 *   in priority order:
 *     1. options.keyMaterial  — Buffer (32B) or hex/base64 string
 *     2. options.keyFile      — path to a 0o600 file holding the key
 *     3. process.env.DAMAR_VAULT_MASTER_KEY — hex/base64 string
 *   If NO usable key material is available, construction FAILS CLOSED
 *   (throws) rather than falling back to any insecure deterministic key.
 *   There is deliberately NO insecure fallback.
 *
 * SECRET HYGIENE:
 *   - No plaintext secret is ever written to durable storage (only the
 *     envelope is persisted by the store).
 *   - Thrown errors NEVER contain key material, plaintext, or ciphertext.
 *   - Nothing here logs secret values.
 */

const ENVELOPE_KIND = "aead-gcm-v1";
const KEY_BYTES = 32;   // AES-256
const IV_BYTES = 12;    // GCM standard nonce
const TAG_BYTES = 16;   // GCM auth tag

function fail(code, message) {
    return new VaultError(code, message);
}

/** Strictly validate + normalize supplied key material to a 32-byte Buffer. */
function coerceKeyMaterial(raw, source) {
    let buf = null;
    if (Buffer.isBuffer(raw)) {
        buf = raw;
    } else if (typeof raw === "string" && raw.length > 0) {
        const trimmed = raw.trim();
        // Accept hex (64 chars) or base64.
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            buf = Buffer.from(trimmed, "hex");
        } else {
            try { buf = Buffer.from(trimmed, "base64"); } catch { buf = null; }
        }
    }
    if (!Buffer.isBuffer(buf) || buf.length !== KEY_BYTES) {
        throw fail("VAULT_CIPHER_REQUIRED",
            `vault production cipher: key material from ${source} must decode to exactly ${KEY_BYTES} bytes`);
    }
    return buf;
}

/**
 * Resolve sealed master key material from the supported providers.
 * Returns a 32-byte Buffer or throws VAULT_CIPHER_REQUIRED when the
 * production cipher is requested but no secure key material is available.
 */
function resolveKeyMaterial(options) {
    if (options.keyMaterial !== undefined && options.keyMaterial !== null) {
        return coerceKeyMaterial(options.keyMaterial, "keyMaterial option");
    }
    if (typeof options.keyFile === "string" && options.keyFile.length > 0) {
        let raw;
        try {
            raw = fs.readFileSync(options.keyFile, "utf8");
        } catch {
            throw fail("VAULT_CIPHER_REQUIRED",
                "vault production cipher: key file is unreadable");
        }
        return coerceKeyMaterial(raw, "key file");
    }
    const fromEnv = process.env.DAMAR_VAULT_MASTER_KEY;
    if (typeof fromEnv === "string" && fromEnv.length > 0) {
        return coerceKeyMaterial(fromEnv, "DAMAR_VAULT_MASTER_KEY");
    }
    throw fail("VAULT_CIPHER_REQUIRED",
        "vault production cipher requested but no secure key material is " +
        "available (keyMaterial / keyFile / DAMAR_VAULT_MASTER_KEY).  " +
        "Refusing to fall back to insecure deterministic encryption.");
}

/**
 * createProductionCipherAdapter(options)
 *
 * Build the secure AES-256-GCM CipherAdapter.  Construction FAILS CLOSED
 * when no usable key material is available.  `secure: true` is reported
 * ONLY because real AEAD protection is in effect with caller-supplied key
 * material (never a deterministic embedded key).
 *
 * @param {object} [options]
 * @param {Buffer|string} [options.keyMaterial]
 * @param {string} [options.keyFile]
 */
function createProductionCipherAdapter(options = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw invalidInput("production cipher options must be an object");
    }
    const key = resolveKeyMaterial(options);

    const adapter = {
        id: "aead-gcm-v1",
        secure: true,
        guarantees:
            "AES-256-GCM authenticated encryption at rest: random per-envelope " +
            "IV, confidentiality + integrity, wrong-key/tamper fails closed. " +
            "Key material is sealed-runtime-supplied (never stored by the vault).",
        encrypt(clearBuffer) {
            const iv = crypto.randomBytes(IV_BYTES);
            const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(Buffer.from(ENVELOPE_KIND, "utf8"));
            const ct = Buffer.concat([cipher.update(clearBuffer), cipher.final()]);
            const tag = cipher.getAuthTag();
            return {
                k: ENVELOPE_KIND,
                iv: iv.toString("base64"),
                tag: tag.toString("base64"),
                d: ct.toString("base64")
            };
        },
        decrypt(envelope) {
            // Structural validation ONLY; no secret material in any error.
            if (envelope.k !== ENVELOPE_KIND) {
                throw invalidInput("cipher envelope version unsupported");
            }
            let iv, tag, ct;
            try {
                iv = Buffer.from(envelope.iv, "base64");
                tag = Buffer.from(envelope.tag, "base64");
                ct = Buffer.from(envelope.d, "base64");
            } catch {
                throw invalidInput("cipher envelope malformed");
            }
            if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
                throw invalidInput("cipher envelope malformed");
            }
            try {
                const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
                decipher.setAAD(Buffer.from(ENVELOPE_KIND, "utf8"));
                decipher.setAuthTag(tag);
                return Buffer.concat([decipher.update(ct), decipher.final()]);
            } catch {
                // GCM auth failure: wrong key OR tampered/truncated ciphertext.
                // Fail closed with NO detail about which, and NO secret bytes.
                throw fail("VAULT_STORE_FAILURE",
                    "cipher envelope integrity check failed");
            }
        }
    };

    // Hand the raw key to the adapter closure only; it is never exposed on
    // the returned object, never logged, and never written to storage.
    return adapter;
}

module.exports = Object.freeze({
    createProductionCipherAdapter,
    ENVELOPE_KIND,
    KEY_BYTES
});
