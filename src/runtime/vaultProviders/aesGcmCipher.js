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

/** TF-006: strict canonical Base64 decode — reject any invalid/ignored
 *  characters (including surrounding whitespace) instead of silently
 *  tolerating them. */
function decodeBase64Strict(text) {
    if (typeof text !== "string") return null;
    // No trimming-then-accept: any leading/trailing whitespace or junk is a
    // rejection, not a silent normalization.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
        return null;
    }
    let buf;
    try {
        buf = Buffer.from(text, "base64");
    } catch {
        return null;
    }
    // Round-trip check: re-encoding must reproduce the canonical input
    // (guards against silently dropped invalid characters).
    if (buf.toString("base64") !== text) {
        return null;
    }
    return buf;
}

/** TF-006: defensive copy so caller mutation cannot alter the active key,
 *  with a best-effort zeroization of the temporary source buffer. */
function defensiveKeyCopy(buf) {
    const copy = Buffer.allocUnsafe(KEY_BYTES);
    buf.copy(copy, 0, 0, KEY_BYTES);
    return copy;
}

/** Strictly validate + normalize supplied key material to a 32-byte Buffer. */
function coerceKeyMaterial(raw, source) {
    let buf = null;
    if (Buffer.isBuffer(raw)) {
        buf = raw;
    } else if (typeof raw === "string" && raw.length > 0) {
        // Reject surrounding whitespace/junk outright (TF-006): only a clean
        // hex string or a clean canonical Base64 string is acceptable.
        if (raw !== raw.trim()) {
            buf = null;
        } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
            buf = Buffer.from(raw, "hex");
        } else {
            buf = decodeBase64Strict(raw);
        }
    }
    if (!Buffer.isBuffer(buf) || buf.length !== KEY_BYTES) {
        throw fail("VAULT_CIPHER_REQUIRED",
            `vault production cipher: key material from ${source} must decode to exactly ${KEY_BYTES} bytes`);
    }
    const key = defensiveKeyCopy(buf);
    // Best-effort zeroization of the temporary decoded buffer.
    try { buf.fill(0); } catch { /* best-effort */ }
    return key;
}

/**
 * TF-005 KEY-FILE PROTECTION (honest platform behavior).
 *
 * POSIX: the key file MUST be a regular file with no group/world access
 * (mode bits must not include 0o077).  Unsafe protection fails closed.
 *
 * Windows: POSIX mode bits are NOT an ACL and do NOT prove protection.
 * We do NOT falsely claim POSIX mode == ACL protection.  A Windows key
 * file is therefore GATED: it is accepted ONLY when the caller explicitly
 * acknowledges the platform protection is externally managed
 * (options.allowPlatformManagedKeyFile === true); otherwise it fails
 * closed and the caller must use a separately trusted runtime key
 * provider (keyMaterial / DAMAR_VAULT_MASTER_KEY).  We do not invent
 * insecure ACL parsing.
 */
function assertKeyFileProtection(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        throw fail("VAULT_CIPHER_REQUIRED",
            `vault production cipher: key file is unreadable (${error.code ?? "IO"})`);
    }
    if (!stat.isFile()) {
        throw fail("VAULT_CIPHER_REQUIRED",
            "vault production cipher: key path is not a regular file");
    }
    if (process.platform !== "win32") {
        // POSIX: reject group/world-readable key files.
        const mode = stat.mode & 0o777;
        if ((mode & 0o077) !== 0) {
            throw fail("VAULT_CIPHER_REQUIRED",
                "vault production cipher: key file is group/world-accessible " +
                `(mode ${mode.toString(8)}); refusing unsafe protection`);
        }
    }
    return stat;
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
        // TF-005 Windows gating: a Windows key file is accepted only when
        // the caller explicitly qualifies it as externally managed.
        if (process.platform === "win32" && options.allowPlatformManagedKeyFile !== true) {
            throw fail("VAULT_CIPHER_REQUIRED",
                "vault production cipher: keyFile on Windows is not accepted " +
                "without allowPlatformManagedKeyFile:true (POSIX mode is not " +
                "ACL protection).  Use a separately trusted runtime key provider.");
        }
        assertKeyFileProtection(options.keyFile);
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
