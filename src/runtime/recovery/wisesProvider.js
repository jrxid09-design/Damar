"use strict";

/**
 * Recovery Capsule provider — the SOLE recovery authority (F-01).
 *
 * RA3-01 single-canary ownership:
 * - The provider performs STRUCTURAL recovery only: restart the runtime
 *   substrate, optionally run a STRUCTURAL HEALTH CHECK (non-inference).
 * - The ONE canonical COGNITIVE canary (a real bounded inference proving
 *   the model actually answers) belongs exclusively to the
 *   WisesRuntime.readiness() lifecycle. It runs exactly once per
 *   runtime/model/recovery epoch (invariant: CANARY_COUNT <= 1).
 * - STRUCTURAL HEALTH CHECK != COGNITIVE CANARY. A cognitive inference
 *   canary is not expressible at this layer by construction: passing a
 *   `canary` option is rejected, so a recovery epoch can never execute
 *   two real canaries (provider canary + readiness canary).
 */
function createWisesRecoveryProvider({ restart, structuralCheck = null, maxAttempts = 1 } = {}) {
 if (typeof restart !== "function") throw new TypeError("WISES_RESTART_REQUIRED");
 if (arguments.length && arguments[0] && "canary" in arguments[0]) {
 throw new TypeError("WISES_PROVIDER_CANARY_FORBIDDEN: the cognitive readiness canary belongs to WisesRuntime.readiness() exactly once per epoch; the recovery provider may only run structural (non-inference) checks");
 }
 if (structuralCheck !== null && typeof structuralCheck !== "function") throw new TypeError("WISES_STRUCTURAL_CHECK_INVALID");
 let attempts = 0;
 return Object.freeze({
 id: "wises-local",
 async restart() {
 if (attempts >= Math.max(0, Math.min(3, maxAttempts | 0))) throw new Error("WISES_RECOVERY_ATTEMPTS_EXHAUSTED");
 attempts++;
 await restart();
 // STRUCTURAL HEALTH CHECK only — never a cognitive inference canary.
 if (structuralCheck) await structuralCheck();
 return Object.freeze({ attempts });
 },
 snapshot() { return Object.freeze({ id: "wises-local", attempts, maxAttempts }); }
 });
}

module.exports = Object.freeze({ createWisesRecoveryProvider });
