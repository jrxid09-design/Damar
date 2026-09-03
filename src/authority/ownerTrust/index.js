"use strict";

/**
 * OWNER TRUST — public package surface (Wave 5 Lane 4).
 *
 * The narrow missing trust domain: Owner/Admin principal records, credential
 * descriptors, principal bindings, trust generations, bootstrap state.
 *
 * PUBLIC BOUNDARY LAW: the factories here create COMPOSITION objects; they do
 * NOT by themselves grant trust.  Privileged mutation (first-Owner bootstrap,
 * proof-minted authentication, ratification) flows ONLY through the sealed
 * canonical composition, never through a raw import of these factories.
 * Importing this module confers NO trust, NO Authority, NO authenticated
 * principal.
 */

const types = require("./types");
const { createOwnerTrustRegistry } = require("./registry");
const { createOwnerTrustStore, STORE_BACKEND } = require("./store");
const { createProofVerifier, canonicalChallenge } = require("./proof");
const {
    createFirstOwnerBootstrap,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
} = require("./bootstrap");
const { createPrincipalBindings, normalizePeer, TRANSPORTS } = require("./bindings");
const { createChannelBinders } = require("./binders");

module.exports = Object.freeze({
    ...types,
    createOwnerTrustRegistry,
    createOwnerTrustStore,
    OWNER_TRUST_STORE_BACKEND: STORE_BACKEND,
    createProofVerifier,
    canonicalChallenge,
    createFirstOwnerBootstrap,
    createPrincipalBindings,
    createChannelBinders,
    normalizePeer,
    TRANSPORTS,
    BOOTSTRAP_PURPOSE,
    BOOTSTRAP_CONTEXT
});
