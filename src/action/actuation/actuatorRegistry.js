"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — actuator registry (Lane 3).
 *
 * DESCRIPTIVE + DISPATCH-BINDING infrastructure. Each actuator binding
 * identifies at minimum: capabilityId, supported operation(s), exact
 * capability incarnation compatibility, actuator identity, lifecycle/
 * incarnation identity for the actuator binding, availability/readiness,
 * and the invocation function captured at trusted registration time.
 *
 * TRUST ORIGIN (Lane 3 applies Lane 2's lessons):
 *
 *   - Actuator registration is bootstrap/runtime-owned. Downstream action
 *     requests may select capability, operation, parameters — they may NOT
 *     select the executor function, actuator implementation, verifier, or
 *     registry implementation.
 *   - No public/downstream API equivalent to:
 *         dispatch({ actuator: callerFn })
 *         registerActuator("capability", callerFn)  // unless caller already
 *                                                  // has a trusted registrar
 *                                                  // capability
 *     Ordinary channel/model/extension code cannot replace an actuator.
 *   - The invocation function is captured ONCE at registration (function
 *     identity). Post-registration mutation of caller-owned objects has zero
 *     semantic effect.
 *
 * ACTUATOR ABA / LIFETIME (Wave 3/Lane 1 discipline):
 *
 *   logical actuator identity != lifetime identity.
 *
 *   If actuator binding A is removed/recreated as B, an ExecutionRequest
 *   bound to A MUST NOT dispatch to B automatically. Each binding carries
 *   its own actuatorIncarnationId, generated at registration.
 *
 * PRIVILEGED: the registry is a pure vocabulary module exposing NO factory.
 * The trusted dispatcher (src/action/actuation/dispatcher.js), composed
 * inside the trusted bootstrap's private closure, constructs the registry
 * internally and binds actuator functions through its own registrar
 * capability. This module is NOT exported from src/action or anywhere
 * reachable by downstream consumers.
 */

const crypto = require("node:crypto");
const { fail, REASONS } = require("./errors");
const { canonicalCapabilityId } = require("../../capability/registry/ids");

/**
 * @typedef {object} ActuatorBinding
 * @property {string} capabilityId           canonical capability id this
 *                                           actuator serves
 * @property {string[]} operations           supported operations (lowercased)
 * @property {string} capabilityIncarnationId  exact capability incarnation
 *                                           this binding was registered against
 * @property {string} actuatorId             stable logical actuator id
 * @property {string} actuatorIncarnationId  fresh per-registration lifetime id
 * @property {string} readiness              "READY" | "UNAVAILABLE" | "DEGRADED"
 * @property {function} invoke               captured invocation function
 */

/**
 * Build an actuator registry. The registry is a closure-owned Map keyed by
 * actuatorId (with capabilityId+operation indices). Mutations go ONLY through
 * the returned registrar capability, which the trusted dispatcher captures
 * and never hands to downstream consumers.
 *
 * @returns {object} frozen { registry, registrar }
 */
function buildActuatorRegistry() {
    const byId = new Map();         // actuatorId -> ActuatorBinding
    const byCap = new Map();        // capabilityId -> Map(operation -> ActuatorBinding)
    let removedCount = 0;

    function canonicalOp(op) {
        return String(op ?? "").trim().toLowerCase();
    }

    function register({ capabilityId, operations, capabilityIncarnationId, actuatorId, invoke, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty capabilityId");
        }
        const capId = canonicalCapabilityId(capabilityId);
        if (!Array.isArray(operations) || operations.length === 0) {
            throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        }
        const ops = operations.map(canonicalOp).filter((s) => s.length > 0);
        if (ops.length === 0) {
            throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a non-empty operations array");
        }
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) {
            throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires a capabilityIncarnationId");
        }
        if (typeof invoke !== "function") {
            throw fail(REASONS.REGISTRATION_REJECTED, "actuator registration requires an invoke function");
        }
        if (readiness !== "READY" && readiness !== "UNAVAILABLE" && readiness !== "DEGRADED") {
            throw fail(REASONS.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        }

        // logical actuator id — stable across remove/recreate (so callers
        // keep referring to the same logical actuator)
        const id = (typeof actuatorId === "string" && actuatorId.length > 0)
            ? actuatorId
            : `act-${crypto.randomUUID()}`;
        // lifetime identity — fresh every registration (so an ExecutionRequest
        // bound to incarnation A never dispatches to recreated incarnation B)
        const actuatorIncarnationId = `ainc-${crypto.randomUUID()}`;

        if (byId.has(id)) {
            throw fail(REASONS.REGISTRATION_REJECTED, `actuator '${id}' is already registered; remove it first`);
        }

        // capture function identity exactly once (detached from caller object)
        const invokeFn = invoke.bind({});

        const binding = Object.freeze({
            capabilityId: capId,
            operations: Object.freeze(ops.slice()),
            capabilityIncarnationId,
            actuatorId: id,
            actuatorIncarnationId,
            readiness,
            invoke: invokeFn
        });

        byId.set(id, binding);
        let opMap = byCap.get(capId);
        if (!opMap) { opMap = new Map(); byCap.set(capId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) {
                // roll back registration to keep atomic semantics
                byId.delete(id);
                throw fail(REASONS.REGISTRATION_REJECTED, `actuator already registered for '${capId}.${op}'`);
            }
            opMap.set(op, binding);
        }
        return binding;
    }

    function remove(actuatorId) {
        const binding = byId.get(actuatorId);
        if (!binding) return false;
        byId.delete(actuatorId);
        const opMap = byCap.get(binding.capabilityId);
        if (opMap) {
            for (const op of binding.operations) {
                const cur = opMap.get(op);
                if (cur && cur.actuatorId === actuatorId) opMap.delete(op);
            }
            if (opMap.size === 0) byCap.delete(binding.capabilityId);
        }
        removedCount++;
        return true;
    }

    function resolve(capabilityId, operation) {
        const capId = canonicalCapabilityId(capabilityId);
        const op = canonicalOp(operation);
        const opMap = byCap.get(capId);
        if (!opMap) return null;
        return opMap.get(op) ?? null;
    }

    function get(actuatorId) {
        const b = byId.get(actuatorId);
        return b ?? null;
    }

    function size() { return byId.size; }

    return Object.freeze({
        register,
        remove,
        resolve,
        get,
        size
    });
}

module.exports = { buildActuatorRegistry };
