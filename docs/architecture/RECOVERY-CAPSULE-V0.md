# DAMAR RECOVERY CAPSULE V0

Status: V0 — inert recovery substrate. No runtime wiring. No authority. No actuation.

Code: `src/runtime/recovery/**`
Tests: `tests/recovery/**` (`node --test "tests/recovery/*.test.js"`)

---

## 1. Constitutional invariant

**RECOVERY != AUTHORITY.**

A Recovery Capsule preserves *evidence* that authority existed at checkpoint
time. It may never:

- create a CapabilityGrant or root authority
- widen or reactivate revoked authority
- bypass owner ratification
- infer permissions from remembered behavior
- turn an interrupted intent into authorization

`RecoveryDecision.RESTORE` is **not an authority decision**. It is permission to
materialize opaque checkpoint data into a restricted context, nothing more.
Authority restoration will be delegated to the canonical Authority subsystem
after integration. Until then, `AUTHORITY_SENSITIVE` sections are treated as
opaque/restricted data: they are never interpreted by Recovery itself and are
surfaced only as `REQUIRES_REVALIDATION`.

This invariant is enforced mechanically by the zero-authority structural guard
(`tests/recovery/guards.test.js`), which scans all Recovery sources for
authority-fabrication tokens.

## 2. Relationship to existing canonical systems (R0)

Discovery confirmed there was **no canonical cross-subsystem recovery
substrate**, so this milestone does not duplicate any existing system. Exact
differences:

| Existing system | What it owns | Why Recovery Capsule is different |
|---|---|---|
| **ACC continuity** (`src/cognition/continuity/ContinuityCore.js`, `src/cognition/persistence/AccStore.js`) | Canonical event-sourced ACC state: journal → reducer → state → snapshot, hash-chained events, projection watermark | ACC continuity is the *owner of one subsystem's internal state*. Recovery Capsule checkpoints *that a provider's state existed*, its version and digest — it is not event-sourced, keeps no reducer state, and never becomes a second ACC. Future ACC integration happens via an explicit provider, not by reading ACC internals. |
| **Memory persistence** (`src/memory/db/`) | Memory notes / conversation history schema (SQLite + migrations) | Memory is *content storage* for recall. Recovery stores *checkpointed subsystem state bundles* with trust classification and restore transactions. It writes no memory records and reads none back into prompts. |
| **SQLite stores generally** (`checkpoints` table in `src/autonomy/CheckpointSystem.js`, channel/session DBs) | Durable rows for specific features | Recovery V0 uses a deterministic **in-memory store** so certification is hermetic; a filesystem backend (temp write → fsync → atomic rename → validate-before-replace) is specified below but deliberately not wired. |
| **Git / `CheckpointSystem`** (`.damar-checkpoints`, `git add -A && git commit` of the working tree) | Whole-worktree snapshots before risky changes | That is *file-tree rollback for humans*. Recovery Capsule is *machine-verifiable structured state bundles* with digests, epochs, lineage, two-phase restore, and fail-closed validation. Git has no schema validation, no section trust model, no restore transaction, and no completeness semantics. |
| **DamarSelf** | Self-model narrative content | Self-model is *content owned by cognition*. Recovery treats it (if ever integrated) as just another provider section, classified and opaque like everything else. |

If a future branch introduces a canonical equivalent, this module must be
retired into it rather than grown in parallel.

## 3. Conceptual model (R1)

- **RecoveryCapsule** — immutable validated bundle: `{ manifest, sections }`.
- **RecoveryManifest** — capsule identity, epoch, lineage, generation,
  completeness status, per-section `{sectionId, schemaVersion, classification,
  required, byteLength, digest}`, and `manifestDigest` over the canonical
  manifest material.
- **RecoverySection** — one provider's serialized state plus its payload digest.
- **RecoveryEpoch** — monotonic counter id (`repoch-<20 digits>`); lexicographic
  order equals numeric order.
- **RecoveryDecision** — closed outcome (`RESTORE` / `DEGRADED_RESTORE` /
  `REFUSE`) with exact reason codes.
- **RecoveryDiagnostic** — bounded immutable failure descriptions.
- **RecoveryProvider** — explicit code-registered adapter contract.

All public objects are frozen. No raw live object references escape:
providers must return plain serializable data from `capture()`.

## 4. Identity (R2)

| ID | Format |
|---|---|
| RecoveryCapsuleId | `rc-` + 32 lowercase hex |
| RuntimeGenerationId | `rtg-` + 32 lowercase hex |
| RecoveryEpochId | `repoch-` + 20-digit zero-padded counter |
| RecoverySectionId (= provider id) | `[a-z]` then up to 31 of `[a-z0-9]` or single `-` between alphanumerics |

Malformed values fail closed (`RangeError`/`TypeError`). No path separators, no
`..`, no uppercase, no whitespace, bounded length, no prototype-key semantics.
IDs carry identity only — zero authority semantics.

## 5. Provider architecture (R3)

```
id, schemaVersion, classification, required
capture(ctx) -> plain data (null abstains)
validateSection(data) -> true | {ok:false,message}
prepareRestore(data, ctx) -> detached handle
commitRestore(handle)      abortRestore?(handle)   rollbackRestore?(handle)
```

Registration is explicit code only (`ProviderRegistry.register`). Provider ids
from serialized capsules are resolved exclusively through
`lookupFromSerialized` against the registry — serialized input can never cause
a dynamic `require`/`import`. V0 wires only test fakes; real providers for ACC,
Authority, Sensorium, Semantic Desktop, Resource Governor, Presence,
InteractionBus, Actuation Fabric attach later through the inert ports in
`ports.js`.

## 6. Section trust boundary (R4)

Serialized capsule = untrusted input. `validation.validateCapsule` enforces,
in order: exact field-set match (unknown fields fail closed), ID formats,
capsule format version, COMPLETE status, section ordering/uniqueness,
provider existence (unknown provider ⇒ reject), classification & required-flag
equality with the registered provider, schema-version equality with the
registered provider, canonical re-serialization, byteLength equality, size
bounds, digest re-derivation (stored digests are never trusted), semantic
provider validation. No eval/Function/dynamic import/prototype merging anywhere.

## 7. Canonical serialization (R5)

`canonicalJson.js`: deterministic key sorting (code-unit), plain objects only,
arrays ordered, strings JSON-escaped, deterministic UTF-8 bytes. Fail-closed on:
non-finite numbers, BigInt, undefined, functions, symbols, circular references,
non-plain prototypes, duplicate own keys, and dangerous keys
(`__proto__`, `constructor`, `prototype`). Same semantic value ⇒ same bytes ⇒
same digest.

## 8. Digest semantics (R6)

SHA-256 over canonical bytes, per section and over canonical manifest material.

> **A SHA-256 digest here is CORRUPTION / CONSISTENCY DETECTION ONLY.**
> It is NOT authentication, NOT authorization, NOT proof of owner identity,
> and NOT tamper-proofing. Anyone can recompute it.

Tests prove semantic invalidity is rejected even when an attacker recomputes
all digests. If authenticity is needed later, a signature/MAC layer belongs
*above* this substrate; V0 implements no key management.

## 9. Checkpoint transaction (R7/R8)

Capture all → validate/canonicalize each → build complete capsule in memory →
single atomic `store.commit()` (which itself re-validates). Capsule states:
`BUILDING` / `COMPLETE` / `INVALID` / `INCOMPATIBLE`; only `COMPLETE` is ever
restorable. Any fault before commit marks the builder `INVALID` and persists
nothing — a half-capsule cannot exist because readers only see the store, and
the store only accepts fully validated complete capsules in one operation.

Filesystem backend (specified, not implemented): write temp file → fsync →
atomic rename → never overwrite a known-good capsule before the new one
validates. Kept separate so it can be certified independently.

## 10. Epochs, selection, required/optional (R9–R11)

Every checkpoint takes a monotonic epoch from the store's allocator. Duplicate
epochs are rejected at commit. Selection never trusts "latest file": without an
explicit `requestedCapsuleId`, the selector refuses with `SELECTION_AMBIGUOUS`
unless the caller passes the explicit `NEWEST_VALID` policy. Decisions name the
exact capsule and epoch chosen.

**Lineage ambiguity refuses implicit selection.** If the candidate set contains
a `LINEAGE_FORK` or a `LINEAGE_CONFLICTING_EPOCH`, `NEWEST_VALID` (and
EXPLICIT_ONLY) refuse — an ambiguous branch is never chosen implicitly. When
the caller supplies an explicit `requestedCapsuleId`, that exact capsule may be
selected, and the ambiguity stays visible: the lineage codes appear in
`reasonCodes` and `LINEAGE_FORK` / `LINEAGE_CONFLICTING_EPOCH` remain in
`diagnostics`. A lineage cycle always refuses.

Missing REQUIRED section or unsupported version ⇒ `REFUSE`
(`MISSING_REQUIRED_SECTION` / `UNSUPPORTED_VERSION`). Missing OPTIONAL section
⇒ `DEGRADED_RESTORE` listing exactly which sections degraded. EPHEMERAL-class
providers are expected to be absent; their absence is never degradation.

## 11. Restore transaction (R12)

Two-phase, mechanically proven by fake-provider call recording:

1. **PREPARE** every restorable section in canonical section order. Any
   failure ⇒ abort all prepared handles, zero commits have happened.
2. **COMMIT** in the same order. Failure at provider N ⇒ reverse-order rollback
   of N−1..0 via compensating `rollbackRestore`/`abortRestore`.

If compensation is NOT fully successful — a rollback throws or a provider
defines no compensation at all — the result is **not** reported as a clean
failed rollback. The terminal outcome is `PARTIALLY_ROLLED_BACK`, with:

- `uncompensatedSections`: providers whose committed state could not be undone
- `committedSections`: the residual LIVE committed state (identical set)
- `rolledBackSections`: providers successfully compensated
- `ROLLBACK_FAILED` diagnostics naming each failure

Net effect of any failed restore is zero partial live state.

## 12. No resume of in-flight actuation (R13) and classifications (R14)

`NON_RESUMABLE` sections ARE checkpointed as evidence but NEVER enter
prepare/commit; they surface as `INTERRUPTED` deferred sections requiring
explicit reality-check before continuation by the future Actuation Fabric.
`EPHEMERAL` sections are not checkpointed unless config explicitly allows.
`AUTHORITY_SENSITIVE` sections are opaque data surfaced as
`REQUIRES_REVALIDATION` with `requiresAuthorityRevalidation: true` on the
decision; Recovery itself never interprets them.

## 13. Lineage & runtime generation (R15/R16)

Lineage analysis detects missing parents, cycles, forks, same-epoch conflicts,
duplicate ids, and depth overflow — always as explicit diagnostics, never
silently resolved. Forks refuse implicit selection.

`RuntimeGenerationId` stamps each runtime incarnation. Work completed under a
stale generation is rejected by `GenerationLedger.assertCurrent`. V0 models
this only; nothing in the current runtime changes.

## 14. Compatibility (R17)

Capsule format version = 1. Unknown format or unsupported provider
schemaVersion ⇒ `INCOMPATIBLE` / refusal. Migrations are a future
code-controlled registry hook; migrations are NEVER executed from serialized
content.

## 15. Bounds (R18)

Central frozen `RecoveryConfig`: max capsule/section bytes, max sections,
max candidate capsules, max diagnostics, max lineage depth, max provider
count, max checkpoint reason length. Oversized hostile input is rejected before
large allocations where feasible (size checked immediately after canonicalizing
each section).

`maxCapsuleBytes` is enforced on BOTH paths over the exact canonical durable
material (manifest including its digest + every section payload):

- during checkpoint build, before atomic commit; and
- inside `validateCapsule` for any untrusted/restored candidate.

Violation yields `CAPSULE_TOO_LARGE` (never used for unrelated overflow; excess
candidate counts get their own `CANDIDATE_COUNT_OVERFLOW`). V0 has no metadata
surface, so no metadata bounds are advertised or configurable.

## 16. Observation != recovery truth (R25)

Recovered belief ≠ freshly verified reality. Every successful restore record
carries: *"Recovered belief is NOT freshly verified reality; external state
must be re-observed before actuation."* A device online before power loss is
not online now; a file present before a crash is not unchanged now. Future
Sensorium/Desktop/Actuation integrations must re-observe external state before
continuing anything.

## 17. Status & ports (R26/R27)

`RecoveryStatusTracker.getRecoveryStatus()` returns a frozen read-only view
(`lastCompleteCapsuleId`, `lastEpoch`, `candidateCount`,
`currentRuntimeGeneration`, `lastDecision`, `degraded`, bounded sanitized
diagnostics). It never exposes raw section data. Integration ports
(`ports.js`) are named inert attachment points only.

## 18. Test evidence

`node --test --test-concurrency=1 "tests/recovery/*.test.js"`

Covers: canonical serialization determinism & fail-closed rules, ID formats,
digest known-answer + tamper detection, full crash matrix (before capture /
during capture / after first section / after capture before manifest / built
but uncommitted / during persistence commit / prepare N / commit N),
corruption matrix (changed byte, changed section, changed manifest, missing &
extraneous & duplicated sections, unknown provider, recomputed-digest attacks,
prototype pollution, oversized payloads, malformed IDs, non-COMPLETE status),
required/optional semantics, provider-order and candidate-order determinism,
lineage cycle/fork/conflict/depth, runtime generations, bounds, status hygiene,
zero-authority and zero-actuation structural guards with a scanner self-test,
and the recovered-belief ≠ current-world contract.
