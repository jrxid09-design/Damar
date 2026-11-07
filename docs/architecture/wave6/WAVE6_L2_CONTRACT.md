# WAVE 6 — LANE 2 CONTRACT (FROZEN)

Status: **L2_CONTRACT_FROZEN = YES**
Commit: `08f23f3` (implementation) on `feat/wave6-distributed-damar`
Internal verification: `tests/wave6/l2/stateContinuity.test.js` — 11/11 PASS.

## Frozen schemas

### ReplicationClass (closed vocabulary)
`LOCAL_ONLY, EPHEMERAL, REPLICATED, OWNER_BOUND, SECRET_BOUND, DERIVED, CACHE, AUDIT_IMMUTABLE`
- Replicatable (may leave a node): **REPLICATED, EPHEMERAL** only.
- AUTHORITY_SENSITIVE: **OWNER_BOUND** — build-time rejects `LAST_WRITER_FOR_NONCRITICAL`; conflicts escalate to AUTHORITY_REVALIDATE.
- SECRET_BOUND / LOCAL_ONLY / AUDIT_IMMUTABLE: rejected at the state-plane door entirely (cannot be built as replicatable envelopes).

### MergePolicy (closed vocabulary)
`LAST_WRITER_FOR_NONCRITICAL, MONOTONIC_SET, APPEND_ONLY, MAX, MIN, UNION, DOMAIN_MERGE, MANUAL_CONFLICT, AUTHORITY_REVALIDATE`
- MAX/MIN validate numeric `payload.value` at build (malformed payload cannot enter the plane).
- Deterministic tie-break on concurrent non-critical LWW: bounded HLC then revisionId — NEVER wall-clock alone.

### Causality (bounded)
- Hybrid logical clock: 48-bit bounded physical + 16-bit logical counter; overflow advances physical deterministically.
- Per-object lineage: `causalParents` ≤ 4, `parentRevisionId`, optional in-memory `parentRevision` for transitive checks; bounded lineage NEVER pretends total order (deep chains classify CONCURRENT).
- `causalRelation(A, B)` → IDENTICAL | BEFORE | AFTER | CONCURRENT (position of A relative to B).
- `CLOCK ORDER != CAUSAL TRUTH`: timestamps are descriptive; conflict arbitration is policy + lineage.

### DistributedStateEnvelope
Frozen revision objects: `schemaVersion` (1), `stateType` ≤64, `stateKey` ≤256, `logicalOwner` ≤128, `sourceNodeId` (`dnode-`), `revisionId` (`dstate-<32hex>`), `revisionSeq` (store-stamped on detached copy), lineage fields, `causalTimestamp`, `createdAtMs/updatedAtMs`, `expiryMs` (default 24h; expired revisions rejected `MESSAGE_EXPIRED`), `replicationClass`, `mergePolicy`, `integrityDigest` (SHA-256 over canonical {stateType, stateKey, revisionId, payload}), `payload` ≤128 KiB plain JSON.

### StateConflict (explicit, never silently dropped)
`conflictId` (`dconf-<32hex>`), left/right revision summaries, `causalRelation`, `policy`, `authoritySensitive`, `resolutionStatus` (BLOCKING_UNRESOLVED for authority-sensitive | OPEN for MANUAL_CONFLICT | RESOLVED), `resolutionEvidence` {winnerRevisionId, resolverNodeId, evidence, resolvedAtMs}. Un-accepted revisions retained on the conflict record (retainedLeft/retainedRight) so explicit resolution can pick a winner. Conflict table bounded (256; oldest RESOLVED reclaimed first).

### DistributedStateStore (bounded)
Keys ≤2048, revision history ≤8/key, append log ≤256/key, conflicts ≤256, outgoing buffer ≤512. API: `writeLocal` (build+apply; rejects non-plane classes), `applyRemote` (expiry check → idempotent duplicate detection → causal relation → policy → conflict), `resolveConflict` (explicit only; immutable conflict replaced by resolved copy), `get/appendLog/outgoingBuffer/flushOutgoing/keys/size`, `conflicts({openOnly})`.

### DistributedCheckpoint
`checkpointId` (`dckpt-<32hex>`), `schemaVersion` 1, `sourceNodeId`, `logicalDamarId`, `continuityIncarnation` (frozen `dsc_*` incarnation — required), `sessionReferences` ≤16, `pendingCognitiveWork` ≤32, `verifiedCompletedActionRefs` ≤32, `memoryPointers` ≤32, `routingMetadata` ≤16 entries (authority-shaped keys rejected recursively on RAW input), `createdAtMs/expiresAtMs` (TTL must be positive at build — fail-closed), `integrityDigest` (SHA-256 over canonical core).
- `verifyCheckpoint`: schema version, digest re-computation, expiry, continuity-incarnation match (stale → TRUST_GENERATION_STALE), source-node trust callback (revoked → NODE_REVOKED).
- `restoreView`: inert continuation data ONLY. Carries the law: `SESSION MIGRATION != AUTHORITY MIGRATION`; `MODEL RECOVERY != ACTION REPLAY` — completed/verified action markers survive migration and are never resurrected as executable work.

### Memory namespace classes (selective replication)
`LOCAL, SHARED_DAMAR, NODE_SCOPED, PANDAWA_SCOPED, OWNER_SCOPED, SECRET_REFERENCE_ONLY`.
Default replicatable: **SHARED_DAMAR** only. Secret-reference namespaces may carry references, never values. `MEMORY REPLICATION != SECRET REPLICATION`.

## Invariants proven by tests

1. Causal BEFORE/AFTER/CONCURRENT/IDENTICAL via bounded lineage (deep chains → CONCURRENT, no false total order).
2. LWW forbidden for OWNER_BOUND at build time (hard law).
3. Authority-sensitive conflicts: BLOCKING_UNRESOLVED, never auto-accepted, resolved only with evidence; unknown winner rejected.
4. MANUAL_CONFLICT open until resolved; resolved copy immutable.
5. MAX/MIN/UNION/APPEND_ONLY/DOMAIN_MERGE converge deterministically; malformed policy payloads rejected at build.
6. SECRET_BOUND/LOCAL_ONLY/AUDIT_IMMUTABLE cannot enter the state plane.
7. Checkpoints: verify/stale-incarnation/revoked-source/expired/tampered/authority-shaped/bounds all fail closed; restore view carries no authority.
8. Action no-replay across migration: verified markers preserved.
9. Offline divergence + reconnect converges to one revision; key caps enforced.
10. Revoked node replication rejected via the L1 mesh gate (integration).
11. Expired revisions rejected at store.

## Downstream consumption rules

- L3 consumes: envelope schema, `canLeaveNode`, store `applyRemote` result shape (outgoing buffer), conflict model, checkpoint verify/restore, `AUTHORITY_SENSITIVE` set.
- L6 consumes: checkpoint + verify for distributed recovery, conflict records for reconciliation of recovered state.
- Frozen-owner protection: session continuity (`dsc_*`) remains the session owner; checkpoints reference incarnations, never replace them. Vault secrets never serialize. Authority never replicates.
- Any schema change requires DOWNSTREAM_CHANGE_REQUEST.md.
