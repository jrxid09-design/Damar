"use strict";

/**
 * VAULT PROVIDERS — platform-supplied adapters for the Vault's existing
 * CipherAdapter contract (Trust Foundation stage).
 *
 * The Vault core (src/runtime/vault) deliberately invents NO cryptography
 * and forbids crypto primitives inside its own structural boundary.  Secure
 * protection adapters therefore live HERE, at the provider layer the
 * Vault's contract names.  This surface exposes only the provider factory;
 * it grants NO privilege, NO owner identity, NO Authority.
 */

const { createProductionCipherAdapter, ENVELOPE_KIND, KEY_BYTES } = require("./aesGcmCipher");

module.exports = Object.freeze({
    createProductionCipherAdapter,
    ENVELOPE_KIND,
    KEY_BYTES
});
