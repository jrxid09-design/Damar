"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — actuator registry vocabulary (Lane 3, FIRST
 * targeted repair: inert readiness vocabulary ONLY — no registry factory,
 * no registrar capability).
 *
 * DESCRIPTIVE + DISPATCH-BINDING infrastructure vocabulary. Each actuator
 * binding (constructed ONLY inside the trusted bootstrap's private
 * composition closure) identifies:
 *
 *   - capabilityId (canonical)
 *   - supported operation(s)
 *   - exact capability incarnation compatibility
 *   - actuator identity (stable logical id)
 *   - lifecycle/incarnation identity for the actuator binding
 *     (fresh per registration — ABA-safe)
 *   - availability / readiness
 *   - invocation function captured at trusted registration time
 *     (function identity captured ONCE; post-registration mutation of
 *     caller-owned objects has zero semantic effect)
 *
 * TRUST ORIGIN (Lane 3 applies Lane 2's certified discipline):
 *
 *   - Actuator registration is bootstrap/runtime-owned. Downstream action
 *     requests may select capability, operation, parameters — they may NOT
 *     select the executor function, actuator implementation, verifier, or
 *     registry implementation.
 *   - No public/downstream API equivalent to dispatch({ actuator: callerFn })
 *     or registerActuator("capability", callerFn) exists anywhere.
 *   - The registry implementation + registrar capability live ONLY inside
 *     the trusted bootstrap's private composition closure
 *     (src/action/bootstrap.js). A direct import of THIS module yields no
 *     constructor, no registrar, no factory — only the inert vocabulary
 *     below.
 */

const READINESS = Object.freeze({
    READY: "READY",
    UNAVAILABLE: "UNAVAILABLE",
    DEGRADED: "DEGRADED"
});

/** PURE predicate — is `readiness` a valid actuator readiness value? */
function isReadiness(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(READINESS, value);
}

module.exports = {
    // inert frozen vocabulary + pure predicate ONLY
    READINESS,
    isReadiness
};
