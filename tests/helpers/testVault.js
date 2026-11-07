"use strict";

/**
 * Helper uji MD-007 — komposisi Secret Vault eksplisit untuk pengujian
 * jahitan kredensial. Adapter cipher dideklarasikan secure:true HANYA di
 * domain uji (fixture) — kode produksi TIDAK pernah default ke adapter
 * seperti ini; produksi tanpa komposisi = fail-closed.
 */

const { createSecretVault } = require("../../src/runtime/vault");
const { assertCipherAdapter } = require("../../src/runtime/vault/cipher");

/** Adapter uji: reversible, dideklarasikan secure untuk seam test saja. */
const TEST_SECURE_ADAPTER = assertCipherAdapter({
    id: "test-secure-fixture",
    secure: true,
    guarantees: "TEST-ONLY fixture: reversible encoding declared secure so " +
        "the credential seam mechanics can be exercised. Never used by " +
        "production code paths.",
    encrypt(clearBuffer) {
        return { k: "tsf-v1", d: clearBuffer.toString("base64") };
    },
    decrypt(envelope) {
        if (envelope.k !== "tsf-v1" || typeof envelope.d !== "string") {
            throw new Error("test-secure-fixture envelope malformed");
        }
        return Buffer.from(envelope.d, "base64");
    }
});

/** Vault uji eksplisit (trusted composition dalam domain uji). */
function createTestVault() {
    return createSecretVault({
        now: () => Date.now(),
        cipher: TEST_SECURE_ADAPTER
    });
}

module.exports = { createTestVault, TEST_SECURE_ADAPTER };
