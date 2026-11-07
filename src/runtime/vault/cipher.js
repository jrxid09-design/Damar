"use strict";

const { invalidInput } = require("./errors");

/**
 * CipherAdapter — the encryption-at-rest boundary of the Vault.
 *
 * LAW: the vault invents NO cryptography. It defines an adapter
 * contract; platform providers (e.g., Windows DPAPI via a host
 * process, OS keychains, or future KMS bridges) implement it.
 *
 * Adapter contract:
 *   id            — stable adapter name
 *   secure        — TRUE only for adapters with real at-rest protection
 *   guarantees    — human-readable statement shown in storage reports
 *   encrypt(clear: Buffer) -> envelope: object   (JSON-serializable)
 *   decrypt(envelope: object) -> Buffer
 *
 * The reference "deterministic-test" adapter is NOT secure; it exists
 * so tests and local development have a working boundary without
 * pretending plaintext is protected.
 */

function assertEnvelopeSerializable(envelope) {
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        throw invalidInput("cipher envelope must be a plain object");
    }
    try {
        JSON.stringify(envelope);
    } catch (_) {
        throw invalidInput("cipher envelope must be JSON-serializable");
    }
    return envelope;
}

/**
 * Validates an adapter's shape. Does not vouch for its security —
 * that is what `secure` and `guarantees` declare, and callers must
 * not treat a loaded adapter as audited crypto.
 */
function assertCipherAdapter(adapter) {
    if (typeof adapter !== "object" || adapter === null || Array.isArray(adapter)) {
        throw invalidInput("cipher adapter must be an object");
    }
    const { id, secure, guarantees, encrypt, decrypt } = adapter;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
        throw invalidInput("cipher adapter id invalid");
    }
    if (typeof secure !== "boolean") {
        throw invalidInput("cipher adapter must declare secure:boolean");
    }
    if (typeof guarantees !== "string" || guarantees.length === 0 || guarantees.length > 512) {
        throw invalidInput("cipher adapter must declare guarantees text");
    }
    if (typeof encrypt !== "function" || typeof decrypt !== "function") {
        throw invalidInput("cipher adapter must implement encrypt/decrypt");
    }
    return Object.freeze({
        id,
        secure,
        guarantees,
        encrypt(clearBuffer) {
            if (!Buffer.isBuffer(clearBuffer)) {
                throw invalidInput("encrypt requires a Buffer");
            }
            return Object.freeze(assertEnvelopeSerializable(encrypt(clearBuffer)));
        },
        decrypt(envelope) {
            return decrypt(assertEnvelopeSerializable(envelope));
        }
    });
}

/** DETERMINISTIC TEST ADAPTER — explicitly NOT SECURE. */
const DETERMINISTIC_TEST_ADAPTER = assertCipherAdapter({
    id: "deterministic-test",
    secure: false,
    guarantees:
        "NOT SECURE. Deterministic reversible encoding for tests and local " +
        "development only. Envelopes are trivially decodable by anyone with " +
        "file access.",
    encrypt(clearBuffer) {
        return { k: "det-v1", d: clearBuffer.toString("base64") };
    },
    decrypt(envelope) {
        if (envelope.k !== "det-v1" || typeof envelope.d !== "string") {
            throw invalidInput("deterministic-test envelope malformed");
        }
        return Buffer.from(envelope.d, "base64");
    }
});

module.exports = Object.freeze({
    assertCipherAdapter,
    assertEnvelopeSerializable,
    DETERMINISTIC_TEST_ADAPTER,
    isSecureAdapter: (a) => assertCipherAdapter(a).secure === true
});
