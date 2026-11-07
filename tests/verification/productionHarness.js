"use strict";

/**
 * PRODUCTION-PATH VERIFICATION HARNESS (TARGETED REPAIR 4).
 *
 * This harness exercises the REAL production Lane 4 implementation:
 *   src/action/internal/verificationBootstrap.js::createCanonicalVerificationComposition
 *
 * It contains NO Lane 4 logic copies — no vSafeClassify4, no vHasOwnThen4,
 * no sanitizeEvidence, no vDetach, no verifier state machine, no compensation
 * semantics. It is WIRING ONLY:
 *   - it imports the SAME trusted internal composition function production
 *     uses (src/action/bootstrap.js calls it with trustedVerifiers = []);
 *   - it supplies test-only Lane 2/Lane 3 facade factories (the composition's
 *     deps, injected at trusted composition time) and test-supplied verifier
 *     definitions, consumed ONLY at composition time;
 *   - it exposes the resulting least-privilege facade ({ verify, compensate,
 *     isCanonical* }) to tests.
 *
 * CERTIFICATION INVARIANT: R3 (own-then whole-object rejection) and R1/R2
 * (zero-trap classification, zero-assimilation transport) proofs executed
 * through this harness exercise the production implementation, not a
 * test-domain mirror.
 *
 * AVAILABLE != AUTHORIZED: this harness's composition-time verifier wiring is
 * test-only privilege; it does NOT widen production runtime authority. The
 * production facade still exposes exactly { verify, compensate,
 * isCanonicalVerificationRequest, isCanonicalVerificationResult,
 * isCanonicalCompensationPlan }.
 *
 * The mirror harness (tests/verification/harness.js) remains for
 * foreign-domain tests, isolated adversarial mutation, and differential
 * testing — mirror harness != production certification proof.
 */

const { makeActuationHarness } = require("../actuation/harness");
const { createCanonicalVerificationComposition } = require("../../src/action/internal/verificationBootstrap");

/**
 * Build a production-path verification harness:
 *   {
 *     lane3,                // test Lane 3 actuation harness (canonical results for the composition)
 *     verify,               // REAL production verify() (same implementation as runtime)
 *     compensate,           // REAL production compensate()
 *     isCanonicalVerificationRequest,   // REAL production brand predicate
 *     isCanonicalVerificationResult,
 *     isCanonicalCompensationPlan,
 *     mirrorBrandCheck      // the MIRROR harness's brand check (proves results are NOT mirror-branded)
 *   }
 *
 * @param {object} [opts]
 * @param {Array}  [opts.trustedVerifiers] — composition-time test verifier
 *        definitions: { capabilityId, operations, capabilityIncarnationId,
 *        verifierId, observe, readiness }. Consumed ONLY at composition time.
 */
async function makeProductionVerificationHarness({ scopeBindings, trustedVerifiers = [] } = {}) {
    const lane3 = await makeActuationHarness({ scopeBindings });

    // The REAL production composition, with test-supplied deps + verifiers.
    const facade = createCanonicalVerificationComposition({
        deps: {
            // The composition's brand check for ExecutionResults delegates to
            // the Lane 3 facade injected by the trusted composition caller.
            // Production injects the canonical actuation facade; this trusted
            // test composition injects the test Lane 3 harness facade (whose
            // results are canonical for this composition).
            createLane3Facade: () => ({
                execute: lane3.execute,
                isCanonicalExecutionRequest: lane3.isCanonicalExecutionRequest,
                isCanonicalExecutionResult: lane3.isCanonicalExecutionResult
            }),
            createLane2Facade: () => ({
                admit: lane3.lane2.admit,
                evaluate: lane3.lane2.evaluate,
                authenticate: lane3.lane2.authDomain.authenticate,
                session: lane3.lane2.session
            })
        },
        trustedVerifiers
    });

    return {
        lane3,
        verify: facade.verify,
        compensate: facade.compensate,
        isCanonicalVerificationRequest: facade.isCanonicalVerificationRequest,
        isCanonicalVerificationResult: facade.isCanonicalVerificationResult,
        isCanonicalCompensationPlan: facade.isCanonicalCompensationPlan
    };
}

module.exports = { makeProductionVerificationHarness };
