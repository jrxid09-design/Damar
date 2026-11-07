# Audit / Provenance Ledger V1

Branch lane: `feat/audit-provenance-ledger-v1` · Base: `9d72965`

## Purpose

A canonical, bounded, append-oriented **observational** record of what happened
across Damar subsystems: what, when, which subsystem, which interaction /
thread / project / session, which device, which Recovery generation, what
evidence, what Authority context was observed, what the outcome was, and what
was recorded afterward (causal links, corrections, supersessions).

V1 is the **core only**. No subsystem migration, no UI, no analytics, no remote
telemetry.

## Laws (binding)

- An `AuditEvent` is an observation. It is **not** Authority, **not** current
  truth, **not** executable history.
- Historical evidence ≠ current state. A record saying a device was TRUSTED
  yesterday says nothing about now. A recorded grant reference is not a grant;
  recorded approval is not ratification; logging an action is not executing it.
- The ledger never issues grants, delegates, ratifies, revokes, authorizes,
  consumes budgets, executes tools, actuates devices, touches shell/network/
  Console/Electron, or replays events as commands. There is deliberately **no
  replay API** and no code path that could execute anything: the module imports
  nothing outside `node:crypto` and itself (proven structurally by
  `tests/auditLedger/structural.test.js`).
- Recovery may READ history; Recovery must not REPLAY it. Generation refs are
  opaque identity strings; no rollback semantics exist in the ledger.

## Overlap map (what exists, why this is not a redundant logger)

| Existing surface | What it is | Why it stays |
|---|---|---|
| `src/core/safety/auditTrail.js` | Tool-execution JSONL audit files w/ redaction + retention | Tool-domain file log; kept unchanged. Future bridge can mirror entries into the ledger. |
| `src/services/telemetryService.js` | Ephemeral SSE ring buffer for live Console | Presentation transport, not durable evidence; unchanged. |
| `src/memory/governance/Governor.js` (`memory_audit`) | SQLite table for memory proposal lifecycle | Domain-local; candidate future *producer*. |
| `src/authority/*` | Grant/ratification engine with its own decision log | Authoritative source of Authority truth; ledger only ever stores **references** to its artifacts. |
| `src/runtime/presence/journal.js` | Bounded immutable transition journal (sequence+generation) | Closest structural precedent; remains presence-scoped. |
| `src/runtime/recovery/*` | canonicalJson/digest/id conventions, generation lineage | Integrity precedent; recovery keeps its own capsule stores. |
| `src/runtime/interactionBus/envelope.js` | Canonical interaction/session/correlation ids | Correlation ref vocabulary aligns with these shapes (structurally, without importing them). |
| `src/events/eventBus.js`, loggers, planStore | Transient pub/sub and logs | Unchanged; not evidence stores. |

Gap filled: there was **no** cross-subsystem record with canonical event
identity, deterministic ordering, provenance references, truth/current-state
separation, and enforced bounds.

## Event model (`AuditEvent`)

Required: `eventType`, `source`. Everything else optional ("do not require
every field"). Unknown top-level fields are rejected fail-closed.

```
eventId          ae-<32 hex>            canonical, collision-safe (crypto random)
sequence         monotonic integer      per-ledger logical order (never timestamp)
eventType        dotted lowercase       e.g. "tool.executed", "authority.grant.recorded"
timestampMs      safe integer           wall-clock observation (injected clock)
source           subsystem id           e.g. "runtime.recovery"
actor/subject    {kind,id}              kind ∈ system|agent|user|device|extension|service|external
operation        printable ≤128 chars   optional operation label
outcome          enum                   ok|denied|error|timeout|partial|unspecified
generation       opaque gen_/rtg- ref   historical generation identity only
correlation      closed-key map         interactionId|sessionId|correlationId|turnId|projectId|deviceId
evidenceRefs     [{kind,id,digest?}]    pointers; evidence stays at its origin
authorityRef     {kind,id,digest?}      pointer to grant/ratification/proposal/delegation/decision/capability identity — grants NOTHING
causalParentId   eventId                causal link
metadata         bounded plain object   passed through redaction boundary
integrity        {algorithm,prevDigest,digest}  sha256 over canonical serialization
```

Reserved event types: `ledger.correction`, `ledger.supersession`. Corrections
append NEW events referencing the target `eventId`; stored records are **never**
rewritten.

## Identity & ordering

- `AuditEventId`: `ae-` + 128 bits crypto-random hex; format-checked on input.
  Duplicate IDs are rejected atomically (no state change).
- Deterministic order = ascending `sequence` (monotonic per instance).
  Timestamps are observations and are never sufficient ordering.

## Append semantics & failure isolation

- `append(input)` validates fully BEFORE mutation; any invalid input leaves the
  ledger byte-for-byte unchanged. One bad event cannot corrupt history.
- `appendSafe(input)` never throws — returns `{ok:false,error:{code,message}}`.
  Callers decide whether audit durability is required for their operation
  (`{durable:true}`); the ledger never becomes a transaction coordinator.
- Returned records are deep-frozen AND detached copies; callers cannot mutate
  stored history through any handle they receive.

## Provenance & truth separation

Evidence and authority are represented as **references** (`{kind,id,digest?}`),
never duplicated objects. The ledger has no import edge into Authority,
Recovery, tools, or anything else — it cannot hold or revive live state.
Queries return plain frozen data with zero behavior.

## Privacy / redaction

Metadata passes a sanitization boundary before storage:

- credential-shaped KEYS (`password`, `token`, `apiKey`, `authorization`, …)
  redacted unconditionally;
- credential-shaped VALUES (known provider token formats, JWT/base64 blobs,
  long high-entropy strings) redacted;
- functions/symbols/bigints rejected; cycles rejected; dangerous prototype
  keys (`__proto__`, `constructor`, `prototype`) rejected; depth/key/array/
  string/byte budgets enforced fail-closed.

This is defense-in-depth, not license to launder secrets: callers must pass
references, not secret material.

## Bounds (defaults)

maxInMemoryEvents 5000 (ring window; logical sequence continues) ·
query limit default 200 / hard cap 1000 · metadata ≤2048 bytes, strings ≤512,
depth ≤6, keys ≤64/level, arrays ≤32 · evidenceRefs ≤16 · eventType ≤96 ·
refs ≤128 chars. All clamps fail closed (`resolveBounds` rejects unknown/out-of-range).

## Query

Bounded, deterministic, copy-returning: by eventId, type(s), source, actor,
subject, correlation map, generation, outcome, causalParentId, time range.
No caller-supplied executable predicates exist anywhere in the API.

## Persistence

V1 defines `AuditPersistencePort` (contract) + deterministic in-memory
implementation. With `{durable:true}` the sink is written **before** the
in-memory commit so a persist failure mutates nothing. Production deployment
with durability requirements MUST provide an adapter (SQLite: transactional
append, `UNIQUE(event_id)`, monotonic sequence column, restart load-then-
continue, bounded queries, schema migration test). Async sinks are explicitly
rejected in V1 because they break the atomic-ordering guarantee.

## Integrity

SHA-256 hash chain over canonical serialization (`prevDigest` linkage),
verified over the retained window by `verifyIntegrity()`.

**Binding disclaimer:** digests here are corruption/consistency DETECTION ONLY
— not authentication, not authorization, not non-repudiation. Anyone who can
rewrite storage can rewrite the chain. This matches the Recovery digest
posture and is asserted in tests.

## Structural isolation (proven)

`tests/auditLedger/structural.test.js` proves every `require()` inside
`src/runtime/auditLedger/` resolves to a node: builtin or a sibling file in the
same folder — therefore the ledger cannot mutate Authority, execute tools,
actuate devices, spawn shells, open network/console/Electron surfaces, or
trigger Recovery restore execution. The exported API surface is additionally
whitelisted against forbidden verbs.

## Testing map

`tests/auditLedger/`: ids, event model, append/ordering/immutability,
corrections, redaction, bounded queries, integrity/tamper-detection,
failure isolation + persistence port, hostile-input suite, B1 snapshot
regressions, B2 traversal-budget regressions, B3 sequence-atomicity
regressions, ≥10k-op storm (×2, incl. getter/Proxy/DAG/durable/duplicate
attack mixes) with handle-leak checks, structural isolation.

## Repair hardening (V1r)

- **B1 — snapshot-once:** the entire append input is converted into
  plain inert data ONCE (`snapshot.js`) before any semantic validation;
  all validation and storage read only that snapshot. Accessor
  properties are rejected WITHOUT invocation (descriptor inspection),
  so caller code never runs during validation or queries.
- **B2 — global traversal budget:** one `maxMetadataNodes` budget
  (default 4096) threads through snapshot AND sanitization; shared-
  reference DAG amplification fails deterministically with
  `E_BOUNDS_EXCEEDED` instead of exhausting CPU/memory.
- **B3 — sequence atomicity:** `sequenceCounter` advances only in the
  final commit phase after normalization, canonical serialization,
  digest generation, and the durable precondition succeed; rejected
  appends never burn sequence numbers. Canonicalization failures are
  surfaced as typed `E_INVALID_EVENT` LedgerErrors.

## Backlog (explicitly deferred — do not treat as V1 scope)

- sink that persists then throws (post-commit failure reporting)
- `fromSequence`/`toSequence`/window-only options for `verifyIntegrity`
- operation-field secret redaction tightening
- production SQLite durable adapter
- auditTrail.js producer bridge
- canonical serializer consolidation across lanes
