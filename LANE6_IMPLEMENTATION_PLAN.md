# Lane 6 Implementation Plan

1. Canonical identity/alias resolver and Manager/InteractionBus target path.
2. Bounded Pandawa session and presence extension over existing session owners.
3. Delegation/handoff envelopes with Authority-preserving restrictions.
4. Bounded orchestrator/Colony DAG using Resource Governor.
5. Scoped memory/context projections through existing memory governance.
6. Shared provider federation: adapters, multi-provider catalog, Vault-backed
   credential pools, discovery, health, and entity assignments.
7. Typed failure handling, circuit breaker, continuation-safe fallback, and
   mandatory Wises-D1 readiness/takeover integration through existing AI
   runtime and Recovery Capsule.
8. Surface convergence and UI configuration through existing routes/views.
9. Security/fault-injection/restart tests, then deterministic regression
   evidence.

Expected new files are feature-local extensions only after exact ownership
seams are confirmed. Likely areas are `src/services/`, `src/runtime/`,
`src/ai/`, `src/memory/`, `src/routes/`, and Console views; no standalone
control plane is planned.

## Risks

- Wises-D1 artifacts/runtime may be unavailable; then architecture readiness
  can be tested but real fallback cannot be certified.
- Existing provider config persists a single active route and must be
  migrated without leaking credentials or breaking Lane 5.
- Session continuity must not restore stale authority.
- Colony fanout and provider retries need hard Resource Governor bounds.
- Existing AgentHub role labels contain historical specialization; capability
  authority must remain independent of those labels.
