"use strict";

/**
 * MATA DEWA VISUAL MODE WIRING (MD-011) — narrowly-scoped internal module.
 *
 * OWNS (per repair A):
 *   - visual mode capability descriptors (activate / deactivate ONLY),
 *   - trusted scope resolvers for those EXACT operations,
 *   - capability registration helper (canonical Capability Registry),
 *   - actuator registration helper (canonical Actuation registry).
 *
 * LAWS:
 *   - CAPABILITY AVAILABILITY != AUTHORITY. This module registers
 *     capability METADATA and an actuator BINDING. It NEVER creates,
 *     upserts, or seeds ANY authority grant — authorization stays owned
 *     by the existing canonical Wave 4 Action Authority composition
 *     (authorityStore seeding / ratification are NOT touched here).
 *   - Execution without a valid authenticated principal fails closed in
 *     the canonical Lane 2 evaluate; this module adds no alternate path.
 *   - Trusted scope for these two operations resolves to [] because the
 *     operations carry NO external resource target. Empty scope is NOT a
 *     general Mata Dewa default: future capabilities must declare their
 *     own explicit scope resolvers.
 *   - The wiring record is passed LEXICALLY through canonical composition
 *     (bootstrap.js hands it from the Lane 2 closure to the Lane 3
 *     closure). Identity-keyed reuse uses a WeakMap keyed by the ACTUAL
 *     canonical runtime identity — Registry A incarnations can never be
 *     consumed by Registry B actuation.
 *   - Wiring failure is a COMPOSITION MISCONFIGURATION: helpers throw a
 *     typed, explicit error (never silently swallowed). Transient
 *     MataDewaService absence is a RUNTIME condition handled at invoke
 *     time (MATA_DEWA_SERVICE_UNAVAILABLE, fail closed) — never here.
 *   - The production service resolver is created by the canonical
 *     composition itself (lexical); this module accepts it as a plain
 *     function argument but never exposes or re-exports any DI seam.
 */

const { CAPABILITY_FAMILIES } = require("./index");

/** Visual-mode capability ids (reused from the canonical family table). */
const MATA_DEWA_MODE_ACTIVATE = CAPABILITY_FAMILIES.MODE_ACTIVATE;     // mata_dewa.mode.activate
const MATA_DEWA_MODE_DEACTIVATE = CAPABILITY_FAMILIES.MODE_DEACTIVATE; // mata_dewa.mode.deactivate

/**
 * Visual-mode capability descriptors — canonical schema v1. These are the
 * ONLY capabilities wired by this module; the remaining Mata Dewa families
 * stay descriptive-only in capabilities/index.js until their own narrowly
 * scoped repairs wire them.
 */
const VISUAL_MODE_CAPABILITIES = Object.freeze([
    Object.freeze({
        schemaVersion: 1,
        id: MATA_DEWA_MODE_ACTIVATE,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["activate"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["ui_mode"]),
        description: "Aktifkan mode UI Mata Dewa di aplikasi Damar yang SAMA (visual-only; tanpa target resource eksternal)."
    }),
    Object.freeze({
        schemaVersion: 1,
        id: MATA_DEWA_MODE_DEACTIVATE,
        kind: "system",
        provider: "core",
        operations: Object.freeze(["deactivate"]),
        requirements: Object.freeze([]),
        effects: Object.freeze(["ui_mode"]),
        description: "Kembalikan UI Damar ke mode normal (visual-only; tanpa target resource eksternal)."
    })
]);

/**
 * Trusted scope resolvers for the EXACT visual-mode operations. Operations
 * carry no external resource target, so the trusted scope is []. The
 * resolver result is canonicalized by Lane 2 (canonicalScope) anyway.
 */
const VISUAL_MODE_SCOPE_BINDINGS = Object.freeze({
    [MATA_DEWA_MODE_ACTIVATE]: Object.freeze({
        activate: () => Object.freeze([])
    }),
    [MATA_DEWA_MODE_DEACTIVATE]: Object.freeze({
        deactivate: () => Object.freeze([])
    })
});

/** Reason code for transient runtime unavailability (invoke-time). */
const MATA_DEWA_SERVICE_UNAVAILABLE = "MATA_DEWA_SERVICE_UNAVAILABLE";

/**
 * Register the visual-mode capabilities through a canonical registrar.
 *
 * @param {{
 *   registrar: { register: Function }
 * }} params
 * @returns {object} frozen wiring record:
 *   { activate: { id, incarnationId }, deactivate: { id, incarnationId } }
 *   Throws (loud) on any registration rejection — composition error.
 */
function wireMataDewaVisualModeCapabilities({ registrar } = {}) {
    if (!registrar || typeof registrar.register !== "function") {
        throw new TypeError("MATA_DEWA_WIRING_INVALID: canonical capability registrar wajib ada");
    }
    const record = {};
    for (const descriptor of VISUAL_MODE_CAPABILITIES) {
        const op = descriptor.operations[0];
        // Serialized-JSON boundary: registry admissions are hostile-input
        // hardened; production wiring uses the same canonical admission.
        const result = registrar.register(JSON.stringify({ ...descriptor }));
        if (!result || typeof result.incarnationId !== "string") {
            throw new Error(`MATA_DEWA_WIRING_FAILED: '${descriptor.id}' tidak menghasilkan incarnation sah`);
        }
        record[op] = Object.freeze({ id: descriptor.id, incarnationId: result.incarnationId });
    }
    return Object.freeze({
        activate: record.activate,
        deactivate: record.deactivate
    });
}

/**
 * Register the visual-mode actuators over a canonical actuator registry.
 * Production call sites: src/action/bootstrap.js (canonical Lane 3
 * composition). Tests may call this with their OWN harness registries —
 * capability and actuator installation still comes from THIS production
 * wiring code, never duplicated test glue.
 *
 * @param {{
 *   actuatorRegistry: { register: Function },
 *   wiring: { activate: { id, incarnationId }, deactivate: { id, incarnationId } },
 *   resolveService?: Function
 * }} params
 */
function wireMataDewaVisualModeActuators({ actuatorRegistry, wiring, resolveService } = {}) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function") {
        throw new TypeError("MATA_DEWA_WIRING_INVALID: canonical actuator registry wajib ada");
    }
    if (!wiring || !wiring.activate || !wiring.deactivate ||
        typeof wiring.activate.incarnationId !== "string" ||
        typeof wiring.deactivate.incarnationId !== "string") {
        throw new TypeError("MATA_DEWA_WIRING_INVALID: wiring record incarnation wajib ada (lexically passed)");
    }
    if (resolveService !== undefined && typeof resolveService !== "function") {
        throw new TypeError("MATA_DEWA_WIRING_INVALID: resolveService wajib function (composition error, bukan runtime)");
    }
    const { registerMataDewaUiModeActuator } = require("./uiModeActuator");
    const bindings = [];
    // Deactivate first so activate is registered last (deterministic order).
    for (const [capabilityId, operation, entry] of [
        [MATA_DEWA_MODE_DEACTIVATE, "deactivate", wiring.deactivate],
        [MATA_DEWA_MODE_ACTIVATE, "activate", wiring.activate]
    ]) {
        bindings.push(registerMataDewaUiModeActuator({
            actuatorRegistry,
            capabilityId,
            capabilityIncarnationId: entry.incarnationId,
            resolveService
        }));
    }
    return Object.freeze(bindings);
}

module.exports = Object.freeze({
    MATA_DEWA_MODE_ACTIVATE,
    MATA_DEWA_MODE_DEACTIVATE,
    VISUAL_MODE_CAPABILITIES,
    VISUAL_MODE_SCOPE_BINDINGS,
    MATA_DEWA_SERVICE_UNAVAILABLE,
    wireMataDewaVisualModeCapabilities,
    wireMataDewaVisualModeActuators
});
