"use strict";

/**
 * RUNTIME CORE — compatibility facade (Wave 5 Lane 4, repair R9 / DSC-R8-001).
 *
 * The RuntimeCore composition implementation moved to
 * src/integration/canonicalRuntimeComposition.js, the single lexical
 * ownership boundary for the RuntimeCore + RuntimeHost + Voice continuity
 * handshake.  This facade re-exports the ORDINARY, SANITIZED public factory.
 *
 * DSC-R8-001: the public `trustedContinuitySink` option is REMOVED — the
 * privileged continuity composition payload ({ lifecycle, composition }) and
 * bindCanonicalTransportPeer are NEVER delivered through any public option.
 * Ordinary options (wave1, governor*, presence*, bus*, media*, recovery*)
 * are passed through; privileged continuity keys are stripped/ignored.
 */

const {
    createRuntimeCore,
    CORE_VERSION
} = require("./canonicalRuntimeComposition");

const VERSION = CORE_VERSION;

module.exports = { createRuntimeCore, VERSION };
