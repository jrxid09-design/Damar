# WAVE 6 REPOSITORY RECON REPORT

Baseline: `3b7d85c8e9b9dee680ce75498efc1c72a0223438` (Wave 5 frozen canonical HEAD)
Worktree: `C:\Workspace\Aether-wave6`, branch `feat/wave6-distributed-damar`

## 1. Frozen canonical owners (Waves 1–5)

| Owner | Location | Key surface | Wave 6 relationship |
|---|---|---|---|
| Device Identity & Pairing V1 | `src/embodiment/identity/service.js` (+ `types.js`, `store.js`, `challenge.js`) | `DeviceIdentityService`: `registerIdentity`, `beginPairing`, `submitChallenge`, `ownerConfirm`, `setTrust`, `revoke`, `openSession`, `serialize/restore`. States: UNPAIRED→CHALLENGE_ISSUED→AWAITING_OWNER_CONFIRMATION→PAIRED→TRUSTED/LIMITED/REVOKED/EXPIRED. Laws: `paired != authorized`, `trust != permission`, `offline != revoked` | **Node pairing EXTENDS this owner.** NodeIdentity binds to a deviceId; no second pairing root. |
| Secret Vault | `src/runtime/vault/vault.js` (`createSecretVault`) | secret store port | SECRET_BOUND state class never replicates values; references only. |
| Audit Ledger | `src/runtime/auditLedger/ledger.js` | append-oriented ledger, hash chain over canonical serialization, sequence monotonic, sink port, `canonicalJson.js`, redaction | Mesh/state/execution/evolution events append via a bridge adapter (not a second ledger). |
| Authority (incl. Evolution Authority V1) | `src/authority/*` (`store.js` atomic ops, `registry.js` EVOLUTION_PROPOSED/REVISED, `model.js` `buildEvolutionProposal`/`EVOLUTION_STATUS` DRAFT→…→ROLLED_BACK, `buildRatification`) | capability grants, delegation budgets, evolution proposals + owner ratification | L7 evolution proposals are built through `buildEvolutionProposal` + ratified through the existing registry. NO parallel self-modification authority. |
| Capability Registry | `src/capability/registry/*` (`registry.js`, `graph.js`, `ids.js`) | `capabilityId` + `incarnationId` + `generation`, mint-token gated registration, dependency graph (cycles rejected), availability | L3 node capability availability is an EXTENSION surface keyed by node; the registry stays the single capability owner. |
| Action Intent + Authority Gate | `src/action/*` (`intent.js`, `gate.js`, `bootstrap.js` privileged-closed) | immutable ActionIntent (string-only JSON, authority-shaped keys rejected), admission binds capability incarnation; gate NEVER executes | L3 execution leases reference admitted intents by digest; leases are NOT authority. |
| Actuation / Verification | `src/action/actuation/*` (`dispatcher.js`, `lifecycle.js`), `src/action/verification/*` (`verifierRegistry.js`, `postcondition.js`) | governed execution + postcondition verification registries | Remote execution results re-enter the SAME verification registry; UNKNOWN_EXECUTION_STATE integrates here. |
| Session Continuity | `src/runtime/sessionContinuity/*` (`continuity.js`, `persistence.js`, `transportPeer.js`) | canonical `dsc_*` session ids, incarnation generations, cross-channel bindings, `SESSION != AUTHORITY`, `PERSISTED STATE != LIVE AUTHORITY` | L2 cross-node session migration extends continuity; no SessionManager2. |
| Recovery Capsule | `src/runtime/recovery/*` (`checkpoint.js` atomic capture→validate→commit, `ids.js` `rc-`/`rtg-`/`repoch-` opaque ids, `generation.js` GenerationLedger, `wisesProvider.js`) | bounded capsule, atomic commit, generation ledger | L6 distributed recovery reuses capsules + generation ledger; `drec_` episode ids; no Recovery2. |
| Resource Governor | `src/runtime/resourceGovernor/*` (`governor.js`, `pressure.js`, `observer.js`, `lease.js`, `queue.js`) | pressure bands, admission queue, leases, bounded diagnostics | L6 node resource reports feed the SAME governor via observer adapters. |
| InteractionBus / RuntimeHost / Manager | `src/runtime/interactionBus/*`, `src/runtime/host/*`, `src/manager/*` | envelope + managerIngress + routing; RuntimeHost phases; Manager bootstrap | L1 mesh ingress terminates in Manager via an adapter; NO bypass path. |
| OwnerTrust | `src/authority/ownerTrust/*` | principal records, trust generations, transport provenance issuers | Node trust generation follows the same opaque-token discipline (`ntgen_`). |
| EntityModelFederation / WisesRuntime | `src/services/modelFederation.js`, `src/services/wisesRuntime.js` | provider routing + survival fallback; `wrtep_` readiness tokens | L5 edge cognition uses the SAME substrate abstraction (profile swap, not redesign). |
| MCP | `src/mcp/*` (`mcpClientManager.js`) | bridged external tools into AI registry with toolGuard | L4 adds lifecycle/quarantine/provenance AROUND the existing client manager; no second MCP root. |
| Pandawa | `src/services/pandawaIdentity.js`, `agentHub.js`, `pandawaColony.js` | five canonical roles, colony deliberation | L3/L5 node placement is scheduling metadata; ROLE != AUTHORITY preserved. |

## 2. Reusable components (direct reuse, no duplication)

- `src/runtime/auditLedger/canonicalJson.js` — deterministic canonical serialization (reuse for envelope digests).
- `src/runtime/recovery/ids.js` pattern — opaque fixed-pattern id discipline (`dnode_`, `dmesh_`, `ntgen_`, `dstate_`, `dexec_`, `dlease_`, `drec_`, `devo_`).
- `src/authority/model.js` `buildEvolutionProposal`/`buildRatification` — L7 proposal objects.
- `tests/helpers/testEnv.js` — env isolation for all Wave 6 tests.
- `src/embodiment/core/util.js` — `fail`, `sha256Hex`, digest helpers (embodiment-scoped; mesh uses its own `util.js` to keep isolation, same semantics).

## 3. Extension points

1. **Pairing**: `DeviceIdentityService.beginPairing/submitChallenge/ownerConfirm` — mesh node pairing wraps a device pairing transaction (adapter `meshPairing.js`).
2. **Audit**: ledger `append` port — `meshAuditBridge.js` appends mesh events.
3. **Capability availability**: registry observations are incarnation-bound — node capability advertisement references `capabilityId` + `incarnationId` only.
4. **Session migration**: continuity `dsc_*` + incarnation generation — checkpoint carries session references, never authority.
5. **Execution**: `DistributedExecutionRouter` sits AFTER Authority gate and BEFORE actuation dispatcher — remote dispatch is an actuation transport, not a new authority.

## 4. Collision risks (must NOT duplicate)

- Device pairing root — EXTEND via adapter only.
- Capability registry — node capability availability is annotation, not registration.
- Authority/evolution registry — L7 proposals go through the existing registry.
- Session owner — migration = new checkpoint + resume, not a second session store.
- Recovery — reuse capsule; `drec_` episodes wrap existing capsules.
- Model federation — node dimension extends routing input, never a second federation.

## 5. Migration risks

- `src/embodiment/identity/service.js` is isolation-contract-bound (requires only builtins + sibling embodiment modules). Mesh pairing adapter must NOT make embodiment depend on mesh; the dependency points mesh → embodiment.
- Audit ledger is sequence-ordered per node; multi-node audit events need node provenance fields — additive record fields, no schema break.
- Capability observations are incarnation-bound; node advertisement must carry `incarnationId` and be rejected on stale incarnation.

## 6. Files likely touched/created by Wave 6

- NEW: `src/mesh/**` (L1), `src/dstate/**` (L2), `src/dexec/**` (L3), `src/federation/**` (L4), `src/edge/**` (L5), `src/dresil/**` (L6), `src/evolution/**` (L7)
- NEW: `tests/wave6/**` per-lane suites
- MODIFY (narrow, additive): none required for L1; L3 may add one actuation transport adapter registration; L7 uses existing authority registry API only.
