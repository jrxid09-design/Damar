"use strict";

/**
 * DAMAR RUNTIME HOST V1 — compatibility facade
 * (Wave 5 Lane 4, repair R9 / DSC-R8-001).
 *
 * The RuntimeHost composition implementation moved to
 * src/integration/canonicalRuntimeComposition.js, the single lexical
 * ownership boundary for the RuntimeCore + RuntimeHost + Voice continuity
 * handshake.  This facade re-exports the ORDINARY, SANITIZED public factory
 * and the ordinary host vocabulary.
 *
 * DSC-R8-001: public createRuntimeHost accepts ONLY ordinary documented
 * options.  A caller-supplied `coreFactory` is ALWAYS treated as untrusted:
 * it receives only sanitized ordinary options and NEVER receives a trusted
 * continuity sink, a composition payload, or any privileged continuity
 * object.  No public option (voiceActivation / trustedContinuitySink /
 * continuityComposition / …) can receive a privileged capability.
 */

const {
    createRuntimeHost,
    HOST_VERSION,
    HOST_PHASE,
    HOST_COMMANDS,
    LOCAL_TRANSPORT_ID,
    governorMod,
    ib,
    presenceMod
} = require("../../integration/canonicalRuntimeComposition");

const VERSION = HOST_VERSION;

module.exports = Object.freeze({
    createRuntimeHost,
    VERSION,
    HOST_PHASE,
    HOST_COMMANDS,
    LOCAL_TRANSPORT_ID,
    governorMod,
    ib,
    presenceMod
});
