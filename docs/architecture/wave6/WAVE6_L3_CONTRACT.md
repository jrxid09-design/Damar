# WAVE 6 — LANE 3 CONTRACT (FROZEN)

Status: **L3_CONTRACT_FROZEN = YES**
Commit: `c9501bf` on `feat/wave6-distributed-damar`
Internal verification: `tests/wave6/l3/executionRouting.test.js` — 9/9 PASS.

## Frozen schemas

### ExecutionLease (`dlease-<32hex>`)
Minted by `mintExecutionLease` — every binding field mandatory:
- `actionIntentId` (≤128) + `actionDigest` (SHA-256 over the deterministic intent encoding — any intent change invalidates the lease)
- `capabilityId` (≤256) + `capabilityIncarnationId` (≤64, optional) + `toolId` (≤256)
- `targetNodeId` + `requestingNodeId` (`dnode-`; self-lease rejected for remote leases — local execution bypasses leases entirely)
- `trustGeneration` (`ntgen-`, exact current generation at mint; stale at verify → TRUST_GENERATION_STALE)
- `authorityDecisionDigest` (64-hex REFERENCE to the canonical Authority decision — a lease NEVER carries a grant; `authorityDecisionDigest: null` is unbuildable)
- `executionNonce` (32-hex, one-use), `oneUse: true`, `issuedAtMs/expiresAtMs` (default TTL 60s)
- Frozen object; schemaVersion 1.

### Lease verification (target side, `verifyExecutionLease`)
Fail-closed in order: schema → action digest mismatch → wrong node (DESTINATION_MISMATCH) → stale generation (TRUST_GENERATION_STALE) → capability/tool mismatch → expiry (MESSAGE_EXPIRED) → one-use nonce replay (MESH_REPLAY). Consumed nonces kept in a bounded target-side ledger (≤4096).

### DistributedExecutionRequest / Result
- Request: `executionId` (`dexec-<32hex>` = `dexec-` + lease nonce), `lease`, `actionDigest`, `inputDigest` (SHA-256 over canonical input), `input`, `expectedCapability`, `toolIdentity`, `deadlineMs`, `verificationRequirements`, `state: DISPATCHED`. Local execution variant: `lease: null`, `localExecution: true`.
- Result (sender): `state` ∈ {SUCCEEDED, FAILED} only, `output`, `resultDigest` (SHA-256 over canonical output), `completedAtMs` (not in the future).
- Result verification (receiver): executionId match, inputDigest match, resultDigest match (forged results rejected), legal state, sane timestamps. Forged/tampered results → PAYLOAD_DIGEST_MISMATCH.

### DistributedExecutionState machine (closed)
`PLANNED → AUTHORIZED → LEASED → DISPATCHED → (ACKNOWLEDGED) → EXECUTING → SUCCEEDED|FAILED|UNKNOWN → VERIFIED|COMPENSATED`, plus CANCELLED/EXPIRED. Illegal transitions throw MESSAGE_MALFORMED. UNKNOWN exits ONLY via VERIFIED/COMPENSATED/EXPIRED — never re-DISPATCHED/EXECUTING (no blind retry; FAILOVER != ACTION REPLAY).

### NodeCapabilityAdvertisement
Per node: ≤64 capability entries {capabilityId ≤256, incarnationId ≤64, toolId ≤256, health HEALTHY|DEGRADED, latencyScore 0–100, privacy ∈ PUBLIC|INTERNAL|PRIVATE|SECRET_REFERENCE}; resources summary; profile ∈ DESKTOP_PRIMARY, DESKTOP_SECONDARY, PORTABLE_CORE, EDGE_LOW_POWER, SERVER_PRIVATE, REMOTE_COMPUTE, TEMPORARY_NODE. Advertisement = availability metadata ONLY.

### Routing (DistributedExecutionRouter)
- Placement: AFTER the canonical Authority gate. Router requires an `authorityDecisionDigest` (injected trusted source) — routing without an authority decision is unbuildable.
- Hard eligibility (never score-bypassable): advertisement match (capabilityId+toolId, HEALTHY) → privacy locality (profile's permitted classes) → registry presence + not OFFLINE (unless only candidate and allowed) → trust scope COMPUTE or TOOL_EXECUTION under CURRENT generation.
- Score (only among eligible, deterministic): headroom ≤40 + latency ≤25 + reliability ≤25 + locality 10 + privacy-fit 5 + placement-preference 50. `preferredNodeId` is a SCHEDULING HINT — eligibility is never overridden.
- Privacy placement: profile locality classes gate SECRET_REFERENCE/PRIVATE data; REMOTE_COMPUTE never receives SECRET_REFERENCE.
- Local execution: winner == local node → no remote lease; execution proceeds under the same authority decision via the frozen local actuation path.

## Invariants proven by tests

1. Lease binds intent+node+generation+nonce; malformed/incomplete leases unbuildable.
2. Untrusted/no-scope node never routed (trust beats score).
3. Revoked node rejected mid-routing; capability disappearance → fail-closed; partition (OFFLINE) excluded.
4. SECRET_REFERENCE never routes to REMOTE_COMPUTE; PUBLIC may go remote via preference hint; hint cannot override eligibility.
5. Target-side verification: wrong node / stale generation / changed digest / wrong capability-tool / expiry / one-use replay — all fail closed.
6. Forged remote results (output or digest mismatch, illegal states, future timestamps) rejected; legal flows land VERIFIED/COMPENSATED.
7. UNKNOWN after dispatch timeout; no blind retry (illegal transitions rejected); exit only via VERIFIED/COMPENSATED.
8. No authority transfer: lease carries only the decision digest reference; revocation between lease and execution fails stale.
9. Duplicate dispatch rejected by the state machine.

## Downstream consumption rules

- L6 consumes: router + lease + state machine for recovery/failover, UNKNOWN state for action-uncertainty handling, reliability records for circuit-breaker inputs.
- L4/L5 consume: advertisement shape for capability provenance/edge profiles.
- The router NEVER calls models and NEVER grants authority; changes require DOWNSTREAM_CHANGE_REQUEST.md.
