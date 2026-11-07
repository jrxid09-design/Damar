# Action Actuation Fabric V1 (Lane 3 — post FIRST targeted repair)

Status: candidate (production-unwired; actuator wiring via trusted/test-only
harness)
Branch: `feat/action-authority-v1`
Foundation: `1913252` (Lane 3 first implementation), on `45bc318`
(Lane 2 certified closed), `47827c9` certified Lane 1.
Code: `src/action/actuation/**`, `src/action/bootstrap.js`,
`tests/actuation/**`

## Purpose

Lane 2 answers:

```
what action is proposed?       (ActionIntent)
is it currently authorized?    (AuthorityDecision)
```

Lane 3 answers:

```
how is an authorized action dispatched to the correct actuator?
how do we preserve execution provenance and fail safely?
```

Lane 3 MUST NOT decide authority independently: fresh canonical Lane 2
revalidation happens INSIDE execute(), before any dispatch.

## Core laws

```
AVAILABLE != AUTHORIZED
AUTHORIZED != EXECUTED
EXECUTED != SUCCEEDED
SUCCEEDED != VERIFIED

PLAN != AUTHORITY
INTENT != AUTHORITY
CHANNEL != AUTHORITY
MODEL CLAIM != AUTHORITY
MEMORY != AUTHORITY

AUTHORITY DECISION IS HISTORICAL EVIDENCE,
NOT A BEARER EXECUTION TOKEN.
```

## FIRST targeted repair — private composition + closure-private brands

The first Lane 3 implementation left the privileged constructors as DIRECT
EXPORTS of production actuation submodules (buildActuatorRegistry,
composeDispatcher, formExecutionRequest, createLifecycleTracker,
buildExecutionResult/buildExecutionEvidence) and exposed the canonical brand
WeakSets + tokens (requestBrandSet/resultBrandSet/REQUEST_BRAND/RESULT_BRAND)
from errors.js — a confirmed direct-import exploit (rogue actuator
registration) and a provenance-defeating brand mutation
(`errors.requestBrandSet.add(forged)`). The repair applies Lane 2's certified
ownership discipline:

- **ALL privileged Lane 3 construction now lives inside the trusted
  bootstrap's private lexical closure** (`src/action/bootstrap.js`): the
  actuator registry + registrar, the dispatcher, the request former, the
  lifecycle tracker, the result/evidence builders, the hostile-output
  sanitizer, AND the canonical brand WeakSets. No binder, no token, no
  first-call-wins host, no secret argument, no shape validation — acquiring
  privileged construction requires ALREADY executing inside that closure.
- **Production actuation submodules export ONLY inert vocabulary + pure
  predicates.** Direct imports of `actuatorRegistry.js`, `dispatcher.js`,
  `executionRequest.js`, `result.js`, `lifecycle.js`, `errors.js` yield no
  constructor of any kind — verified by a DIRECT module.exports scan over
  every production actuation module (not just index re-exports).
- **Brand state is closure-private.** The brand WeakSets and tokens are NOT
  exported from ANY production module. Brand membership is established ONLY
  by the private formers inside the bootstrap closure. Downstream can ASK
  "is this canonical?" — via the two PURE brand-first recognition predicates
  exposed as METHODS on the canonical actuation facade
  (`isCanonicalExecutionRequest` / `isCanonicalExecutionResult`), which read
  the closure-private WeakSets directly. Downstream cannot CAUSE "make this
  canonical": no export accepts an arbitrary object and marks it canonical.
- **Test isolation**: the test harness (`tests/actuation/harness.js`) owns
  its OWN private copies of all privileged implementations and its OWN
  brand WeakSets (a distinct test-domain brand). Production `src/**` never
  imports `tests/**`. A test-domain-branded result is REJECTED by the
  production facade predicate — distinct closures prove the predicates read
  real brand membership, not shape.

## Canonical bootstrap ownership

```
TRUSTED BOOTSTRAP LAYER  (src/action/bootstrap.js)
        │
        │ owns (defined in its PRIVATE lexical closure):
        ├── Lane 2 canonical facade (admit / evaluate / authenticate / session)
        ├── PRIVILEGED Lane 3 constructors (closure-private):
        │     buildActuatorRegistry3 / composeDispatcher3 /
        │     formExecutionRequest3 / createLifecycleTracker3 /
        │     buildExecutionResult3 / buildExecutionEvidence3 /
        │     sanitizeActuatorOutput3
        ├── CANONICAL BRANDS (closure-private WeakSets + tokens):
        │     requestBrandSet3 / resultBrandSet3 (populated ONLY by the
        │     private formers)
        ├── actuator registry + REGISTRAR CAPABILITY (bootstrap-owned;
        │     downstream NEVER receives it)
        └── canonical dispatcher (fresh-revalidating, exact-once guard,
              timeout/cancellation boundaries)
                │
                ▼
        frozen least-privilege actuation facade:
            Object.freeze({
              execute,
              isCanonicalExecutionRequest,   // PURE brand-first predicate
              isCanonicalExecutionResult     // PURE brand-first predicate
            })
```

`createCanonicalActuationFacade()` takes NO options (any option is rejected
with `CALLER_BOOTSTRAP_REJECTED`).

## Production module surfaces (after repair)

| module | exports |
|---|---|
| `actuation/index.js` | LIFECYCLE, RESULT_STATE, REASONS, TRANSITIONS, ExecutionError |
| `actuation/errors.js` | LIFECYCLE, RESULT_STATE, REASONS, fail |
| `actuation/lifecycle.js` | LIFECYCLE, TRANSITIONS, isLifecycleState, isLegalTransition, isCancellable, isTerminal |
| `actuation/executionRequest.js` | REQUEST_SCHEMA_VERSION, BOUNDS |
| `actuation/actuatorRegistry.js` | READINESS, isReadiness |
| `actuation/result.js` | RESULT_SCHEMA_VERSION, EVIDENCE_SCHEMA_VERSION |
| `actuation/dispatcher.js` | DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, CALLER_EXECUTOR_KEYS, BEARER_DECISION_KEYS, isValidTimeoutMs, isCallerExecutorKey, isBearerDecisionKey |
| `bootstrap.js` (Lane 3) | createCanonicalActuationFacade (no options), PRIVILEGED_KEYS |

NOT exported anywhere: buildActuatorRegistry, composeDispatcher,
formExecutionRequest, createLifecycleTracker, buildExecutionResult,
buildExecutionEvidence, sanitizeActuatorOutput, registrar, registerActuator,
removeActuator, requestBrandSet, resultBrandSet, REQUEST_BRAND, RESULT_BRAND,
and every equivalent privileged construction/mint surface.

## Actuator registry model

Each binding identifies: capabilityId (canonical), operations, exact
capabilityIncarnationId, actuatorId (stable logical id),
actuatorIncarnationId (fresh per registration — ABA-safe), readiness, and
the invocation function captured ONCE at trusted registration (caller-object
mutation after registration has zero semantic effect). Atomic registration
(duplicate capabilityId+operation rolls back).

## ExecutionRequest schema

Immutable, deep-frozen, schemaVersion 1: executionId, intentId,
capabilityId, capabilityIncarnationId, operation, principal, canonical scope,
authorityGeneration (observed at revalidation), admittedAtMs, requestedAtMs,
parameters (detached bounded snapshot), metadata (bounded; authority-shaped
keys rejected recursively). No hidden authority inside arbitrary metadata.

## Fresh revalidation path

execute(): (1) rejects caller-executor and bearer-decision options;
(2) requires canonical ActionIntent + authenticated session; (3) REVALIDATING
→ fresh canonical Lane 2 evaluate(); (4) non-ALLOW ⇒ FAILED, NO EXECUTION;
(5) capability-incarnation re-check against the fresh decision; (6) actuator
binding resolution with existence/incarnation/readiness gates; (7) READY ⇒
dispatch. There is NO path: old ALLOW → direct actuator().

## Exact-once semantics

Deterministic content key (sha256 of intent identity + capability incarnation
+ operation + session identity + scope + parameter-hash + metadata-hash):
duplicate in-flight → same promise; completed replay → recorded result, no
second actuation; conflicting payload → different execution. HONEST SCOPE:
process-local / runtime-local (in-memory Map, bounded at 4096 completed
results with FIFO eviction). NOT a distributed exactly-once guarantee.

## Lifecycle model

```
CREATED → REVALIDATING → READY → DISPATCHING → EXECUTED | FAILED | TIMED_OUT
                ↘ FAILED              ↘ CANCELLED (pre-dispatch only)
```

Frozen transition table; illegal transitions fail closed. NO VERIFIED state
(Lane 4 owns verification). EXECUTED = actuator invocation completed per Lane
3 semantics, NOT verified real-world effect.

## Timeout / cancellation semantics

Timeout (default 30s; per-execution [1ms, 5min]) → TIMED_OUT; no silent
retry; **timeout != proof of no side effect** (ambiguity preserved).
Pre-dispatch abort → CANCELLED with zero invocations. Abort after invocation
started → execution continues to its honest real outcome (never a false
"prevented" claim).

## Result / evidence model

Structured result (deep-frozen): executionId, intentId, capabilityId,
capabilityIncarnationId, operation, principal, actuatorId,
actuatorIncarnationId, state, startedAtMs, completedAtMs, actuatorReport
(sanitized), failureReason/failureDetail, authorityGeneration, lifecycleTrace,
`verified: null` + `verificationClaim: null` (explicit non-claims). Audit
evidence: who/what/which lifetimes/why authorized (authority generation at
revalidation)/when/outcome. The Audit Ledger is NOT the source of current
truth. Hostile actuator output is sanitized (Errors → name+message; no
functions/symbols/exotics escape).

## Security regression tests

## SECOND targeted repair — brand-first hostile-object safety

The first-repair brand predicates inspected attacker-controlled properties
(`schemaVersion`, `executionId`) BEFORE checking closure-private WeakSet
membership. A hostile Proxy candidate therefore executed its `get` trap even
though the object was not canonical — a HIGH-severity predicate-ordering
defect.

Fix: recognition is now BRAND-FIRST. The predicates read ONLY:

    if (value === null || typeof value !== "object") return false;
    if (!requestBrandSet3.has(value)) return false;   // request
    if (!resultBrandSet3.has(value)) return false;    // result
    return true;

`WeakSet.has` performs a reference-identity check (zero attacker-controlled
property access). Recognition of NON-canonical objects executes ZERO get/has/
ownKeys/getOwnPropertyDescriptor/getPrototypeOf traps. The private formers
already establish canonical structure when minting, so the public provenance
predicate recognizes PROVENANCE, not shape — re-validation is unnecessary and
unsafe against hostile inputs.

Trap-counting regression tests (BF-1 through BF-11) verify: hostile Proxy
candidates return false with zero traps; plain/frozen/JSON/null-prototype
lookalikes return false; test-domain branded objects remain false in the
production predicate; genuine production canonical results remain true;
repeated recognition does not mutate membership.

Storm gains two active counters: `hostileRequestPredicateTrapExecution`,
`hostileResultPredicateTrapExecution` (instrumented Proxy traps during
recognition of a noncanonical object).

`tests/actuation/security.test.js` (34 tests): all 18 required Lane 3 proofs,
the brand regression block (10 tests: brand sets/tokens undefined from every
production import; no exported function can mark an arbitrary object
canonical; frozen/JSON clone rejection; lookalike rejection; foreign
test-domain object rejected by the production predicate; predicates are pure
and the facade is frozen), and the DIRECT module.exports structural scan
(every production actuation module must expose only inert vocabulary +
pure predicates — checked regardless of index re-exports).

`tests/actuation/storm.test.js` (2 tests): ≥12,000 deterministic mixed
operations ×2 seeds + divergent seed; all 21 violation counters zero with
ACTIVE detection paths, including the four FIRST-repair counters
and the two SECOND-repair hostile-predicate counters:
`directRegistryFactoryAcquired`, `directDispatcherFactoryAcquired`,
`exportedRequestBrandMutated`, `exportedResultBrandMutated` (each scans the
actual module.exports of every production actuation module + bootstrap for
factory/mint surfaces).

## Test results

- Lane 3 targeted: 46 tests (44 security + 2 storm), 0 failures
- Lane 2 regression: 89 tests, 0 failures
- Lane 1 capability + canonical Authority: 186 tests, 171 pass, 15 fail —
  the 15 are the documented pre-existing `sqlite3` native-module environment
  nonblockers, IDENTICAL to the Lane 2 baseline (verified via stash); zero
  regressions, no unrelated dependencies touched.
- Lane 2 differential (>=2200 cases): lane2AllowCanonicalReject = 0,
  lane2AllowCanonicalDeny = 0.

## Known nonblockers

- Production actuator wiring: the canonical registrar capability is owned by
  the bootstrap closure; a later lane wires real actuators through trusted
  composition.
- Exactly-once is process-local (documented above), not distributed.
- OWNER_CONFIRMATION_REQUIRED remains semantic-only (Lane 2 nonblocker).
- sqlite3-native authority tests: environment-only failures (see above).
- Lane 4 (verification/compensation) intentionally NOT implemented: results
  carry `verified: null` and no VERIFIED lifecycle state exists.
- Brand predicates are facade methods (not free functions): a closure-private
  brand cannot be recognized by a free function in a non-privileged module
  without either exporting the WeakSet (forbidden) or degrading to a
  forgeable structural check (rejected).
