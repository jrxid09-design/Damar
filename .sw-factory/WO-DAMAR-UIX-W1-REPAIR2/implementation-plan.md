# DAMAR UIX-W1 Context Capability Integration Repair 2

## Scope

Repair the audited UNKNOWN-state false-positive projection in the existing
`ContextCapabilityIntegration` path. Reconcile F-CAP-005 and F-CAP-009 only;
preserve the five independently accepted deferred P2 findings, the frozen
authority/lifecycle architecture, and the existing Context Pipeline and
selector composition.

## Exact findings

- F-CAP-005: no native unified CODE_EXISTS/REGISTERED/COMPOSED/
  RUNTIME_REACHABLE/USER_REACHABLE/GOVERNED/TESTED/CERTIFIED state model across
  the V1 registry, AIToolRegistry, and autonomy catalog. The prior repair
  projected unsupported positive state for unjoined AITools.
- F-CAP-009: canonical V1 capability availability/graph data was not an input
  to model-facing AITool retrieval/ranking; the prior explicit-ID join existed,
  but untagged tools remained outside V1 proof and were over-projected.

## Implementation

1. Reproduce the unjoined AITool projection and inspect existing tri-state
   conventions.
2. Change only `src/ai/capability/ContextCapabilityIntegration.js` so absent
   joins and absent positive evidence remain `UNKNOWN`; require explicit
   dependency satisfaction for positive availability/reachability; add the
   existing projection's `executable` state as UNKNOWN unless supported.
3. Keep UNKNOWN items discoverable and filter only proven false items, while
   preserving contextual relevance filtering and the existing selector path.
4. Add behavioral tests for UNKNOWN versus FALSE/TRUE, positive and negative
   evidence, non-executable UNKNOWN projection, read-only introspection,
   contextual materiality, F-CAP-005/F-CAP-009, and authority non-escalation.
5. Reconcile only directly affected W1 artifacts and write Repair 2 evidence.

## Verification

- Run the focused integration suite three consecutive times.
- Run targeted context/capability/selector and frozen authority suites.
- Run canonical `npm test` on the final candidate worktree and record totals,
  skips, and timeout files.
- Review diff, preserve unrelated user changes, and create a narrow commit.

## Exclusions

No new registry, graph, context store, authority layer, intelligence
subsystem, L11 synthesis, broad capability rationalization, UIX-W2, or repair
of the five valid deferred P2 findings.
