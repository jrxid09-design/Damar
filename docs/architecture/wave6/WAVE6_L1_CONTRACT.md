# WAVE 6 — LANE 1 CONTRACT (FROZEN)

Status: **L1_CONTRACT_FROZEN = YES**
Baseline: Wave 5 frozen HEAD `3b7d85c8e9b9dee680ce75498efc1c72a0223438`
Internal verification: `tests/wave6/l1/meshFabric.test.js` (22/22 PASS) + `tests/wave6/l1/multiNode.test.js` (2/2 PASS) + frozen-owner regression (pandawa/manager/authority/delegationAuthority: 345/347 PASS — 2 failures are the independently classified BASELINE_EQUIVALENT residuals `delegationAuthority:84/:142`, unchanged from Wave 5 baseline, NOT caused by Lane 1).

## Frozen canonical schemas

### NodeIdentity (src/mesh/meshIdentity.js)
- `nodeId`: `dnode-<32hex>` — opaque, minted by `mintNodeIdentity()` only. NEVER hostname/IP/MAC/PID (those are bounded string `attributes`).
- `logicalDamarId`: `damar-<32hex>` — binding is IMMUTABLE for the node's life.
- `identityProvenance`: bounded string (≤64).
- `attributes`: ≤24 entries, key ≤64 chars, value ≤256 chars, dangerous keys rejected.
- `identityDigest`: SHA-256 over canonical {nodeId, logicalDamarId}.
- Construction paths: `mintNodeIdentity` (fresh), `adoptNodeIdentity`/`coerceNodeIdentity` (restored/external, strict pattern validation, `NODE_IDENTITY_MALFORMED` on failure).

### NodeRegistryRecord (src/mesh/nodeRegistry.js)
- Immutable: `recordId` (`dnreg-<32hex>`), `identity` (NodeIdentity), `registeredAtMs`.
- Mutable bounded metadata (closed patch vocabulary; identity keys rejected `IDENTITY_IMMUTABLE`): `displayName` ≤120, `addresses` ≤8 strings ≤256, `liveness` ∈ {UNKNOWN, ONLINE, DEGRADED, OFFLINE, SUSPECT, RECOVERING}, `lastSeenMs`, `trustRef` {trustGeneration, state}, `capabilitySummary`/`resourceSummary` ≤64 entries, value ≤128.
- Registry cap `maxNodes` (default 256) → `NODE_REGISTRY_FULL`.
- Re-registration with conflicting identity (same nodeId, different digest/damarId) → rejected as forged.

### NodeTrustRecord / TrustScope / TrustGeneration (src/mesh/nodeTrust.js)
- States: `DISCOVERED, UNPAIRED, PAIRING_PENDING, TRUSTED, LIMITED, QUARANTINED, REVOKED, EXPIRED`.
- Scopes (closed vocabulary): `OBSERVE, STATE_REPLICA, MEMORY_REPLICA, COMPUTE, TOOL_EXECUTION, PORTABLE_CORE, RECOVERY_PEER, ADMINISTRATIVE_HOST`.
- `trustGeneration`: `ntgen-<32hex>` opaque; minted at pair/revoke; ALL scope checks require exact current-generation identity; retired generations retained per node (≤8) only for stale detection.
- Scope grants: {grantedAtMs, expiresAtMs} — TTL-bound (`PAIRING != PERMANENT TRUST`); all-expired → state EXPIRED (fail-closed).
- `authorize({nodeId, scope, trustGeneration})`: exact-scope, exact-generation, fail-closed. Error codes: NODE_UNTRUSTED, NODE_REVOKED, NODE_QUARANTINED, TRUST_EXPIRED, TRUST_SCOPE_MISSING, TRUST_GENERATION_STALE.
- `revoke()`: immediate scope wipe + generation rotation; old proofs fail stale forever. Re-pair mints a NEW generation.
- `quarantine()`/`releaseQuarantine()`: blocked ↔ LIMITED (never auto-TRUSTED).
- Trust table cap 256.

### DamarMeshEnvelope (src/mesh/meshEnvelope.js)
- `schemaVersion` (1; unknown critical versions → SCHEMA_VERSION_UNSUPPORTED).
- `messageId`: `dmesh-<32hex>`; `logicalDamarId`; `sourceNodeId`; `destinationNodeId` XOR `multicastScope` (self-addressed rejected); `messageType` (closed vocabulary of 19 types); `createdAtMs`; `expiryMs` (default TTL 30s); `trustGeneration`; `sessionReference` ≤128; `causalMetadata` ≤16 entries; `payloadDigest` = SHA-256 over DETERMINISTIC canonical encoding of payload; `payload` (plain JSON, ≤256 KiB, frozen, dangerous keys rejected); `authenticity` (proof slot — transport layer fills; never identity); `traceId` ≤128.
- Inbound: `coerceInboundEnvelope` re-validates everything from the wire (structure, formats, version, expiry, digest binding). Payload detached (deep-copied) before freezing — idempotent re-coercion.
- Wire encoding: `encodeEnvelope` — deterministic canonical JSON.

### NodePresence (src/mesh/meshPresence.js)
- Observation windows: ONLINE ≤15s → SUSPECT ≤30s → RECOVERING ≤120s → OFFLINE.
- Presence is TELEMETRY ONLY: never mutates trust; ONLINE != TRUSTED; OFFLINE != REVOKED; explicit OFFLINE stays OFFLINE (no aging downgrade for graceful shutdown).

### MeshRoute / routing (src/mesh/meshRouter.js)
- Single canonical ingress `ingest({frame, transportPeer, receivedAtMs})`: structural coercion → registry lookup (unknown source → NODE_UNKNOWN) → transport-peer binding check (mismatch → TRANSPORT_SPOOF) → replay guard (MESH_REPLAY) → trust gate (exact scope per message type + exact generation) → destination check (DESTINATION_MISMATCH) → liveness observation (telemetry, never blocks) → audit (accepted AND rejected, never blocks) → handler.
- Per-type required scope map is FROZEN (e.g. STATE_REPLICATE→STATE_REPLICA, EXECUTION_REQUEST→COMPUTE, CONTROL_REVOCATION→ADMINISTRATIVE_HOST, pairing types → pairing-adapter gate).
- Outbound: bounded priority queues (CONTROL=0, RECOVERY=1, STATE=2, EXECUTION=3, TELEMETRY=4); caps: 8 queues, 1024 items, 4 MiB per queue, 60s expiry; TELEMETRY droppable under pressure, CONTROL never silently dropped.

### MeshError (src/mesh/errors.js)
- Closed code vocabulary (NODE_IDENTITY_MALFORMED, NODE_UNTRUSTED, NODE_REVOKED, NODE_QUARANTINED, TRUST_GENERATION_STALE, TRUST_SCOPE_MISSING, TRUST_EXPIRED, PAIRING_INVALID, PAIRING_EXPIRED, IDENTITY_IMMUTABLE, MESH_REPLAY, MESSAGE_EXPIRED, MESSAGE_MALFORMED, SCHEMA_VERSION_UNSUPPORTED, DESTINATION_MISMATCH, PAYLOAD_DIGEST_MISMATCH, TRANSPORT_SPOOF, NODE_UNKNOWN, NODE_REGISTRY_FULL, REGISTRY_UPDATE_REJECTED, ROUTE_UNAVAILABLE, BOUNDS_EXCEEDED).
- Typed envelope {kind: MESH_FAILURE, code, message, details}; messages bounded ≤300 chars, no stack traces.

### Pairing extension (src/mesh/meshPairing.js)
- Wraps the FROZEN DeviceIdentityService (no second pairing root): `discover` → DISCOVERED/no scopes; `beginNodePairing` wraps `deviceIdentity.beginPairing` + PAIRING_PENDING; `submitNodeChallenge` wraps `submitChallenge` (single-use challenge secret from frozen ChallengeBroker); `ownerConfirmNode` wraps `ownerConfirm` → TRUSTED with owner-approved scopes + fresh generation; `cancelNodePairing` → back to DISCOVERED; `revokeNode` → device revoke + trust generation rotation.
- Pending pairings bounded (16).

### Audit bridge (src/mesh/meshAuditBridge.js)
- Appends `mesh.*` records to the frozen Audit Ledger sink port with node provenance. Best-effort: ledger failure → bounded buffer (512, drop-oldest); never blocks ingress. Buffered digest for tamper-evidence.

### Transport (src/mesh/meshTransport.js)
- Adapter contract {id, send, onReceive, bind}; `TRANSPORT ID != DAMAR IDENTITY`. Loopback transport for logical multi-node tests. `attachTransport` stamps CURRENT trust generation at send time.

### Policy/bounds (src/mesh/meshPolicy.js)
- All bounds centralized in `BOUNDS`. Partition classes per message type: PARTITION_SAFE / PARTITION_LOCAL_ONLY / PARTITION_BLOCKED / PARTITION_VERIFY_FIRST.

## Invariants proven by tests (all enforceable at the module boundary)

1. NODE DISCOVERY != NODE TRUST (discovered = zero scopes, authorize fails).
2. Trust is a scoped vector; one scope never implies another.
3. Stale/retired/forged trust generation fails by exact identity (old proof never valid after revoke/re-pair).
4. PAIRING != PERMANENT TRUST (TTL expiry fail-closed).
5. Identity immutability under update patches and re-registration.
6. Transport spoof rejection via bound peer labels.
7. Wire replay rejection; bounded replay ledger.
8. Message expiry fail-closed; wrong destination rejected.
9. Payload tampering → digest mismatch; non-canonical/ambiguous encodings rejected; -0 normalized; undefined-array/bigint/circular rejected.
10. ONLINE != TRUSTED; OFFLINE != REVOKED; presence never mutates trust.
11. Partition/rejoin: liveness and trust evolve independently; revocation during partition survives rejoin.
12. Multi-node (A/B/C logical switch): scoped delivery over real wire paths, cross-node replay rejection, unpaired node rejected, revocation propagation, audit accepted+rejected trail.
13. Boundedness: registry/trust/presence/replay/queues/envelope caps enforced with typed failures.
14. Typed failures without stack traces.

## Downstream consumption rules

- L2/L4/L5/L7 may consume: ids, canonical, NodeRegistry, NodeTrust (snapshot/authorize semantics), envelope build/coerce/encode, MeshReplayGuard, MeshRouter ingress contract, partition classes, MeshError codes.
- Modifying ANY frozen schema above requires DOWNSTREAM_CHANGE_REQUEST.md with security/compatibility analysis.
- The trust plane NEVER grants Authority; execution/evolution/state lanes must re-validate through their frozen owners.
