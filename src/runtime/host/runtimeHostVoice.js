"use strict";

/**
 * CANONICAL VOICE RUNTIME COMPOSITION — module-private activation ownership
 * (Wave 5 Lane 4, repair R7 / DSC-R6-001).
 *
 * This is the canonical boundary between the ordinary public RuntimeHost and
 * the trusted Voice composition.  LAW:
 *
 *   PUBLIC createRuntimeHost MUST NOT DISTRIBUTE A PRIVILEGED CONTINUITY
 *   CAPABILITY.
 *   ORDINARY IMPORTER != TRUSTED VOICE COMPOSITION.
 *   VOICE ACTIVATION CAPABILITY MUST BE OWNED ONLY BY CANONICAL VOICE
 *   COMPOSITION.
 *   TERMINAL RUNTIME != ACTIVATABLE RUNTIME.
 *
 * The ordinary public `createRuntimeHost` (runtimeHost.js) returns only an
 * ordinary host and yields NO voice-continuity capability.  THIS module is
 * the ONLY composition that can obtain one, because it alone consumes the
 * internal `_voiceComposition` seam: it receives a per-composition
 * ACTIVATION TOKEN (an unforgeable object, not a string, not reconstructible
 * by shape) alongside the ordinary host, and uses it to retrieve the
 * runtime-local zero-argument activation closure.
 *
 * The activation closure is:
 *   - bound to ONE RuntimeHost composition (never crosses runtimes);
 *   - zero-argument and VOICE-ONLY (fixed RUNTIME_OWNER semantics; accepts no
 *     peer/channel/session text);
 *   - held ONLY in module-private state (WeakMap), never on the returned
 *     handle's public host, never reconstructible by an ordinary importer;
 *   - lifecycle-bound: it fails closed once the owning runtime is no longer
 *     operational (the closure itself guards on the host phase machine).
 *
 * There is exactly ONE RuntimeHost implementation; this module composes it,
 * it does not reimplement it.
 */

const hostMod = require("./runtimeHost");

const { composeRuntimeHostWithVoiceActivation, retrieveVoiceActivation } =
    hostMod._voiceComposition;

// Module-private map: public voice-host handle -> runtime-local activation
// closure.  The closure NEVER appears on the handle's public surface.
const ACTIVATION_BY_HANDLE = new WeakMap();

/**
 * CANONICAL VOICE COMPOSITION FACTORY.
 *
 * Creates a RuntimeHost for the canonical VoiceRuntime and returns an
 * inert handle exposing ONLY the ordinary public host.  The matching
 * voice-continuity activation closure is retained in module-private state,
 * reachable ONLY through `activateVoiceContinuity(handle)` below — a seam
 * this module alone can satisfy (it holds the per-composition token).
 *
 * @param {object} options ordinary createRuntimeHost dependency options.
 * @returns {Promise<{host: object}>} frozen handle; `.host` is the ordinary
 *          public RuntimeHost facade (clean — no continuity administration).
 */
async function createCanonicalVoiceRuntimeHost(options = {}) {
    const { host, activationToken } = await composeRuntimeHostWithVoiceActivation(options);
    const activate = retrieveVoiceActivation(activationToken);
    const handle = Object.freeze({ host });
    if (typeof activate === "function") {
        ACTIVATION_BY_HANDLE.set(handle, activate);
    }
    return handle;
}

/**
 * Activate the canonical voice-continuity identity for the runtime behind
 * `handle`.  VOICE-ONLY, zero identity input.  The returned value is inert
 * diagnostic state ONLY ({ ok, code, ... }) — it carries NO scope, NO handle,
 * NO mint, NO controller, NO domain, NO linker, NO lifecycle object, NO
 * secret, NO capability object.
 *
 * Fails closed ({ ok:false }) when:
 *   - `handle` was not produced by createCanonicalVoiceRuntimeHost;
 *   - the owning runtime is no longer operational (shutdown requested /
 *     shutting down / terminated) — enforced inside the closure AND here;
 *   - the composition seam is unavailable.
 *
 * Idempotent while the runtime is live (the underlying composition bind is
 * itself idempotent per channel).  After terminal shutdown the capability is
 * revoked: invocation deterministically fails and mutates nothing.
 *
 * @param {object} handle the frozen handle returned by
 *                        createCanonicalVoiceRuntimeHost.
 * @returns {object} frozen inert diagnostic result.
 */
function activateVoiceContinuity(handle) {
    if (handle === null || typeof handle !== "object") {
        return Object.freeze({ ok: false, code: "VOICE_ACTIVATION_HANDLE_INVALID" });
    }
    const activate = ACTIVATION_BY_HANDLE.get(handle);
    if (typeof activate !== "function") {
        return Object.freeze({ ok: false, code: "VOICE_ACTIVATION_UNAVAILABLE" });
    }
    const result = activate();
    // Project to inert diagnostics only (defense in depth: never leak a
    // capability-shaped value even if the closure's internals change).
    return Object.freeze({
        ok: result && result.ok === true,
        code: result && typeof result.code === "string" ? result.code : undefined,
        terminal: result && result.terminal === true ? true : undefined
    });
}

module.exports = Object.freeze({
    createCanonicalVoiceRuntimeHost,
    activateVoiceContinuity
});
