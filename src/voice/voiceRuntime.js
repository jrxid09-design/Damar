"use strict";

/**
 * VoiceRuntime — compatibility facade (Wave 5 Lane 4, repair R10 / DSC-R9-001).
 *
 * The canonical VoiceRuntime class implementation lives in
 * src/integration/canonicalRuntimeComposition.js, the single lexical
 * ownership boundary where it closes DIRECTLY over the private
 * composeCanonicalVoiceHost / activateVoice functions.  No privileged
 * function crosses this module boundary.
 *
 * This facade re-exports ONLY the already-bound class for the canonical
 * src/voice import path.  It exposes NO privileged primitive: no
 * buildVoiceRuntimeClass, no composeHost, no activateVoice, no composition
 * builder, resolver, token, or sink.  Replacing this module in require.cache
 * can therefore NEVER capture a privileged reference — the canonical lexical
 * VoiceRuntime ownership does not flow through it.
 */

const { VoiceRuntime } = require("../integration/canonicalRuntimeComposition");

module.exports = Object.freeze({ VoiceRuntime });
