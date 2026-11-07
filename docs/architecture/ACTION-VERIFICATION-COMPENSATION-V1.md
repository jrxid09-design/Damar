# ACTION VERIFICATION + COMPENSATION V1 — Lane 4

**Branch:** `feat/damar-identity-migration`
**Foundation:** certified `b5e3ad4` (Lane 1 Capability Registry & Graph V1, Lane 2 Action Intent + Authority Gate V1, Lane 3 Actuation Fabric V1, Damar Identity & Pandawa Migration).
**Scope:** Wave 4 Lane 4 only. **Lane 5 is explicitly out of scope.**

This document is the authoritative specification for the verification and
compensation layer of the Damar action system. It is normative: any
disagreement between code and this document is a defect.

---

## 1. CORE LAWS

Lane 4 extends the certified Lane 1–3 invariant chain:

```
EXECUTED != VERIFIED
ACTUATOR REPORT != WORLD TRUTH
TIMEOUT != NO SIDE EFFECT
AUDIT != CURRENT TRUTH
MEMORY != CURRENT TRUTH
MODEL CLAIM != VERIFICATION
PLAN != AUTHORITY
COMPENSATION != ROLLBACK GUARANTEE
```

These laws are enforced structurally, not by convention. They are load-bearing:
collapsing any of them reopens a trust boundary that Lane 2 and Lane 3 closed.

The boundary Lane 4 owns:

```
actuator-reported execution outcome
        |
        v
        |<-- Lane 4 ---->|
        v                 |
verified real-world /      |
postcondition truth        |
        |                 |
        v                 |
+ bounded compensation     |
        |                 |
        v                 |
fresh Lane 3 actuation ----+
```

---

## 2. TRUST ORIGIN

Lane 4 repeats the certified Lane 2/Lane 3 discipline exactly:

* **Bootstrap-owned composition.** Every privileged verifier/compensator
  capability (registry, registrar, formers, evaluator, sanitizer, dispatcher)
  lives ONLY in the trusted bootstrap's private lexical closure
  (`src/action/bootstrap.js`). It is reachable through NO binder, NO token,
  NO host capability, NO first-call-wins registry.
* **No caller-selected privileged function.** A downstream caller may
  select capability, operation, parameters, and provide DECLARATIVE expected
  postconditions. It may NEVER select the verifier function, sensor checker,
  postcondition predicate, compensator, rollback function, or repair executor.
* **Canonical result provenance is brand-first.** `VerificationRequest`,
  `VerificationResult`, `CompensationPlan` are closure-private-branded
  values. The brand WeakSets live only inside the bootstrap closure; brand
  membership is recognized by methods on the canonical facade (`isCanonical*`)
  that read the WeakSet before any property access. A hostile `Proxy`
  therefore executes ZERO attacker-controlled traps during recognition.
* **A result object is not authority.** A `VerificationResult` is branded
  evidence; compensation never trusts a caller-presented verification result.
  The canonical `compensate()` path re-derives the compensation trigger from
  the canonical record held inside the trusted runtime.

```
attacker imports every action module before bootstrap  -> nothing acquired
attacker imports after canonical bootstrap load        -> nothing acquired
attacker creates new verification runtime over canonical state  -> NO surface
attacker selects verifier                               -> NO surface
attacker presents a VerificationResult as bearer authority       -> rejected
```

### Process / module isolation limitation

This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
path hiding is NOT hard sandboxing against code that already has arbitrary
same-process filesystem/require execution. What Lane 4 enforces is that the
ordinary/downstream Action API exposes NO authority-composition primitive at
all: canonical bootstrap owns composition, downstream receives least-privilege
facades only. Untrusted executable extensions must eventually require loader
allowlisting, sandboxing, workers/process isolation, or equivalent enforcement.

---

## 3. VERIFICATION MODEL

Verification binds an execution to an explicit expected postcondition and
produces a verified state.

A `VerificationRequest` binds at least:

* `verificationId`, `executionId`, `intentId`
* `capabilityId`, `capabilityIncarnationId`
* `operation`, `principal`
* `actuatorId`, `actuatorIncarnationId`
* `authorityGeneration` used by the execution
* `verifierId`, `verifierIncarnationId`
* `expectedPostcondition` (canonical declarative)
* `requestedAtMs`, `timeoutMs`

A `VerificationResult` carries:

* the full request binding (immutable copy)
* `expectedPostcondition` (immutable copy)
* `observedEvidence` (sanitized) — what was observed
* `observationMethod` — `verifierId` of the binding that observed
* `verificationState`
* `observedAtMs`, `verifiedAtMs`
* `detail` (sanitized human-readable note)

Evidence is immutable and provenance-bound: every record carries the verifier
identity + incarnation that produced it, the source execution identity, and
timestamps. The Audit Ledger may record evidence but remains HISTORICAL evidence
only — `AUDIT != CURRENT TRUTH`.

---

## 4. VERIFICATION STATES

```
PENDING           verification accepted, truth not yet established
OBSERVING         observation in flight (transient)
VERIFIED_SUCCESS  observed evidence matched the expected postcondition
VERIFIED_FAILURE  observed evidence matched an explicit failure of the
                  expected postcondition (claim ABOUT THE WORLD, only minted
                  by the canonical evaluator from canonical evidence)
INCONCLUSIVE      evidence was missing, ambiguous, or contradictory; truth
                  was NOT established either way
TIMED_OUT         verification bound exceeded before truth was established
ERROR             verifier infrastructure error (NOT a claim about the world)
```

`INCONCLUSIVE` is a first-class terminal state. It is NEVER collapsed into
failure or success. `VERIFIED_*` is NEVER claimed when evidence is missing or
ambiguous. Verifier infrastructure errors are classified separately
(`ERROR != VERIFIED_FAILURE`).

---

## 5. EXPECTED POSTCONDITION

The expected postcondition is canonical, immutable, and **declarative only**:

```
{
  schemaVersion: 1,
  kind: "postcondition.v1",
  expect: {
    <dottedPath>: { op: "eq"|"ne"|"exists"|"absent"|"gt"|"gte"|"lt"|"lte"|"in"|"type",
                    value?: <declarative value> }
  },
  forbid: { <dottedPath>: <declarative value> }
}
```

* Downstream callers may provide declarative expected values only.
* Arbitrary executable predicate code (function, compiled predicate, evaluator
  object with an exec/eval/apply surface, class instance) is NEVER accepted.
* Paths are dotted identifiers, validated syntactically and against
  `__proto__`/`constructor`/`prototype` pollution.
* A vacuous postcondition (no expect AND no forbid rules) is rejected — it
  must never be able to mint `VERIFIED_SUCCESS` from a vacuous match.

The canonical verifier implementation (owned by the bootstrap closure) decides
how declarative expectations are evaluated against canonical sanitized
evidence.

---

## 6. VERIFIER REGISTRY

Verifier bindings are bootstrap-owned. Each binding identifies:

* `capabilityId`
* `operation(s)` supported
* exact `capabilityIncarnationId` compatibility
* `verifierId` (stable logical id)
* `verifierIncarnationId` — fresh per registration (ABA-safe)
* supported postcondition/evidence type
* observation function captured ONCE at trusted registration time
  (function identity captured at registration; post-registration mutation of
  caller-owned objects has zero semantic effect)
* `readiness` (READY / UNAVAILABLE / DEGRADED)

The registry implementation, the registrar capability, the brand tokens and
WeakSets are NOT exported from any module. A direct import of any verification
module yields ONLY inert vocabulary + pure predicates.

### Incarnation / ABA discipline

`logical verifierId != verifier lifetime`. If verifier A is replaced by an
identically-named verifier B, work bound to A's incarnation never silently uses
B. Old verification results carry A's incarnation; new verification resolves
the current incarnation only.

---

## 7. FRESH VERIFICATION TARGET

Verification binds to a canonical Lane 3 `ExecutionResult`. The brand check is
BRAND-FIRST: a forged result, a JSON clone, a foreign-domain result, a
caller-created lookalike, and a hostile `Proxy` are ALL rejected before any
property access. `ExecutionResult` itself is NOT authority — possession of a
result is never sufficient to verify, and a verification result is never a
bearer execution or compensation token.

---

## 8. OBSERVATION SAFETY

Observation functions may return values, structured evidence, sensor state,
status, or errors. The canonical evidence sanitizer:

* normalizes hostile outputs (no raw `Proxy`/accessor/class-instance
  retention; bounded depth/size/keys; `Error` reduced to name+message);
* never throws for hostile content shapes (fail-closed means "not retained",
  not "crash");
* rejects the verifier's own malformed output as a verifier infrastructure
  `ERROR` (never `VERIFIED_FAILURE`).

`verifier error != verified failure` is enforced structurally.

### ZERO-TRAP EVIDENCE CLASSIFICATION (TARGETED REPAIR 1)

**Invariant:** for hostile evidence objects, NO attacker-controlled object
behavior may execute merely because Lane 4 is deciding whether the evidence
is safe. The safety check itself must not be an execution gadget.

**Trust ordering** (mirrors the Lane 3 brand-first lesson — SAFE ORIGIN
FIRST, REFLECTION SECOND):

1. Classification of an untrusted value uses ONLY `typeof`, strict equality,
   and `util.types.isProxy()` / `util.types.isPromise()` — internal-slot
   probes that consult NO Proxy handler (verified against every instrumented
   trap family: `get`, `has`, `ownKeys`, `getOwnPropertyDescriptor`,
   `getPrototypeOf`, `set`, `defineProperty`, `deleteProperty`, `apply`,
   `construct`; even revoked proxies answer without handler consultation).
2. Any `Proxy` — trap-bearing, transparent, or revoked — is rejected BEFORE
   any reflection. **TRUSTED SHAPE != TRUSTED ORIGIN**: no shape-based trust
   is invented for unmarked values; fail-closed rejection is preferred over
   broader unsafe acceptance.
3. Only after a value is proven not to be a Proxy does reflection proceed
   (static prototype identity, ownKeys, descriptors), and EVERY nested value
   re-enters the gate before its own reflection. The zero-trap invariant
   holds recursively — a hostile Proxy nested inside otherwise normal-looking
   evidence poisons the entire observation (fail-closed `ERROR`).

**Error values:** native Errors are the only exotic family ACCEPTED as
evidence, normalized to `{name,message}` and matched via the STATIC
prototype chain — never `value instanceof Error`, which routes through
`Error[Symbol.hasInstance] -> OrdinaryHasInstance` and was exactly the
`getPrototypeOf` gadget flagged by the audit. A Proxy wrapping an Error
target is rejected at the proxy gate and never reaches the Error branch.
Duck-typed `{name, message}` plain objects are evaluated as ordinary
evidence, not through the Error path.

**Observation delivery (TARGETED REPAIR 2 — trusted transport):**
native Promise thenable assimilation is a hazard: resolving or awaiting a
Promise whose eventual value is a hostile thenable executes the attacker's
`then` behavior (V8 `PromiseResolveThenableJob`) BEFORE any classifier can
see the value — "fixing it after await" is impossible because assimilation
has already occurred, and `Promise.resolve(raw)`/`raw.then` checks are
themselves assimilation/`get`-trap gadgets. Lane 4 therefore NEVER uses
native promise semantics on untrusted evidence:

* **Sync observers** — `observe(context) -> raw evidence`: the raw return is
  classified immediately (zero-trap classifier) and boxed. It is NEVER passed
  through `Promise.resolve(observe())`, `await observe()`, or `.then` —
  automatic assimilation of sync returns is a bug class this contract
  forbids.
* **Async observers** — `observe(context, trustedSink)`: the observer
  performs its async work internally and completes through a
  bootstrap-owned, frozen, closure-private sink
  (`trustedSink.resolveEvidence(raw)` / `trustedSink.rejectObservation(err)`).
  The sink classifies the raw evidence SYNCHRONOUSLY at receipt — before any
  promise machinery can assimilate it — and stores only the classified box.
  The verifier cannot replace the sink; raw evidence is never a Promise
  resolution value.
* **Raw Promise returns are UNSUPPORTED** (contract deliberately narrowed):
  `async () => evidence`, `() => Promise.resolve(evidence)`, and any
  thenable return are rejected at classify time via the internal-slot
  `isPromise`/`isProxy` probes and fail closed to a typed observation-
  transport `ERROR` (`UNSUPPORTED_ASYNC_RAW_RETURN` semantics) — never
  `VERIFIED_SUCCESS`, never `VERIFIED_FAILURE`, never `INCONCLUSIVE`, and
  never a compensation trigger. The returned Promise object itself is never
  assimilated by Lane 4 (no `.then` call, no `await`, no `Promise.resolve`).

* **Plain thenable observation values are UNSUPPORTED (TARGETED REPAIR 3):**
  ANY non-Proxy object/array (or native Error) carrying an OWN property
  named `then` — whether a data property (function, non-function, undefined,
  null, number, string, boolean) or an accessor (getter/setter) — is a
  thenable-shaped transport surface and is rejected WHOLE. The detection
  uses `Object.getOwnPropertyDescriptor(value, "then")` AFTER the value has
  been proven non-Proxy by the classifier: the descriptor lookup performs NO
  attacker-controlled trap and NEVER invokes the `then` getter/setter. There
  is NO duck typing (no `typeof obj.then`), NO partial sanitization (no
  skipping the `then` field and retaining sibling data). The rule is
  recursive: a nested own-`then` poisons the ENTIRE observation. The Error
  normalization branch does NOT bypass the rule: an Error with own `then` is
  rejected before `{name,message}` normalization. The same whole-input
  rejection applies to expectedPostcondition and compensation-parameter
  payloads (an own `then` anywhere in the input rejects the whole input).
  Outcome: typed `ERROR` (`UNSUPPORTED_ASYNC_RAW_RETURN`), never
  `VERIFIED_SUCCESS`/`VERIFIED_FAILURE`/`INCONCLUSIVE`, never a compensation
  trigger. Rationale: a plain thenable is semantically ambiguous with async
  transport; an accessor-backed `then` can execute behavior; partial removal
  can manufacture apparently-valid evidence — Lane 4 must not produce truth
  by deleting dangerous fields.

**Trusted verifier vs untrusted evidence (boundary):** the verifier FUNCTION
is bootstrap-registered trusted code; the EVIDENCE it returns remains
untrusted world data. Trusted code does not make a returned arbitrary object
safe. Lane 4 cannot prevent a malicious verifier's own internal code (e.g.
its own `Promise.resolve(hostile)`) from executing — that execution belongs
to the verifier's process. The invariant Lane 4 enforces is that LANE 4
never invokes attacker-controlled meta-object behavior while transporting or
classifying observation results.

**Timeout / duplicate / late completion (sink semantics):** only the FIRST
valid completion before the timeout finalizes the observation. Duplicate
completions (success-then-success, success-then-error, error-then-success)
and late completions after timeout are ignored: they can never mutate the
finalized canonical `VerificationResult` and can never trigger compensation.
The sink is exactly-once by construction; a verifier holding a sink
reference cannot rewire it (frozen) or mutate a finalized result through it.

**Classification outcomes** map to contracts, never to world claims:
`hostile` (Proxy / revoked proxy / non-plain exotic rejected at the gate)
poisons the observation → verifier-infrastructure `ERROR`; `inert`
(functions/symbols/bigints/undefined/non-finite numbers/class instances)
are sanitized to `null` per the established evidence contract; `primitive`/
`array`/`object`/`error` are sanitized/bounded normally. Sanitizer failure
is NEVER reinterpreted as `VERIFIED_SUCCESS`, `VERIFIED_FAILURE`, or
`INCONCLUSIVE` evidence success.

---

## 9. VERIFICATION TIMEOUT

Verification timeout means:

```
verification could not establish truth within the bound
```

NOT "action failed", and NOT "action succeeded". Timeout yields `TIMED_OUT`
(or `INCONCLUSIVE` where the policy explicitly says compensation is unsafe
under ambiguity). There is NO silent actuation retry from a verification
timeout.

---

## 10. EVIDENCE MODEL

Evidence records:

* what was expected (immutable copy of the postcondition)
* what was observed (sanitized)
* how observed (verifier binding id)
* verifier identity + incarnation
* timestamps
* source provenance (execution identity, authority generation)
* sanitized detail

The Audit Ledger may record evidence but remains historical evidence only.
`AUDIT != CURRENT TRUTH`. `MEMORY != CURRENT TRUTH`.

---

## 11. COMPENSATION TRIGGER

Compensation is considered ONLY after verification produces a state that
requires corrective action. The canonical `compensate()` path accepts only
`VERIFIED_FAILURE` as a trigger.

Compensation is NOT triggered merely because:

* the actuator timed out,
* the verifier timed out,
* the result is `INCONCLUSIVE`,
* the verifier returned `ERROR`.

Ambiguity is preserved, not resolved by re-actuation.

---

## 12. COMPENSATION IS A NEW ACTION (critical)

Compensation MUST NOT bypass Lane 2/Lane 3 authority. Compensation is itself an
action. Therefore:

```
compensation proposal
        |
        v
canonical ActionIntent (fresh admission)
        |
        v
current Lane 2 authority evaluation (fresh revalidation)
        |
        v
fresh Lane 3 actuation (execute())
        |
        v
Lane 4 verification of the compensation's own postcondition
        |
        v
(only then) any restoration claim
```

There is NO path `verification failure -> direct compensator()`. The
canonical `compensate()`:

1. requires the source verification to be a canonical `VerificationResult`
   produced by THIS runtime (never a caller-forged lookalike);
2. requires the source verification state to be `VERIFIED_FAILURE`;
3. forms an immutable `CompensationPlan`;
4. admits a fresh canonical `ActionIntent` for the compensation action;
5. routes it through the Lane 3 canonical `execute()`, which performs fresh
   Lane 2 revalidation against current authority;
6. reports the compensation execution state; and
7. NEVER claims restoration until a separate fresh verification of the
   compensation's own postcondition returns `VERIFIED_SUCCESS`.

---

## 13. COMPENSATION AUTHORITY

A previous `ALLOW` for the original action does NOT automatically authorize its
compensation:

```
permission to delete file  !=  permission to recreate file
permission to turn device on  !=  permission to turn it off
```

Compensation must have its own capability, operation, scope, authority,
current session/principal, and incarnation checks. Revoked authority for the
compensation action => no compensation actuation. Stale capability incarnation
=> no compensation actuation. Foreign session => no compensation actuation.

---

## 14. COMPENSATION PLAN

`CompensationPlan` is immutable and descriptive:

```
{
  schemaVersion: 1,
  compensationId,              // uuid minted by the trusted former
  sourceVerificationId, sourceExecutionId,
  principal,
  capabilityId, capabilityIncarnationId, operation, scope[],
  parameters,                  // declarative plain values (detached/bounded)
  reason,                      // sanitized reason string
  createdAtMs
}
```

There is NO executable function inside plan metadata. The plan is descriptive
only; executing it is a new action that traverses the full canonical
Lane 2 → Lane 3 chain.

---

## 15. COMPENSATOR TRUST

Compensation is expressed as normal canonical action routing. There is NO
hidden compensator function surface and NO direct rollback function exposed
downstream. A caller-presented compensator option is rejected with
`CALLER_EXECUTOR_REJECTED`. If a dedicated compensator registry becomes
necessary in a later lane, it must obey the same bootstrap ownership and
incarnation rules as the actuator/verifier registries.

---

## 16. COMPENSATION RESULT

Tracked separately from verification:

```
COMPENSATION_PROPOSED
COMPENSATION_AUTHORIZED
COMPENSATION_EXECUTED
COMPENSATION_VERIFIED
COMPENSATION_FAILED
COMPENSATION_INCONCLUSIVE
```

There is deliberately NO `ROLLED_BACK` state. `COMPENSATION_EXECUTED !=
original state restored`. The `restored` field of a compensation result is
`null` until a SEPARATE fresh verification of the compensation's own
postcondition returns `VERIFIED_SUCCESS`.

---

## 17. NO FALSE ROLLBACK CLAIM

```
compensation executed  !=  original state restored
```

If a compensation action runs but its verification is `INCONCLUSIVE` or
`TIMED_OUT`, restoration is NOT claimed. Ambiguity is preserved. The only path
to a restoration claim is a fresh verification with `VERIFIED_SUCCESS` on the
compensation's own postcondition — and even then it is verified
per-postcondition, never a blanket rollback.

---

## 18. IDEMPOTENCE / DUPLICATE CONTROL

* `verificationId` is process-locally unique. A duplicate verification of the
  same canonical execution with the same expected postcondition reuses the
  SAME canonical record — observers with side effects fire exactly once per
  verification identity.
* `compensationId` is process-locally unique. A duplicate compensation with
  the same `compensationId` returns the SAME record; no duplicate actuation
  occurs.
* Lane 3's exact-once guard is reused (the compensation dispatches through
  `execute()`); Lane 4 does NOT invent a parallel weaker execution path.

### Process-local scope

The exact-once scopes for verification and compensation are
**process-local**. They are not cross-process guarantees. A multi-process
deployment requires an external durable coordination layer; Lane 4 does not
pretend otherwise.

---

## 19. RACE / STALENESS

Before verification:

* the execution result is canonical (brand-checked);
* the capability/actuator incarnation references remain interpretable
  (verified against the binding);
* the verifier incarnation is current (resolved fresh per `verify()`).

Before compensation:

* a fresh authenticated session is established through the canonical
  authentication path (which fails closed until a later lane wires real
  trusted auth infrastructure);
* fresh capability state (re-admission);
* fresh authority (Lane 2 revalidation inside `execute()`);
* fresh actuator routing (Lane 3 dispatcher).

Stale verification evidence is NEVER bearer compensation authority. The
canonical `compensate()` re-derives the trigger from the canonical record held
inside the trusted runtime.

---

## 20. CANONICAL BRAND / PROVENANCE MODEL

```
VerificationRequest  -> per-composition WeakSet (declared INSIDE createCanonicalVerificationComposition)
VerificationResult   -> per-composition WeakSet (declared INSIDE createCanonicalVerificationComposition)
CompensationPlan     -> per-composition WeakSet (declared INSIDE createCanonicalVerificationComposition)
```

Applying the lessons from Lane 3 AND the Lane 2 first-binder rejection:

* brand state is COMPOSITION-LOCAL — declared fresh inside
  `createCanonicalVerificationComposition` (the trusted internal composition
  module), so every composition instance owns an independent provenance
  domain (TARGETED REPAIR 5);
* no mutable WeakSet is exported; no module-global canonical membership
  store exists (a structural test enforces this);
* no brand Symbols carry authenticity — per-instance WeakSet membership is
  the only authority-bearing provenance proof;
* brand recognition is BRAND-FIRST — instance-local WeakSet membership decides
  before any property read;
* zero hostile `Proxy` traps execute during recognition;
* predicates recognize provenance only;
* downstream cannot mint membership;
* cross-composition artifacts are rejected: an artifact minted by
  composition A is NOT canonical to composition B, regardless of creation
  order.

The brand predicates live as METHODS on the canonical verification facade
returned by `createCanonicalVerificationFacade()`. They are NOT free
functions on any module export.

---

## 21. PRODUCTION FACADE

The production downstream surface is EXACTLY:

```
Object.freeze({
    verify,
    compensate,
    isCanonicalVerificationRequest,
    isCanonicalVerificationResult,
    isCanonicalCompensationPlan
})
```

* `verify({ executionResult, expectedPostcondition, timeoutMs? })` —
  returns a canonical immutable `VerificationResult`.
* `compensate({ verification, capabilityId, operation, principal, scope?,
  parameters?, reason, compensationId? })` — returns a canonical immutable
  compensation result.

The facade exposes NO:

* verifier registry / registrar,
* compensator registry / registrar,
* stores,
* canonical builders / formers,
* brand state / brand tokens,
* raw observer functions,
* raw compensation executor.

`createCanonicalVerificationFacade()` takes NO options — canonical
composition is bootstrap-owned.

---

## 22. NO TEST-ONLY PRIVILEGE IN PRODUCTION

Tests that need test verifier/compensation registration use the explicitly
test-only harnesses under `tests/verification/` and `tests/compensation/`.
Production `src/**` never imports `tests/**` (a structural test enforces this).

### Two test harness tiers

**Mirror harness** (`tests/verification/harness.js`): owns a SEPARATE
test-domain implementation (separate brands, separate verifier registry,
separate sanitizer, separate compensation flow). Used for foreign-domain
tests, isolated adversarial mutation, and differential testing. Its success
is NOT sufficient as production-path certification proof — the audit requires
R3 own-then proofs to run against the REAL production code.

**Production harness** (`tests/verification/productionHarness.js`,
TARGETED REPAIR 4): wiring ONLY — NO Lane 4 logic copies. It imports the SAME
trusted internal composition function
(`src/action/internal/verificationBootstrap.js::createCanonicalVerificationComposition`)
that production uses (`src/action/bootstrap.js` calls it with
`trustedVerifiers = []`). The production harness supplies test-only Lane 2/3
facade factories (the composition's deps, injected at trusted composition
time) and test-supplied verifier definitions, consumed ONLY at composition
time. R3/R1/R2 certification proofs exercised through this harness exercise
the production implementation, not a test-domain mirror.

### Trusted internal composition module

`src/action/internal/verificationBootstrap.js` is an INTERNAL trusted module:
- it is NOT re-exported through `src/action/index.js` (the public surface);
- ordinary downstream callers CANNOT reach it through the canonical
  bootstrap facade (the facade still exposes exactly
  `{ verify, compensate, isCanonical* }`);
- the production runtime calls it via `src/action/bootstrap.js` with
  `trustedVerifiers = []` (NO test verifiers);
- the test-only production harness calls it via the SAME function with
  test-supplied verifier definitions.

After the facade is constructed, NO caller — production or test — can
register, inject, or mutate verifiers. There is NO public registrar, NO
token, NO host capability. **AVAILABLE != AUTHORIZED**: test composition
privilege does NOT become production-downstream privilege.

### Composition == provenance domain (TARGETED REPAIR 5)

**COMPOSITION INSTANCE != SHARED TRUST DOMAIN.** The brand WeakSets
(`vRequestBrandSet4` / `vResultBrandSet4` / `vPlanBrandSet4`) are declared
FRESH inside `createCanonicalVerificationComposition` — every composition
instance owns an INDEPENDENT provenance domain:

- a `VerificationRequest` minted by composition A is canonical ONLY to A;
- a `VerificationResult` minted by composition A is canonical ONLY to A;
- a `CompensationPlan` minted by composition A is canonical ONLY to A;
- composition B (any other instance) rejects ALL of them;
- cross-composition compensation is rejected BEFORE Lane 2 admission and
  Lane 3 execution (zero calls for foreign-domain attempts);
- creation order is irrelevant: the first composition created does NOT
  establish shared/global trust (the Lane 2 first-binder bug class).

**TRUSTED IMPLEMENTATION != SHARED TRUST DOMAIN.** The internal factory being
available does NOT confer canonical application production provenance. An
attacker-controlled composition built from the same factory (attacker deps +
attacker verifier) produces artifacts that the canonical application
composition rejects as foreign (`NOT_CANONICAL_EXECUTION_RESULT`), before any
authority evaluation or actuation.

**FACTORY AVAILABLE != CANONICAL PRODUCTION PROVENANCE.** The canonical
application instance is created ONLY through the trusted
`src/action/bootstrap.js`. Alternate/test compositions are FOREIGN domains;
their artifacts are rejected by the canonical application facade.

Brand Symbols carry ZERO authenticity: membership in the per-instance WeakSet
is the ONLY authority-bearing provenance proof (the unused module-level brand
Symbols were removed in R5). Module-level state in the internal module is
classified as:
- (A) immutable vocabulary (frozen key lists, bounds, pure functions) — allowed;
- (B) process-global operational (Node builtins) — allowed;
- (C) composition-local trust state (brand WeakSets, verifier registry,
  idempotence Maps) — MUST live inside the composition closure.

### AVAILABLE != AUTHORIZED

Test-only verifier bootstrap privilege is AVAILABLE in the trusted test
composition (via `trustedVerifiers` consumed at composition time) but NOT
AVAILABLE TO PRODUCTION DOWNSTREAM (the production facade exposes exactly
`{ verify, compensate, isCanonical* }`). Structural tests enforce:
- the production facade exposes no privileged surface;
- the internal module is not reachable through the public package;
- `src/**` never imports `tests/**`.

---

## 23. LANE 4 vs LANE 5 BOUNDARY

Lane 4 owns: verification contracts, evidence, verifier registration/binding,
postcondition evaluation, effect-state classification, compensation planning,
compensation authorization boundary, compensation dispatch coordination
(through Lane 3), bounded retry/idempotence semantics, unresolved/ambiguous
outcome handling, and immutable verification/compensation evidence.

Lane 5 (NOT STARTED) will own: multi-step orchestration, routing, sequencing,
workflow composition, and planner-driven multi-action plans. Lane 4 contains
NO routing, NO orchestration, NO multi-step plan execution. A structural test
enforces that no Wave 5 surface is introduced by Lane 4.

---

## 24. REGRESSION

The certified Lane 1–3 + Damar/Pandawa foundation is preserved unchanged:

* Lane 1 Capability Registry & Graph V1
* Lane 2 Action Intent + Authority Gate V1
* Lane 3 Actuation Fabric V1
* Damar canonical identity, Pandawa boundaries
* bootstrap ownership, session provenance, fresh authority revalidation
* capability/actuator incarnation rules
* duplicate/timeout/cancel semantics
* no privileged public factories, no mutable provenance brands

Lane 4 adds composition only; the certified Lane 2 `evaluate`/`admit` and
Lane 3 `execute` surfaces are consumed, never modified.

---

## 25. REQUIRED SECURITY PROOFS

The 27 required Lane 4 proofs and the hostile-input probes live in
`tests/verification/security.test.js`. The deterministic storm
(`tests/verification/storm.test.js`) exercises ≥12,000 mixed
verification/compensation operations per seed with all 22 violation counters
required to remain zero.
