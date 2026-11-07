# Action Intent + Authority Gate V1 (first-binder trust + caller authenticator + facade seeding REMOVED)

Status: candidate (post SEVENTH repair, production-unwired)
Branch: `feat/action-authority-v1`
Base: `43ac241` (Wave-4 sixth repair), on `ff7f967` fifth repair,
`4831641` runtime-local trust domain, `b6b3904` sealed runtime,
`47827c9` certified Lane 1.
Code: `src/action/**`, `src/authority/evaluate.js`, `tests/action/**`

## Purpose

Answers exactly two questions, without executing anything:

```
1. What action is being proposed?         (ActionIntent)
2. Is that proposed action authorized?    (AuthorityDecision)
```

## Canonical bootstrap ownership (seventh repair — CORE LAWS)

CORE LAW:

```
caller-selectable verifier != authenticated identity authority
```

Before the sixth repair the public action package exported both
`createAuthenticationDomain` and `createActionAuthorityRuntime`, and the
runtime constructor accepted a caller-supplied `authVerifier`. That meant
any caller that possessed canonical CapabilityRuntime + AuthorityStore
references could select the identity verifier governing canonical
authorization:

```
attacker obtains canonical CapabilityRuntime
attacker obtains canonical AuthorityStore
attacker creates new action runtime around them
attacker selects verifier
attacker impersonates victim
```

Shape validation or branding inside a caller-created AuthenticationDomain did
NOT solve this, because the attacker could create the domain itself.

### Canonical ownership graph

The sixth+seventh repairs remove that hole by owning canonical composition
INTERNALLY. There is exactly ONE canonical ActionAuthorityRuntime, assembled
by a trusted runtime/bootstrap layer (`src/action/bootstrap.js`). The
public/downstream Action package exposes no factories that let callers
construct another authority runtime over canonical state.

```
DAMAR TRUSTED BOOTSTRAP LAYER  (src/action/bootstrap.js)
        │
        │ owns (defined in its PRIVATE closure + constructed once internally —
        │       NOT caller-supplied, NOT importable):
        ├── privileged composition functions
        │     - composeActionAuthorityRuntime  (private closure fn)
        │     - composeAuthenticationDomain    (private closure fn)
        ├── canonical CapabilityRuntime   (via createCapabilityRuntime)
        ├── canonical AuthorityStore      (via createMemoryAuthorityStore)
        ├── canonical AuthenticationDomain (composed over the FIXED
        │     bootstrap-owned canonical auth adapter)
        │     - owns authenticate(...)
        │     - owns the runtime/session-domain brand (closure-local WeakSet)
        │     - owns the ONLY session mint path (authenticate() success)
        │     - owns the verifier capability (brand-first, zero-trap)
        ├── canonical trusted scope bindings (captured ONCE, detached)
        └── hardened clock (read-once function identity)
                │
                ▼
        INTERNAL composition only (private closure functions, called here)
                │
                ▼
        Canonical ActionAuthorityRuntime
                │
                ▼
        frozen least-privilege PRODUCTION facade returned to downstream:
            { admit, evaluate, authenticate, session }
```

Downstream (Console, CLI, Telegram, WhatsApp, Companion, extensions,
devices, providers) receives ONLY this facade. They MUST NOT choose:

- auth verifier / authenticator / any identity authority
- AuthenticationDomain
- Authority store
- Capability registry/runtime
- canonical evaluator
- evaluation verifier
- gate implementation
- any seeding/provisioning capability (grantAuthority, registerCapability,
  registry, registrars, store, ...)

### Bootstrap-private construction (seventh repair — the mechanism)

The seventh repair removes the sixth repair's LAST privileged surfaces:
`bindCompositionHost(module)` / `bindAuthenticationHost(module)` — exported
privileged composition APIs with first-binder-wins semantics (a fresh-process
attacker could acquire both privileged constructors before the production
bootstrap loaded). Both are REMOVED, along with every equivalent name
(bindHost / acquireHost / registerHost / installHost / claimComposition /
bootstrapBind / hostToken / getFactory / getComposer):

```
require("src/action/runtime").bindCompositionHost      === undefined
require("src/action/authDomain").bindAuthenticationHost === undefined
```

The privileged composition functions are now defined INSIDE the trusted
bootstrap module's private closure (`src/action/bootstrap.js`). `runtime.js`
and `authDomain.js` are PURE NON-PRIVILEGED modules (inert vocabularies +
pure non-authorizing predicates only). There is no binder, no token, no
host capability, no first-call-wins registry anywhere: acquiring privileged
construction requires ALREADY executing inside the trusted bootstrap's own
closure — i.e. being the trusted bootstrap itself. A fresh-process attacker
importing every action module before the bootstrap loads acquires nothing,
and the canonical bootstrap still initializes correctly afterward.

### No caller-selectable authenticator (Blocker 2 — seventh repair)

The production canonical runtime is created by `createCanonicalActionFacade()`
which takes NO options. It does NOT accept `authenticate`, `authenticator`,
`authenticationProvider`, `verifyCredentials`, `resolvePrincipal`,
`authVerifier`, `verifier`, or any equivalent caller-selected identity
authority — every such option is rejected with `CALLER_BOOTSTRAP_REJECTED`
(and any option at all is rejected: the facade accepts no options).

The canonical AuthenticationDomain is bound internally to the FIXED
bootstrap-owned authentication adapter (`canonicalAuthAdapter`). For Lane 2 —
where full production owner-auth infrastructure is not yet wired — the
adapter FAILS CLOSED unconditionally: no session is ever minted from caller
input, no caller-asserted principal is ever trusted. The canonical runtime
evaluates but every session is INVALID_IDENTITY until a later lane wires the
real trusted auth infrastructure INTO THE BOOTSTRAP MODULE (never via a
constructor option). Arbitrary caller input is never silently treated as
authenticated.

### Production facade = exactly least privilege (Blocker 3 — seventh repair)

The production facade is EXACTLY:

```
Object.freeze({ admit, evaluate, authenticate, session })
```

- `admit(serializedProposal)` -> canonical identity-free ActionIntent
- `evaluate(intent, session)` -> AuthorityDecision
- `authenticate(evidence)`    -> the FIXED canonical auth path (fail-closed
  adapter); cannot mint a principal the trusted infrastructure did not
  establish
- `session(...)`              -> convenience wrapper over authenticate();
  with the fixed fail-closed adapter this can never mint from caller input

It MUST NOT and DOES NOT expose: `grantAuthority`, `revokeAuthority`,
`seedAuthority`, `registerCapability`, `unregisterCapability`, `registry`,
`registrars`, AuthorityStore, CapabilityRuntime, capability registrar,
evaluator, verifier, AuthenticationDomain, `mintSession`, `issueIdentity`,
bootstrap hooks.

Authority/capability seeding belongs to a SEPARATE privileged
bootstrap/provisioning interface that downstream never receives:

- tests: `tests/action/bootstrapHarness.js` (explicitly test-only module; owns
  register capability, seed/grant authority, test authenticator injection,
  and isolated trust-domain composition for cross-domain replay proofs)
- production startup: a trusted provisioning capability in a later lane

### Test-only composition separation (seventh repair)

Production dependency injection was NOT re-opened for tests. The separation:

- production: `src/action/bootstrap.js` — `createCanonicalActionFacade()` with
  NO options, fixed bootstrap-owned auth
- tests: `tests/action/bootstrapHarness.js` — `makeHarness({ authenticate,
  scopeBindings })` with per-test trust domains, `grantAuthority` seeding,
  `registerCapability`, and `composeIsolatedTrustDomain` for cross-domain
  replay proofs

The test harness lives under `tests/`, is NOT reachable from any
`src/action` production export, and grants no access to the canonical
runtime's brand, state, or facade.

## AuthenticationDomain (src/action/bootstrap.js — private closure)

Composed ONLY by trusted Damar bootstrap, inside its private closure,
OUTSIDE any public constructor. Its closure owns:

- `authenticate(evidence)` — the single public identity surface. Resolves
  external channel/session evidence through the trusted authenticator bound by
  bootstrap. On ANY failure (throw, null, undefined, malformed, missing
  principal) returns `null` — fail closed, nothing minted, no caller-identity
  fallback. On success it mints a session branded to THIS domain and carrying
  the principal that trusted authentication established — nothing else.
- `verifier` — the ONLY capability ActionAuthorityRuntime receives. Brand-first
  (zero property access before membership check => zero Proxy traps on
  rejection). Returns the authenticated principal string for a session branded
  by THIS domain, or null for anything else.
- The session brand `WeakSet` — closure-local, not module-global, not shared,
  not reachable from any other domain or caller. The only adder is the
  authenticated mint path above; the only reader is the verifier above.

### Fail-closed authentication law (no caller-principal fallback, ever)

`authenticate(evidence)` returns:

- a record with a non-empty string principal -> AUTHENTICATED (mint a session)
- null / undefined / false / `""` / `0` / missing principal / non-string
  principal / malformed / throws -> AUTH FAILED

On AUTH FAILED nothing is minted, nothing is branded, and no identity field
from the evidence (`principal` / `requestedPrincipal` / `claimedPrincipal` /
any caller string) is ever used as Authority identity. Caller-asserted name
strings are retained only as descriptive telemetry (`claimedPrincipal`), never
as Authority identity.

### AuthenticationDomain surface

Exactly `{ authenticate, verifier }`. NO `mintSession`, NO `issuer`, NO
`bindAuthentication`, NO `onReady`, NO brand accessor, NO `isAuthSession`.

## ActionAuthorityRuntime surface (bootstrap-issued)

Exactly `{ admit, evaluate }` on the runtime surface (the trusted bootstrap's
facade adds the authenticated-session mint path and bootstrap-owned seeding
helpers; see the ownership graph above). It MUST NOT expose:

- onReady, bindAuthentication, mintSession, issueIdentity, issueSession,
  createAuthSessionIssuer, authBinder, bootstrap, bootstrapCapability,
  trustedBootstrap, issuer, sessionIssuer, sessionBrand, authBrand,
  authVerifier, verifier, authDomain, gate, createGate, isAuthSession,
  session brand, session verifier internals, or any bootstrap callback.

## Runtime-local session brand design (unchanged from Wave 4)

The session brand is a `new WeakSet()` declared INSIDE the
`createAuthenticationDomain` closure. It is:

- **closure-local**: reachable only by the authenticated mint path and the
  verifier created in the same call. Not a module global, not a property of
  any exported object, not reachable from any other domain or caller.
- **per-domain**: every `createAuthenticationDomain` call creates a fresh,
  independent brand. There is no shared brand across domains.
- **unforgeable**: a session is accepted by runtime A's gate iff it was added
  to domain A's `sessionBrand` by domain A's authenticated mint path. Adding a
  plausible `runtimeId: "A"` string field to a session object carries zero
  trust weight — the decision is object-identity based (WeakSet membership),
  never string comparison.
- **brand-first verified**: `verify(session)` checks `sessionBrand.has(session)`
  BEFORE any property access, so a hostile Proxy cannot execute traps during
  rejection of an unbranded value.

Cross-runtime law (unchanged):

```
domainA session -> accepted only by the runtime composed over domainA
domainB session -> rejected by runtime A (INVALID_IDENTITY), and vice versa
```

This holds even when two runtimes are composed over the SAME canonical
capability registry + authority store: each runtime's AuthenticationDomain
mints its own brand, so a victim session minted by domain A is not in domain
B's brand and cannot be verified by B's gate. The attacker's own freshly
minted "victim" session is valid only on the attacker's runtime, proving
nothing about domain A.

## Composition rejection laws (bootstrap-private factory)

The privileged `composeActionAuthorityRuntime` function (defined INSIDE the
trusted bootstrap's private closure; NOT an export, NOT importable) rejects
at composition time with a typed `ActionError` when:

- `authVerifier` is missing or not a pre-bound verifier capability
  (`AUTH_VERIFIER_REQUIRED`) — there is no path to a runtime that evaluates
  identities without a trusted verifier.
- Any caller-bootstrap option key is present
  (`CALLER_BOOTSTRAP_REJECTED`) — there is no caller-owned auth bootstrap.
  Forbidden keys include: `onReady`, `bindAuthentication`, `mintSession`,
  `issueIdentity`, `issueSession`, `issuer`, `sessionIssuer`, `sessionBrand`,
  `authBrand`, `authBinder`, `bootstrap`, `createAuthSessionIssuer`,
  `authSessionIssuer`, `bootstrapCapability`, `trustedBootstrap`.

`createCanonicalActionFacade` (the trusted bootstrap's production entry)
accepts NO options AT ALL: any option — `authenticate`, `authenticator`,
`authenticationProvider`, `verifyCredentials`, `resolvePrincipal`,
`authVerifier`, `verifier`, `capabilityRuntime`, `authorityStore`,
`authDomain`, `evaluator`, `gate`, `registry`, `store`, `clock`,
`trustedScopeBindings`, or anything else — is rejected with
`CALLER_BOOTSTRAP_REJECTED`. All canonical state, the fixed fail-closed auth
adapter, and the verifier are constructed inside the bootstrap closure.

Injected evaluator/verifier options (`authorityEvaluator`,
`isCanonicalEvaluation`, `verifySession`, `evaluator`, `gate`) are NEVER read
for trust — they are simply ignored by the internal composition (and at the
bootstrap layer, rejected outright). Only the pre-bound verifier's
brand-acceptance decides identity.

## Blocker resolutions

### B1 (Wave 4) — public session issuer removed
`createAuthSessionIssuer` is removed from `src/action/index.js` and from
`src/action/authSession.js`. There is no public or direct-import path that
mints a session trusted by any canonical runtime.

### B2 (Wave 4) — direct module import exposes injectable gate (closed)
`createGate` is removed from `src/action/gate.js`. The gate is a PRIVATE
closure helper inside `createActionAuthorityRuntime`; constructed exactly
once, over closure-owned dependencies only.
`require("src/action/gate").createGate === undefined`.

### B3 (Wave 4) — session brand is domain-local (not module-global)
The Wave-3 module-global `authSessionBrands = new WeakSet()` is gone. The brand
is a closure-local `const sessionBrand = new WeakSet()` inside each
AuthenticationDomain composition. Cross-runtime replay is rejected in both
directions without `runtimeId` strings.

### B1 + B2 + B3 (Wave 4 fifth repair) — caller-owned auth bootstrap removed
The `onReady({ bindAuthentication })` hook is DELETED from
`createActionAuthorityRuntime` and from the runtime surface entirely.
Authentication/session issuance is established OUTSIDE the public action
runtime constructor by trusted bootstrap via `createAuthenticationDomain`.
The runtime receives only the already-bound `verifier` capability. There is
no callback obtainable by a runtime caller that can mint authenticated
principals; no `bindAuthentication`/`mintSession`/`issuer` surface exists on
the runtime, its constructor options, or any module export. Authentication
failure fails closed with NO fallback to caller-supplied identity
(`fields.principal` / `requestedPrincipal` / `claimedPrincipal`).

### Sixth repair — canonical bootstrap ownership (caller-selectable verifier removed)
The fifth repair still left `createActionAuthorityRuntime` and
`createAuthenticationDomain` as PUBLIC EXPORTS, and the runtime constructor
still accepted a caller-supplied `authVerifier`. A caller that possessed
canonical CapabilityRuntime + AuthorityStore references could compose a NEW
runtime around them with ITS OWN verifier and impersonate a victim principal
the canonical store grants. The sixth repair closed that hole by moving the
factories behind one-shot host bindings and constructing canonical state
inside the trusted bootstrap closure.

### Seventh repair — first-binder trust + caller authenticator + facade seeding removed
The sixth repair's binders were THEMSELVES exported privileged composition
APIs with first-binder-wins semantics: a fresh-process attacker could
acquire BOTH privileged constructors before the production bootstrap loaded
(`r.bindCompositionHost({})` / `a.bindAuthenticationHost({})`). The loud
later-bootstrap failure was not sufficient. The seventh repair:

- REMOVES `bindCompositionHost` / `bindAuthenticationHost` (and every
  equivalent name) from every module export. runtime.js and authDomain.js
  become PURE non-privileged modules (inert vocabularies + pure
  non-authorizing predicates only).
- Defines both privileged composition functions INSIDE the trusted
  bootstrap's private closure. No binder, no token, no host capability, no
  first-call-wins registry exists anywhere.
- Production `createCanonicalActionFacade()` takes NO options — no
  `authenticate`/`authenticator`/`authVerifier`/`verifyCredentials`/
  `resolvePrincipal` (canonical authentication policy is bootstrap-owned;
  a fixed fail-closed adapter is bound internally for Lane 2).
- Production facade trimmed to EXACTLY `{ admit, evaluate, authenticate,
  session }` — no `grantAuthority`, no `registerCapability`, no `registry`,
  no `registrars`, no raw canonical state. Seeding moved to the explicitly
  test-only harness (tests/action/bootstrapHarness.js) and to a future
  production provisioning capability that downstream never receives.

## Preserved invariants (all prior closed properties retained)

- runtime-local session domains (now via AuthenticationDomain)
- cross-runtime replay rejection (closure-local brand, never strings)
- sealed gate (PRIVATE closure helper; no importable constructor)
- detached scope bindings (function identity captured ONCE)
- canonical shared Authority evaluator (`loadAndEvaluateAuthority`)
- subject/principal binding (identityBinding / grant.subject)
- malformed grants fail closed
- incarnation-bound intents
- clock hardening (read-once function identity)
- string-only hostile ingress
- brand-first Proxy rejection (zero traps)
- zero execution, zero actuation
- zero Authority mutation
- zero Capability mutation
- canonical AuthorityEvaluation branding (`isCanonicalAuthorityEvaluation`)

## Public API

Exports (`src/action/index.js`):

- `parseActionIntent` — untrusted STRING-only ingress.
- Inert constants: `DECISION`, `GATE_REASONS`, `ALLOW_REASON`, `ActionError`,
  `REASONS`, `INTENT_*`.
- `isCanonicalAuthorityEvaluation` — read-only canonical evaluation brand
  verifier (no minting).

NOT exported (from index.js or ANY action submodule):
`createActionAuthorityRuntime`, `composeActionAuthorityRuntime`,
`createAuthenticationDomain`, `composeAuthenticationDomain`, `createGate`,
`createAuthSessionIssuer`, `mintAuthSession`, `mintSession`, `issueIdentity`,
`isAuthSession`, `bindAuthentication`, `onReady`, `authBinder`, session brand
state, evaluation brand state, evaluator/verifier injection hooks,
runtime-identity minting, ANY bootstrap factory callable with caller-selected
dependencies, and ANY binder / token / host / first-call-wins composition
surface (`bindCompositionHost`, `bindAuthenticationHost`, `bindHost`,
`acquireHost`, `registerHost`, `installHost`, `claimComposition`,
`bootstrapBind`, `hostToken`, `getFactory`, `getComposer`).

Privileged composition lives in `src/action/bootstrap.js` — the trusted Damar
runtime/bootstrap layer — which exposes exactly
`{ createCanonicalActionFacade, PRIVILEGED_KEYS }`. The production facade
factory takes NO options; all canonical state (CapabilityRuntime,
AuthorityStore, AuthenticationDomain, the fixed fail-closed auth adapter, and
the verifier) is constructed inside the bootstrap closure. Test-only seeding
and authenticator injection lives in the explicitly test-only module
`tests/action/bootstrapHarness.js`, never reachable from `src/action`.

## Process / module isolation limitation (documented, not hidden)

This is a same-process CommonJS trust domain, NOT OS isolation. Node/CommonJS
path hiding is NOT hard sandboxing against code that already has arbitrary
same-process filesystem/require execution — path secrecy is NOT claimed as a
security boundary. An untrusted same-process actor with unrestricted
`require()` could still reach the trusted bootstrap module itself and compose
its OWN runtime with its OWN authenticate hook — but the resulting runtime is
a SEPARATE trust domain with a SEPARATE AuthenticationDomain brand: it cannot
read the session brand of, mint for, or evaluate against the canonical
runtime. What Lane 2 enforces is the enforceable contract:

- the ordinary/downstream Action API exposes NO authority composition
  primitive at all
- canonical bootstrap owns composition (one-shot host binding; canonical
  state + verifier constructed inside the trusted closure)
- downstream receives least-privilege facades only
- untrusted executable extensions must eventually require loader
  allowlisting, sandboxing, workers/process isolation, or equivalent
  enforcement


## Tests

`tests/action/`: `blockerIdentity.test.js` (13), `blockerEval.test.js` (5),
`trustOrigin.test.js` (12), `adversarial.test.js` (8), `security.test.js` (6),
`differential.test.js` (1, >=2200 cases), `storm.test.js` (2, >=12000 ops,
56 counters zero), `runtimeDomain.test.js` (13 — Wave-4 repros + structural
export scan), `authBootstrap.test.js` (16 — Wave-4 fifth-repair repros +
structural scans), `canonicalOwnership.test.js` (13 — SEVENTH repair
regressions: fresh-process binder-absence, attacker-imports-before-bootstrap,
caller-authenticator rejection, exact-facade-keys, no-seeding, fixed
fail-closed adapter, structural dependency direction).

Total: 89 tests, 0 failures.

Storm counters (all zero, all with active detection paths):

```
executions, actuations, authorityMutations, capabilityMutations,
forgedAuthorityAccepted, modelAuthorityAccepted, memoryAuthorityAccepted,
channelAuthorityAccepted, staleIncarnationAllowed, staleAuthorityAllowed,
undeclaredOperationAllowed, unavailableCapabilityAllowed, partialMutation,
hostileCallerCodeExecution, canonicalStateEscape, untypedErrors, openHandles,
identitySpoofAllowed, channelSpoofAllowed, sessionSpoofAllowed,
scopeBypassAllowed, authorityReadFailureAllowed,
malformedAuthorityEvaluationAllowed, staleUnboundIntentAllowed,
invalidTimestampAccepted, lane2AllowCanonicalDeny,
forgedRuntimeIdentityAccepted, clonedRuntimeIdentityAccepted,
forgedScopeResolverAccepted, fakeAuthorityContextAllowed,
forgedAuthorityEvaluationAllowed, subjectPrincipalMismatchAllowed,
malformedGrantAllowed, lane2AllowCanonicalReject,
arbitraryPrincipalMinted, canonicalStateImpersonation,
evaluatorReplacementSucceeded, canonicalVerifierReplacementSucceeded,
scopeBindingMutationAffectedRuntime, hostileIdentityTrapExecution,
# Wave-4 fourth repair (runtime-local trust domain)
publicIssuerMintedVictim, crossRuntimeSessionAccepted,
directGateInjectionSucceeded, forgedSessionAccepted,
# Wave-4 fifth repair (caller-owned auth bootstrap removed)
callerObtainedAuthBinder, callerObtainedSessionMint,
authFailurePrincipalFallback, retainedAuthBindingReplay,
# Wave-4 SIXTH repair (canonical bootstrap ownership)
publicActionRuntimeFactoryExposed, publicAuthenticationDomainFactoryExposed,
callerSelectedVerifierAccepted, canonicalStateReboundByAttacker,
# Wave-4 SEVENTH repair (first-binder + caller authenticator + facade seeding)
exportedCompositionBinderAcquired, exportedAuthenticationBinderAcquired,
callerAuthenticatorControlledCanonicalIdentity, productionFacadeAuthorityMutationSucceeded
```

The four seventh-repair counters have ACTIVE detection paths: they fire only
if a binder reappears on any module export, if a caller-authenticator option
ever reaches the production facade, or if any seeding/mutation surface
appears on the production facade.

Fresh-process security tests: `canonicalOwnership.test.js` spawns fresh child
processes (via `execFileSync`) for each repro — (R7-2) attacker imports
runtime.js/authDomain.js before bootstrap and acquires NOTHING; (R7-3)
canonical-first then attacker imports modules: still NOTHING; (R7-2/3)
attacker imports every action module before bootstrap: NOTHING. This is the
honest test of the no-first-binder law (not "after production bootstrap
already loaded").

## Known nonblockers

- `OWNER_CONFIRMATION_REQUIRED` semantic only (owner-auth flow later lane).
- `sqlite3` native module absent in this environment (non-differential
  authority tests requiring persistence fail with `Cannot find module
  'sqlite3'` — environmental, not Lane 2; identical on the baseline commit).
- Brand tokens + closure are same-process boundaries (documented honestly,
  not OS isolation; see "Process / module isolation limitation" above).
