# WAVE 6 — LANE 4/5/6/7 CONTRACTS (FROZEN)

Status: **L4_CONTRACT_FROZEN = YES · L5_CONTRACT_FROZEN = YES · L6_CONTRACT_FROZEN = YES · L7_CONTRACT_FROZEN = YES**
Commits: L4 `9669dcf` · L5 `f8c843c` · L6 `d46baf9` · L7 `390d237`

---

## LANE 4 — External Capability Federation (src/federation/federation.js)

### Lifecycle (closed)
`DISCOVERED → QUARANTINED → INSPECTED → VALIDATED → ENABLED | REJECTED/REVOKED/EXPIRED`
- Intake: discovery lands QUARANTINED with mandatory provenance (source ≤256, publisher ≤128, name ≤128, version, license nullable, `artifactDigest` 64-hex REQUIRED — unpinned intake impossible, permissions ≤12 entries).
- Inspection: closed rule set (postinstall_hook, dynamic_code, obfuscated_payload, secret_access, license_missing). ANY hit → REJECTED (terminal).
- Validation: per-tool digest pinning (1..32 tools, 64-hex each).
- Enablement: per-tool, TTL-bounded (24h default); enablement is intake metadata, NOT an Authority grant.
- Tool integrity: mutated tool digest after validation → reverts QUARANTINED + enablements voided.
- Bounds: 256 candidates, 32/source. Candidate states frozen; illegal transitions rejected.

### Skill federation
- Skills: {skillId `dskill-`, name ≤128, scope ∈ global|node-local|pandawa-specific|task-local, source, digest?}. `SKILL != CAPABILITY` — selection hint only, structurally cannot grant.
- Pandawa analysis: advisory metadata object only; no enable/install methods exist.

## LANE 5 — Portable Core / Edge Runtime (src/edge/edgeRuntime.js)

### EdgeRuntimeProfile
- Profiles (closed): DESKTOP_PRIMARY, DESKTOP_SECONDARY, PORTABLE_CORE, EDGE_LOW_POWER, SERVER_PRIVATE, REMOTE_COMPUTE, TEMPORARY_NODE.
- Resource bounds: ramMb 1..65536, diskMb 1..2M; storage classes ≤8 (immutable-runtime, config, encrypted-identity, encrypted-selective-state, model-files, audit-buffer, cache). NO plaintext secrets.
- `PROFILE != AUTHORITY` (declared on every profile object).

### Degradation levels (availability only)
`EDGE_FULL / EDGE_REDUCED / EDGE_SURVIVAL / EDGE_OFFLINE` derived from network + memory/disk pressure. LEVEL_CAPABILITIES vocabulary per level never expands authority; EDGE_OFFLINE = local cognition + permitted memory + queued-sync + audit (no state-sync, no mesh-client).

### PortableCoreRuntime
- Offline: audit buffered (≤256, drop-oldest), sync queue (≤128), NO approval-minting API exists (structural).
- Reconnect: drains queued sync for L2 reconciliation; NEVER overwrites canonical state; level restored; trust untouched by level changes.
- Model fallbacks ≤4 within the SAME substrate abstraction (`cognitionStillLocal: true`) — future Wises introduction is a profile/model swap.
- Revocation while offline survives reconnect (trust generation rotation).
- Portable→desktop continuity via frozen L2 checkpoints (`MODEL RECOVERY != ACTION REPLAY` law attached to every restore view).

## LANE 6 — Replication, Resilience & Recovery (src/dresil/*)

### DistributedRecoveryCoordinator
- Episodes `drec-<32hex>` with opaque per-episode generation `drecgen-<32hex>`; unknown episode → fail closed.
- States: DETECTED → PEER_SELECTED → CHECKPOINT_TRANSFERRED → TRUST_REVALIDATED → READINESS_REVALIDATED → RESUMED | FAILED | ABORTED (closed transition table).
- Peer selection is a TRUST decision: RECOVERY_PEER scope under current generation; untrusted peers skipped; ≤2 peer attempts (bounded second-peer).
- Checkpoint transfer verified through the FROZEN L2 verifier: tampered/stale/expired fail closed; recovery payload nonce one-use (bounded ledger 2048). Source-node check = not REVOKED/QUARANTINED (failed node is untrusted-by-definition; revoked node's state is poison).
- Resumed episodes expose NO authority objects (structural).

### CircuitBreakers
- CLOSED → OPEN (≥5 failures) → HALF_OPEN (after 30s) → 1 probe → CLOSED|OPEN. Bounded table (256, CLOSED reclaimed oldest-first). Status = reliability metadata only (no grants/authority fields).

### ReplicationPolicy
- Per-class replica targets 0..3 validated at construction; **SECRET_BOUND > 0 is a TypeError** (MEMORY REPLICATION != SECRET REPLICATION). Deterministic sorted replica sets. `replicaQuorum` certifies freshness/availability ONLY (`REPLICA MAJORITY != USER AUTHORITY`).

## LANE 7 — Governed Evolution (src/evolution/evolution.js)

### ExperienceRecord
`dexp-` bounded record (taskType ≤64, contextSummary ≤500, routingDecision ≤16 keys, capability/model/provider ≤128, result ∈ succeeded|failed|unknown, verification, latency/cost, failureReason, userCorrection, confidence 0..1). Secret-shaped keys rejected recursively.

### LearningSignals
Bounded windows (64; smallest reclaimed) keyed `taskType|capability|provider`; `recommendation()` output is kind:RECOMMENDATION with the law attached — no apply/enact methods exist.

### ShadowEvaluation
RUNNING→COMPLETED|ABORTED; comparisons bounded; divergence rate computed; `actionInfluence: "NONE — shadow decisions are never dispatched"`; insufficient evidence (<20 samples or divergence >20%) cannot justify canaries.

### CanaryDeployment
Constructor THROWS `EVOLUTION_NOT_APPROVED` unless proposalStatus === APPROVED (status supplied by the caller from the frozen AuthorityRegistry — the pipeline cannot approve). TTL-bounded (1h default); observations; promote → PROMOTED (expired → rollback path); rollback always available; post-terminal operations rejected.

### EvolutionPipeline
- Requires the FROZEN authority model (`buildEvolutionProposal`) — no parallel authority (TypeError otherwise).
- `createProposal`: DRAFT status; evidence must reference REAL signal windows (fabricated windows → poisoned-evidence rejection); bounded proposal table (128).
- Boundedness: experiences 2048, windows 64, shadows 32, canaries 16, proposals 128.

## Downstream consumption rules
- All four contracts frozen; changes require DOWNSTREAM_CHANGE_REQUEST.md.
- L4 candidates NEVER execute; L5 profiles NEVER authorize; L6 recovery NEVER restores authority; L7 canaries NEVER run unapproved.
