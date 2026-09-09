# WAVE 6 ARCHITECTURE (working draft — finalized at convergence)

Baseline: Wave 5 frozen HEAD `3b7d85c8e9b9dee680ce75498efc1c72a0223438`.

## System planes (conceptual, modular — NO microservice explosion)

| Plane | Wave 6 module | Frozen owner it extends |
|---|---|---|
| Identity | `src/mesh/meshIdentity.js` | embodiment DeviceIdentity (node ⇄ device binding) |
| Trust | `src/mesh/nodeTrust.js` | OwnerTrust generation discipline (`ntgen_`) |
| State | `src/dstate/**` | sessionContinuity, vault, auditLedger, memory |
| Capability | `src/dexec/capabilityAdvertisement.js` | Capability Registry |
| Execution | `src/dexec/**` | Action Intent/Gate → Actuation → Verification |
| Observation | `src/mesh/meshAuditBridge.js`, trace fields | Audit Ledger |
| Recovery | `src/dresil/**` | Recovery Capsule + GenerationLedger |
| Evolution | `src/evolution/**` | Evolution Authority V1 (`src/authority`) |

## Node model

- `damar-node:<opaque>` — NodeIdentity is opaque random (`dnode_<32hex>`), NEVER hostname/IP/MAC (attributes only).
- One logical Damar identity spans all nodes; nodes are execution hosts.
- NodeRegistryRecord: immutable `nodeId`, `logicalDamarId`, `identityProvenance`; mutable bounded metadata (lastSeen, addresses ≤ 8, capability/resource summaries ≤ 64 entries, liveness).

## Trust model

- Trust is a SCOPED VECTOR, never a boolean: scopes `OBSERVE, STATE_REPLICA, MEMORY_REPLICA, COMPUTE, TOOL_EXECUTION, PORTABLE_CORE, RECOVERY_PEER, ADMINISTRATIVE_HOST`.
- States: `DISCOVERED, UNPAIRED, PAIRING_PENDING, TRUSTED, LIMITED, QUARANTINED, REVOKED, EXPIRED`.
- `NodeTrustRecord` carries `trustGeneration` (`ntgen_<32hex>`); revocation/reset mints a new generation — old proofs fail stale (exact identity, no numeric epoch).
- DISCOVERY != TRUST: discovery yields DISCOVERED only.
- Revocation is immediate: scope checks fail closed on stale/revoked generation.

## Mesh transport model

- `DamarMeshEnvelope` is transport-INDEPENDENT (version, messageId `dmesh_`, logicalDamarId, source/destination node, type, createdAt, expiry, trustGeneration, sessionReference, causalMetadata, payloadDigest, payload, authenticity proof, traceId).
- Transports are adapters; transport identity NEVER substitutes for NodeIdentity.
- Replay defense: opaque messageId + expiry + trustGeneration + bounded recent-message ledger (LRU, 8192).
- Liveness states: UNKNOWN/ONLINE/DEGRADED/OFFLINE/SUSPECT/RECOVERING. ONLINE != TRUSTED; OFFLINE != REVOKED.
- Split-brain: nodes continue limited local operation; reconciliation by per-class policy; authority-sensitive state never LWW.

## State model (L2)

- Every distributed state family declares a `replicationClass` (LOCAL_ONLY, EPHEMERAL, REPLICATED, OWNER_BOUND, SECRET_BOUND, DERIVED, CACHE, AUDIT_IMMUTABLE).
- `DistributedStateEnvelope` (stateType, stateKey, logicalOwner, sourceNode, revision, causalContext, createdAt/updatedAt, expiry, replicationClass, integrityDigest, payload).
- Causality: bounded hybrid logical clock + per-object revision lineage → causal-before / causal-after / concurrent. No global vector clock.
- Merge policies: LWW (non-critical), MONOTONIC_SET, APPEND_ONLY, MAX/MIN, UNION, DOMAIN_MERGE, MANUAL_CONFLICT, AUTHORITY_REVALIDATE.
- `DistributedCheckpoint`: session refs, pending cognitive work, safe continuation, verified-action markers, memory pointers, routing metadata. Excludes live authority, raw secrets, ephemeral handles.
- `SESSION MIGRATION != AUTHORITY MIGRATION`; `MEMORY REPLICATION != SECRET REPLICATION`.

## Execution model (L3)

- Canonical path preserved: User → RuntimeHost → InteractionBus → Manager → Action Intent → Authority → Capability resolution → DistributedExecutionRouter → trusted node → (local|remote) tool → Verification → Audit. Never model → node.
- `ExecutionLease` (`dlease_`): bound to actionIntentId+digest, capability, tool, target node, requesting node, trustGeneration, expiry, one-use nonce. Lease ≠ authority.
- Remote result must re-enter existing Verification; unknown-outcome actions enter UNKNOWN_EXECUTION_STATE (verification/compensation), never blind retry.

## External capabilities (L4)

- Lifecycle: DISCOVERED → QUARANTINED → INSPECTED → VALIDATED → ENABLED | REJECTED/REVOKED/EXPIRED.
- Provenance record mandatory (source, publisher, license, version, digest, permissions, network/fs/process/secret needs).
- `SkillSandboxPolicy` bounds fs/network/process/env/secrets/devices/time/memory/cpu/output.
- MCP discovered = QUARANTINED; per-tool enablement; Manager/Authority path unchanged. `MCP DISCOVERY != CAPABILITY ENABLEMENT`.
- Pandawa analysis roles inform recommendations; `RECOMMENDATION != INSTALL AUTHORITY`.

## Portable Core (L5)

- `EdgeRuntimeProfile` (DESKTOP_PRIMARY/…/PORTABLE_CORE/EDGE_LOW_POWER/…) — resource metadata, NOT authority.
- Degradation levels EDGE_FULL/REDUCED/SURVIVAL/OFFLINE — availability, NOT authority.
- Minimum core: identity reference, NodeIdentity, mesh client, trust state, minimal Manager ingress, checkpoint cache, local cognition adapter (same substrate abstraction), selected tools, audit buffer, recovery capsule, pairing, state sync.
- Offline: safe local cognition, permitted memory, already-authorized local capabilities, audit buffering, queued sync. Never: expired authority reuse, invented approvals, silent canonical overwrite.

## Resilience (L6)

- Replication targets 0–3 per state class by importance/privacy.
- Quorum decides freshness/availability ONLY. `REPLICA MAJORITY != USER AUTHORITY`.
- Bounded leader leases for coordination; leader ≠ authority.
- Distributed recovery episodes `drec_` reuse Recovery Capsules; revalidate trust + readiness; never restore live authority.
- FAILOVER != ACTION REPLAY: unknown-outcome → UNKNOWN → verification/compensation.
- Bounded circuits (nodes/providers/tools/models/transports): reliability metadata only.

## Evolution (L7)

- `ExperienceRecord` (bounded, no secrets) → learning signals (recommendations only) → `EvolutionProposal` (existing Authority V1 builder) → simulation/shadow → ratification → bounded canary → observe → retain/rollback.
- SHADOW/CANARY never control actions before approval. `SELF-IMPROVEMENT != SELF-AUTHORIZATION`. Rollback mandatory and tested.

## Cross-lane control path (unchanged shape, extended dimension)

user → channel → RuntimeHost → InteractionBus → Manager → session/context → cognition/Pandawa → ActionIntent → Authority → Capability Registry → Distributed Router (node × trust × capability) → ExecutionLease → local/remote Tool → Verification → State update (reconciliation) → Audit (node provenance) → Experience → (optional) Evolution Proposal.

## Security boundaries

- Every security/lifecycle id: opaque random, fixed pattern, fail-closed validation.
- All envelopes carry `schemaVersion`; unknown critical version → reject.
- Deterministic canonical serialization for every security-relevant digest.
- Bounded structures everywhere (see WAVE6_BOUNDEDNESS_REPORT.md at convergence).
- Typed failure envelopes (`MeshError` vocabulary: NODE_UNTRUSTED, NODE_REVOKED, TRUST_GENERATION_STALE, MESH_REPLAY, MESSAGE_EXPIRED, STATE_CONFLICT, EXECUTION_LEASE_EXPIRED, EXECUTION_STATE_UNKNOWN, EXTERNAL_CAPABILITY_QUARANTINED, EDGE_RESOURCE_EXHAUSTED, EVOLUTION_NOT_APPROVED, …). No fake success.

## Dependency graph

L1 → (L2, L4-foundation, L5-foundation, L7-foundation) → L3 → L6 → convergence → final candidate.
Frozen contracts: WAVE6_L{1,2,3,4,5,6,7}_CONTRACT.md; downstream changes require DOWNSTREAM_CHANGE_REQUEST.md.
