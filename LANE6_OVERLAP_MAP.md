# Lane 6 Overlap Map

| Required feature | Existing owner | Required extension |
|---|---|---|
| Direct Pandawa target resolution | InteractionBus + Manager + AgentHub | canonical IDs/aliases at ingress |
| Pandawa sessions | InteractionBus sessions + session continuity | bounded entity namespace and resume revalidation |
| Delegation/handoff | AgentHub + orchestrator + Authority delegation | minimum context envelope, no grant transfer |
| Colony graph | orchestrator + Resource Governor | bounded DAG/fanout and provenance |
| Pandawa memory | memory/governance + repositories | namespace policy, no authority from recall |
| Providers/models | AIRuntime + provider registry/config + ModelRouter | shared federation registry and entity assignments |
| Credentials | Secret Vault | credential pool references only |
| Health/retry/fallback | AI runtime/executors + Resource Governor + Recovery | typed failures, circuit state, Wises readiness |
| Audit/provenance | Audit Ledger | routing/delegation/fallback events, redacted |
| UI surfaces | existing routes and Console views | provider/entity/Colony views through Manager |

Duplicate-risk items: `src/pandawa/*` root control plane, a second model
router, a second provider registry, a second memory store, a second Vault,
a second ledger, direct Pandawa tool execution, and standalone Pandawa HTTP
servers. These are rejected.
