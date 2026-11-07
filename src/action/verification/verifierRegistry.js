"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION V1 — verifier registry vocabulary
 * (Lane 4, inert readiness vocabulary ONLY — no registry factory, no
 * registrar capability, no observation-function surface).
 *
 * DESCRIPTIVE + OBSERVATION-BINDING infrastructure vocabulary. Each verifier
 * binding (constructed ONLY inside the trusted bootstrap's private
 * composition closure) identifies:
 *
 *   - capabilityId (canonical)
 *   - supported operation(s)
 *   - exact capability incarnation compatibility (resolved against the
 *     ExecutionResult being verified, never caller-supplied)
 *   - verifier identity (stable logical id)
 *   - verifierIncarnationId — lifecycle/incarnation identity for the binding
 *     (fresh per registration — ABA-safe: if verifier A is removed and an
 *     identically-named verifier B is registered, work bound to A's
 *     incarnation never silently uses B)
 *   - supported postcondition/evidence type
 *   - observation function captured ONCE at trusted registration time
 *     (function identity captured at registration; post-registration
 *     mutation of caller-owned objects has zero semantic effect)
 *   - readiness/availability
 *
 * TRUST ORIGIN (Lane 4 applies the certified Lane 2/Lane 3 discipline):
 *
 *   - Verifier registration is bootstrap-owned. Downstream action requests
 *     may select capability, operation, parameters, and provide DECLARATIVE
 *     expected postconditions — they may NOT select the verifier function,
 *     sensor checker, postcondition predicate, or evaluator implementation.
 *   - No public/downstream API equivalent to verify({ verifier: callerFn })
 *     or registerVerifier("capability", callerFn) exists anywhere.
 *   - The registry implementation + registrar capability live ONLY inside
 *     the trusted bootstrap's private composition closure
 *     (src/action/bootstrap.js). A direct import of THIS module yields no
 *     constructor, no registrar, no factory — only the inert vocabulary
 *     below.
 *
 *   - CAN A RESULT OBJECT BECOME AUTHORITY? No. A VerificationResult is
 *     branded evidence. Compensation NEVER trusts a caller-presented
 *     VerificationResult: the canonical compensate() path re-derives the
 *     compensation trigger from the canonical execution/verification record
 *     held inside the trusted runtime and re-runs the full Lane 2 → Lane 3
 *     chain for the compensation action itself.
 */

const READINESS = Object.freeze({
    READY: "READY",
    UNAVAILABLE: "UNAVAILABLE",
    DEGRADED: "DEGRADED"
});

/** PURE predicate — is `readiness` a valid verifier readiness value? */
function isReadiness(value) {
    return typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(READINESS, value);
}

module.exports = {
    // inert frozen vocabulary + pure predicate ONLY
    READINESS,
    isReadiness
};

// NOT exported: buildVerifierRegistry, registerVerifier, any observation
// function surface, any compensator registry or rollback executor.
