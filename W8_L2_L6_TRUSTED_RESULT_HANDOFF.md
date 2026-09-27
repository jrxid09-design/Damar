# W8-L2 to W8-L6 trusted result handoff

L2 only creates bounded `ProbeRequest` records. It does not dispatch them and does not accept a caller's success assertion as a result.

The current runtime composition binds a private `trustedResultAdapter` whose `verifyCompletion` always returns `false`. Consequently `probeResult` fails closed in the canonical runtime until L6 supplies the real completion path.

The L6 handoff must be composed inside `canonicalRuntimeComposition.js`; it must not be a public RuntimeCore option. Its synchronous `verifyCompletion({ probeId, request, outcome, observation })` must confirm all of the following before returning `true`:

1. The matching request was routed through the existing canonical Manager, Authority, Capability, and Verification owners. A descriptor, caller field, or L2 classification is not an authorization artifact.
2. The completion is bound to the exact `probeId`, `questionRef`, `capabilityId`, and request digest that were authorized. Duplicate completion cannot charge or complete twice.
3. A successful result is an actual L1 `Observation` produced by a committed sensorium event and is fed through the already-bound `sensoriumBridge.applyObservationPlan`. L2 must not ingest directly into the world model or create a parallel event/dispatch path.
4. A denial or timeout is an owner-verified outcome. Unverified results remain in flight until the request deadline, then expire fail closed.

The adapter is synchronous and composition-owned. Arbitrary caller callbacks, Promise/thenable returns, and result-shaped data never count as completion evidence. Until those checks are available, the private adapter continues returning `false`.
