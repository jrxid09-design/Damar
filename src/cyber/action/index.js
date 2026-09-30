"use strict";

/**
 * DCD ACTION PLANE — cyber actuator registration and ActionIntent construction.
 *
 * Registers cyber drivers (Kali, scanner, range tools) as actuators through
 * the canonical Action Actuation Fabric. DCD never dispatches directly.
 *
 * Invariants enforced here:
 *   DC-05: NO_SECOND_EXECUTION_FABRIC
 *   DC-07: NO_DIRECT_EXPLOIT_TO_EXECUTION — every effect is an ActionIntent
 *   DC-89: NO_DCD_MODULE_IMPORTS_DISPATCHER_OR_AUTHORITY_INTERNALS
 *   SIMULATION_NEQ_EXECUTION (§12)
 *   KALI_NEQ_AUTHORITY (§12)
 *
 * This module does NOT import src/action/gate.js, src/action/runtime.js,
 * or any authority-internal module (DC-89 / I-72 / I-73).
 */

const contracts = require("../contracts");
const { envelopeShapeErrors } = contracts;

// Null-prototype actuator descriptor registry
const _actuators = Object.create(null);

/**
 * Register a cyber actuator descriptor.
 * Descriptor only — the canonical capability registry owns actual registration.
 * Returns { ok, errors }.
 */
function registerCyberActuator(descriptor) {
    const { capabilityId, operations, driver, isSimulation } = descriptor || {};

    if (typeof capabilityId !== "string" || !capabilityId) {
        return { ok: false, errors: ["capabilityId required"] };
    }
    if (!Array.isArray(operations) || operations.length === 0) {
        return { ok: false, errors: ["operations array required"] };
    }
    if (_actuators[capabilityId]) {
        return { ok: false, errors: [`actuator '${capabilityId}' already registered`] };
    }

    _actuators[capabilityId] = Object.freeze({
        capabilityId,
        operations: Object.freeze([...operations]),
        driver: driver || null,
        isSimulation: isSimulation === true,
        registeredAt: Date.now(),
    });

    return { ok: true, errors: [] };
}

/**
 * Build an ActionIntent description for a cyber operation.
 * Returns a plain params object for the canonical intent admission.
 * DCD never calls admitActionIntent directly.
 *
 * DC-07: every effect must start as an ActionIntent, never a direct call.
 */
function makeSecurityIntent(envelope, attempt, correlationId) {
    if (!envelope) throw new Error("envelope required for security intent (DC-81)");

    const shapeErrors = envelopeShapeErrors(envelope);
    if (shapeErrors.length) {
        throw new Error(`invalid envelope: ${shapeErrors[0]}`);
    }

    const { capabilityId, operation, target, blastRadius } = attempt || {};
    if (typeof capabilityId !== "string" || !capabilityId) {
        throw new Error("attempt.capabilityId required");
    }
    if (typeof operation !== "string" || !operation) {
        throw new Error("attempt.operation required");
    }
    // §12 SIMULATION_NEQ_EXECUTION: an unregistered capability has unknown isSimulation —
    // building an intent for it would silently stamp isSimulation:false (real execution).
    if (!_actuators[capabilityId]) {
        throw new Error(`capability '${capabilityId}' not registered in DCD actuators (register before building intent)`);
    }
    // Validate operation is in the actuator's declared operations list.
    if (!_actuators[capabilityId].operations.includes(operation)) {
        throw new Error(`operation '${operation}' is not declared for capability '${capabilityId}'`);
    }

    return Object.freeze({
        capabilityId,
        operation,
        correlationId: typeof correlationId === "string" ? correlationId : null,
        metadata: Object.freeze({
            envelopeRef: typeof envelope.authority_reference === "string"
                ? envelope.authority_reference : null,
            target: typeof target === "string" ? target : null,
            // Deep-freeze blastRadius — shallow freeze lets callers mutate via original ref.
            blastRadius: blastRadius && typeof blastRadius === "object"
                ? Object.freeze({ ...blastRadius }) : null,
            // §12: SIMULATION_NEQ_EXECUTION — explicit simulation tag
            isSimulation: _actuators[capabilityId].isSimulation,
        }),
    });
}

/** Read-only actuator listing — no second dispatcher (DC-05). */
function listActuators() { return Object.values(_actuators); }

module.exports = Object.freeze({
    registerCyberActuator,
    makeSecurityIntent,
    listActuators,
});
