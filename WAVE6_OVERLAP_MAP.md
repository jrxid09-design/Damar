# WAVE 6 OVERLAP MAP

Rule: `COMPLETED WAVE != REIMPLEMENT`. Every frozen owner keeps exactly one canonical implementation. Wave 6 modules are ADAPTERS/EXTENSIONS.

| Frozen owner (Wave) | Canonical file | Wave 6 consumer | Integration mode | Forbidden |
|---|---|---|---|---|
| Device pairing root (W?) | `src/embodiment/identity/service.js` | `src/mesh/meshPairing.js` | mesh pairing WRAPS a DeviceIdentityService pairing tx (deviceId ⇄ nodeId binding) | second pairing service, parallel trust root |
| Secret Vault | `src/runtime/vault/vault.js` | `src/dstate/classification.js` (SECRET_BOUND), `src/edge/storage.js` | SECRET_BOUND payloads never serialized; references only | replicating vault values |
| Audit Ledger | `src/runtime/auditLedger/ledger.js` | `src/mesh/meshAuditBridge.js`, `src/dstate/audit.js`, `src/dexec/audit.js` | appends via sink port with node-provenance fields | second ledger |
| Authority + Evolution Authority V1 | `src/authority/{store,registry,model}.js` | `src/evolution/proposal.js`, `src/evolution/shadow.js`, `src/dexec/lease.js` | leases reference admitted intents; proposals built via `buildEvolutionProposal`, ratified via registry | Authority2, self-approval |
| Capability Registry | `src/capability/registry/registry.js` | `src/dexec/capabilityAdvertisement.js` | node availability = observation annotations keyed by capabilityId+incarnationId | second registry |
| Action Intent/Gate/Actuation | `src/action/*` | `src/dexec/router.js`, `src/dexec/remoteTransport.js` | router sits after gate; remote dispatch is a transport under actuation | model→node direct path |
| Verification | `src/action/verification/*` | `src/dexec/verification.js` | remote results re-enter existing verifier registry | second verifier root |
| Session Continuity | `src/runtime/sessionContinuity/continuity.js` | `src/dstate/sessionMigration.js`, `src/dstate/checkpoint.js` | migration produces checkpoint + continuity resume; `dsc_*` stays canonical | SessionManager2 |
| Recovery Capsule | `src/runtime/recovery/*` | `src/dresil/recoveryPeer.js`, `src/dresil/episode.js` | `drec_` episodes orchestrate existing capsules + `repoch` | Recovery2 |
| Resource Governor | `src/runtime/resourceGovernor/*` | `src/dresil/nodeResources.js` | node reports feed governor observer port | second governor |
| EntityModelFederation | `src/services/modelFederation.js` | `src/edge/cognition.js`, `src/dexec/modelPlacement.js` | node dimension = routing input | second federation |
| MCP client | `src/mcp/mcpClientManager.js` | `src/federation/intake.js`, `src/federation/quarantine.js` | lifecycle wrappers around existing client lifecycle | second MCP root |
| Pandawa identity/colony | `src/services/pandawa*.js` | `src/dexec/pandawaPlacement.js` | placement metadata only | role→authority mapping |

## State classification ↔ owner map (L2)

| State family | Class | Canonical owner | Replication |
|---|---|---|---|
| conversation continuity | REPLICATED | sessionContinuity | selective, bounded |
| session bindings | OWNER_BOUND | sessionContinuity | no blind LWW; AUTHORITY_REVALIDATE on conflict |
| vault secrets | SECRET_BOUND | vault | NEVER replicated |
| audit events | AUDIT_IMMUTABLE | auditLedger | append-only, tamper-evident |
| presence | EPHEMERAL | mesh presence | not reconciled |
| node metadata | REPLICATED (bounded) | nodeRegistry | last-writer for non-critical fields only |
| memory namespaces | namespace class | memory core | per-namespace policy (SHARED_DAMAR only by default) |
| provider availability | DERIVED | modelFederation | not replicated; recomputed |
| model cache | CACHE | llamacpp engine | not replicated |
| UI/local prefs | LOCAL_ONLY | host | never synced |
