# RESOURCE GOVERNOR V0

Status: candidate (additive, production-unwired)
Branch: `feat/resource-governor-v0`
Base: `2890f96161428183720e10661af95ccb10bc7eda`
Code: `src/runtime/resourceGovernor/**`, `tests/resourceGovernor/**`

## Purpose

Damar runs agents, tools, background services, tests, RE workloads and a
future Presence runtime on one shared host. Nothing today prevents these
subsystems from collectively overloading the machine. The Resource Governor
is the substrate that answers:

> "Can this workload safely run **now**?"

This is strictly different from AUTHORITY, which answers:

> "Is this action permitted?"

The Governor never grants, widens, or impersonates authority. It observes,
classifies, admits/queues/defers/rejects, leases, accounts, releases and
reports telemetry. It executes nothing.

## V0 pipeline

```
OBSERVE -> CLASSIFY RESOURCE DEMAND -> ADMISSION DECISION -> LEASE
        -> ACCOUNT -> RELEASE -> TELEMETRY
```

No autonomous process killing exists in V0. Under CRITICAL pressure the
Governor refuses new heavy workloads; running workloads are only ever given
*recommendations* (data), never signals it acts on for them.

## G0 — Discovery results (what already exists)

| Mechanism | Location | Relation to Resource Governor |
|---|---|---|
| Authority / ToolBus | `src/autonomy/ToolBus.js`, `src/ai/tools/Authorization.js`, `src/ai/executors/*` | Answers "permitted?". Governor sits beside it, never through it. Admission does not imply permission and vice versa. |
| Watchdog | `src/autonomy/watchdog.js` | Already *observes* extreme event-loop lag (>2000ms) and self-heals voice/MCP. It is remediation, not admission control. Governor is a better data source for it later; V0 does not wire it. |
| Telemetry | `src/services/telemetryService.js` | Ring-buffer event/CPU telemetry for Console SSE. Governor produces its own bounded accounting; a future bridge may forward status snapshots there. |
| Memory Governor | `src/memory/governance/Governor.js` | Name collision only in prose: it gates *memory writes* behind user approval. Different domain entirely. This subsystem is always called "Resource Governor". |
| Tool budget | `src/ai/tools/Budget.js` | Context-window disclosure budget for tool schemas. Not host resources. |
| Injected clock | `src/cognition/core/clock.js` | Precedent pattern (`manualClock`). V0 re-implements a tiny `{nowMs}` injection locally instead of importing cognition, to stay isolated/unwired from candidate branches. |

Grep proof: no occurrence of `concurrency|maxConcurrent|semaphore|admission|
backpressure` anywhere in `src/` at base commit. No canonical resource
abstraction is being duplicated.

## Domain model (G1–G2)

### WorkloadClass (closed enum)
`INTERACTIVE, VOICE, TOOL, AGENT, RE_ANALYSIS, BACKGROUND, MAINTENANCE,
TEST, UNKNOWN`

### WorkloadId
Canonical grammar (fail-closed):

```
^[a-z][a-z0-9]{1,30}(-[a-z0-9]{1,30}){0,7}$    (total length 3..64)
```

- lowercase only — `"Foo"` and `"foo"` cannot collide by case tricks;
- any character classified as whitespace (space, tab, newline, NBSP, …)
  anywhere in the input makes the ID invalid;
- empty or repeated dashes (`--`) are invalid;
- IDs carry NO capability or authority semantics — they are opaque labels.

### ResourceDemand (immutable, validated)
`cpuWeight (0..100)`, `memoryBytesHint`, `ioWeight (0..100)`,
`networkWeight (0..100)`, `latencyClass (STRICT|NORMAL|BULK)`,
`expectedDurationMs`, `concurrencyGroup`, `priority (0..100)`,
`preemptible (bool)`, `provenance (short string)`.
Malformed demand => `REJECT_RESOURCE_LIMIT` with reason `INVALID_DEMAND`
(fail closed, never "assume small").

### ResourceSnapshot (from injected observer + clock)
Host total/free memory, process RSS/heap used/heap limit, event-loop lag,
active leases, queued workloads, per-group concurrency, timestamp.
Observation failure yields pressure band `UNKNOWN` + diagnostic — never
"healthy".

### Pressure bands (closed)
`NORMAL, ELEVATED, HIGH, CRITICAL, UNKNOWN` — derived ONLY from numeric
thresholds in validated config. Free-form judgment is impossible by
construction.

Exact pressure formula (all ratios clamped to [0,1]; missing or malformed
readings drop their contribution; no contributions at all => `UNKNOWN`):

```
hostBand      = band(1 - freeMemBytes/totalMemBytes,   memoryThresholds.hostUsedMemoryRatio)
v8Band        = band(heapUsedBytes / heapLimitBytes,   memoryThresholds.processHeapUsedRatio)
                // heapLimitBytes = v8.getHeapStatistics().heap_size_limit (NOT heapTotal)
footprintBand = band(rssBytes / totalMemBytes,         memoryThresholds.processHeapUsedRatio)
nativeBand    = band((externalBytes + arrayBuffersBytes) / heapLimitBytes,
                       memoryThresholds.processHeapUsedRatio)
lagBand       = band(eventLoopLagMs, config.eventLoopLagMs)
hardFloorHit  = freeMemBytes <= memoryThresholds.hostHardFloorBytes  => forces CRITICAL
band          = worstOf(hostBand, v8Band, footprintBand, nativeBand, lagBand)
```

RSS and native (external/arrayBuffer) memory contribute to the worst band,
so an externally-buffer-heavy runtime is detectable even when the V8 heap
looks small; a healthy Node process stays comfortably NORMAL under these
defaults.

### Demand-based heaviness

A workload is HEAVY if ANY of the following holds (validated central config
`heavyDemand.{memoryBytes,cpuWeight,durationMs}`):

- its WorkloadClass is inherently heavy
  (`AGENT, RE_ANALYSIS, BACKGROUND, MAINTENANCE, TEST, UNKNOWN`), OR
- `memoryBytesHint >= heavyDemand.memoryBytes`, OR
- `cpuWeight >= heavyDemand.cpuWeight`, OR
- `expectedDurationMs >= heavyDemand.durationMs`.

All heavy-specific rules (CRITICAL gate, host hard-floor gate, HIGH/lag
deferral) use this demand-aware predicate — a VOICE/INTERACTIVE/TOOL
workload with huge declared demand cannot bypass CRITICAL gating, while
genuinely light VOICE keeps documented low-latency semantics.

### Prototype-safe group semantics

Validated `groupLimits` is built on a **null-prototype object** and group
membership uses own-property checks (`Object.prototype.hasOwnProperty.call`)
at every trust boundary. Inherited names (`constructor`, `toString`,
`valueOf`, `hasOwnProperty`, ...) can never act as groups; explicitly
configuring such a name fails closed (`INVALID_RESOURCE_GOVERNOR_CONFIG`);
group counters are stored in `Map`s and can never exceed configured limits.

### AdmissionDecision (closed)
Outcome: `ADMIT | QUEUE | DEFER | REJECT_RESOURCE_LIMIT`.
Closed reason-code set: `OK_ADMITTED, OK_QUEUED, DEFERRED_BACKGROUND_UNDER_
PRESSURE, DEFERRED_EVENT_LOOP_SEVERE, DEFERRED_PRESSURE_HIGH, LIMIT_GLOBAL_
CONCURRENCY, LIMIT_GROUP_CONCURRENCY, LIMIT_CLASS_CONCURRENCY, PRESSURE_
CRITICAL_HEAVY, MEMORY_HARD_CEILING, QUEUE_FULL, INVALID_DEMAND, INVALID_
WORKLOAD_ID, UNKNOWN_GROUP, OBSERVER_UNAVAILABLE, INTERNAL_FAULT`.

## Admission policy (G4, G8, G13)

Deterministic function of `(demand, class policy, snapshot, config)`:

1. Malformed input / unknown group => reject (see below).
2. Observer unhealthy => `DEFER` with `OBSERVER_UNAVAILABLE` for heavy
   classes; light classes (`INTERACTIVE`,`VOICE`,`TOOL`) still admit under
   concurrency limits only.
3. Pressure `CRITICAL` => heavy classes (`AGENT, RE_ANALYSIS, BACKGROUND,
   MAINTENANCE, TEST, UNKNOWN`) are not admitted (`PRESSURE_CRITICAL_HEAVY`
   or queue/defer path); `INTERACTIVE/VOICE/TOOL` respect hard ceilings but
   stay admissible.
4. Event-loop lag severe (>= configured critical lag) => heavy classes defer
   even if RAM looks fine.
5. `BACKGROUND` defers first at `ELEVATED`/`HIGH`; other heavies defer at
   `HIGH`.
6. Concurrency: global limit, then group limit, then optional class limit —
   checked and reserved atomically at the governor boundary.
7. Host/process memory hard ceiling (available-mem ratio below critical
   threshold) blocks heavy admission regardless of slots.

## Lease (G5)

An admitted workload receives an immutable, non-forgeable `ResourceLease`:

```
leaseId, workloadId, class, group, admittedAt, expiresAt(ttl),
reservedDemand, generation
```

Authenticity mechanism: **registry-backed identity + private Symbol brand**.

- The governor keeps an internal `Map<leaseId, record>`; the record holds
  the *original handle object*.
- A lease passes release/renew/account only if (a) a record exists for its
  leaseId AND (b) the record's handle IS the very object presented
  (reference identity) AND (c) it carries the module-private brand symbol.
- A plain deserialized/forged object therefore fails closed on every
  operation, even with byte-identical visible fields. Status/snapshot
  outputs never include the handle, only plain projections.

## Atomic acquire/release (G6)

All reservation logic is synchronous inside one governor method call; Node's
single thread makes check+reserve atomic. Invariant enforced after every
mutation: `active(group) <= limit(group)` and `activeTotal <= globalLimit`;
violation trips an internal fault latch (`INTERNAL_FAULT`: all further
admissions rejected, diagnostic recorded) instead of continuing silently.

Release is idempotent: first release frees the slot exactly once; further
releases of the same lease return `{released:false}` without negative
counters. Unknown/forged leases throw. Expired leases are reclaimed
deterministically by `reclaimExpired(now)` (also invoked opportunistically
inside `admit`), which promotes queued work if slots free up.

## Concurrency groups (G7)

Known groups come exclusively from validated config:
`llm-heavy, re-analysis, voice, tool, background, tests, default` (defaults;
config may redefine limits but the group NAME SET is closed).

**Documented choice: unknown groups FAIL CLOSED** (`UNKNOWN_GROUP` reject).
Rationale: mapping to `default` would still be globally safe, but silent
renaming hides caller bugs; this codebase prefers failing closed. The
global limit additionally bounds the union of all groups, so even a
hypothetical group escape cannot exceed it.

## Queue (G9, G12)

- Bounded (`maxQueue`); overflow => explicit `QUEUE_FULL` decision.
- Entries immutable: `{seq, workloadId, demand, enqueuedAt, basePriority}`.
- Ordering: effective priority = `basePriority + agingBonus(waitMs)`,
  capped; ties broken by ascending `seq` (FIFO within equal priority).
- Aging: bonus accrues linearly with wait time up to a cap
  (`aging.bonusPer10s`, `maxBonus`, default cap above the maximum static
  priority of 100), guaranteeing BACKGROUND eventually outranks fresh
  INTERACTIVE entries after sustained waiting — no static-priority
  starvation (proven by adversarial storm test).

## Accounting (G10)

Counters: `admitted, queued(current), released, expired, rejected,
deferred, peakConcurrent`, per-class and per-group current-active maps.
Recent-decision history is a fixed-capacity ring (`historyCapacity`);
no unbounded arrays/maps anywhere. Telemetry is read-only data; it confers
no rights.

## Cooperative cancellation signal (G11)

Under pressure the governor computes `ResourcePressureRecommendation`
items — `REDUCE_CONCURRENCY, PAUSE_BACKGROUND, RELEASE_IDLE_LEASES,
CANCEL_PREEMPTIBLE` — delivered as inert data through integration ports
(G20). V0 contains no `process.kill`, no child-process actuation, no
AbortController invocation belonging to other subsystems, no tool
execution.

## Configuration (G14)

Single `ResourceGovernorConfig` (see `config.js`), validated by
`validateResourceGovernorConfig` (throws on any malformed field — fail
closed): global limit, per-group limits, class limits, maxQueue, lease TTL,
memory thresholds (host used-memory ratio + process heap-used ratio,
ascending `elevated < high <= critical`), event-loop lag thresholds, telemetry
history capacity, demand maxima, aging parameters, unknownGroupPolicy
(fixed `reject` in V0). No scattered magic numbers.

## Failure semantics (G19)

| Condition | Behaviour |
|---|---|
| Observer throws / unavailable | pressure `UNKNOWN`, diagnostics set; heavies defer |
| Malformed demand | reject `INVALID_DEMAND` |
| Malformed workload ID | reject `INVALID_WORKLOAD_ID` |
| Unknown group | reject `UNKNOWN_GROUP` |
| Queue full | decision `QUEUE` + `QUEUE_FULL` (caller may retry later) |
| Internal accounting inconsistency | fail closed: fault latch + diagnostic |

## Future integration hooks (G20)

`integrationPorts.js` exports inert ports (Presence Runtime, Agent runtime,
RE Intelligence, Voice, InteractionBus, Actuation Fabric, Watchdog).
Registering a listener stores it; `publish(recommendations)` hands out
frozen data-only payloads. Ports import nothing and execute nothing from
those systems; no unfinished candidate branches are imported.

## Zero-Authority / Zero-Actuation (G16, G17)

Structural guard tests scan every source file under
`src/runtime/resourceGovernor/` and assert the absence of:

- `CapabilityGrant`, `granted\s*[:=]\s*true`, `role` escalation literals
  (`system|superadmin`), ToolBus execution calls;
- `child_process`, `process.kill`, `.kill(`, keyboard/mouse/device APIs,
  filesystem writes, Home-Assistant/Android control imports.

Admission can never turn a denied authority request into an allowed one:
the Governor's output types contain no grant/permission fields at all.

## Testing

`tests/resourceGovernor/**` — ≥40 meaningful tests covering positive,
negative, adversarial, race, pressure, starvation, forge, expiry,
storm (1000 admissions), deterministic replay/status, and the two
structural guards. Run targeted:

```
node --test --test-concurrency=1 --require ./tests/helpers/testEnv.js "tests/resourceGovernor/**/*.test.js"
```

Full `npm test` deliberately not run: change is purely additive, no shared
file modified.
