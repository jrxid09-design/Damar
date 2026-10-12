# DAMAR UIX-W1 Context Capability Integration Repair 3

## Scope

Repair exactly F-CAP-009 and F-CTX-008. Propagate the canonical production
V1 capability registry through `RuntimeOptions` into `AIRuntime.resolveTools`,
and retire the environment-selected legacy context branch so the canonical
`src/ai/context/Pipeline.js` remains the sole runtime context owner.

## Exact finding extraction

- F-CAP-009: Canonical V1 capability availability/graph data was not an input
  to model-facing AITool retrieval/ranking. Source: `src/ai/runtime/AIRuntime.js`,
  `src/ai/runtime/RuntimeOptions.js`, `src/ai/builder/AIBuilder.js`,
  `src/action/bootstrap.js`, and `src/ai/capability/ContextCapabilityIntegration.js`.
  Symbol: `AIRuntime.resolveTools`, `ContextCapabilityIntegration.project`,
  `Pipeline.select`. Current path drops `capabilityRegistry` in RuntimeOptions,
  so AIRuntime passes null. Minimal repair: carry the canonical registry through
  the existing builder/options composition path and prove availability and
  dependency state affect model-facing candidates.
- F-CTX-008: `DAMAR_CONTEXT_PIPELINE=legacy` remains runtime reachable and can
  produce context through a shadow branch. Source: `src/services/aiRuntimeService.js:1425-1429`.
  Symbol: `AIRuntimeService.assemble`. Current path conditionally calls
  `withMind -> withMemory -> withSystemPrompt`; minimal repair: retire that
  runtime branch so `assemble` always delegates to canonical `Pipeline.select`.

## Source-backed production chain before repair

`src/action/bootstrap.js` canonical `CapabilityRegistry` owner ->
`AIRuntimeService.initialize()` -> `new Damar.Builder()` ->
`AIBuilder.build()` -> `new RuntimeOptions(this._options)` (drops registry) ->
`new AIRuntime(context, options)` -> `AIRuntime.resolveTools()` passes null ->
`ContextCapabilityIntegration.project()` cannot join V1 evidence ->
existing tool selector.

## Implementation

1. Add the existing `capabilityRegistry` field to RuntimeOptions without a
   positive fallback; absence remains distinguishable from an empty registry.
2. Add a builder composition method and pass the canonical registry from the
   production AIRuntimeService composition root. Preserve direct/unit callers.
3. Expose only the existing bootstrap-internal read path needed to obtain the
   canonical registry; do not create or duplicate a registry.
4. Remove the runtime-reachable legacy context branch from `assemble`; retain
   canonical Pipeline behavior and do not change authority or selection gates.
5. Add production-like and context source-of-truth/divergence tests, including
   UNKNOWN and missing-registry behavior and V1 availability/dependency effects.
6. Reconcile only directly affected W1 artifacts and write Repair 3 evidence.

## Verification

- Run targeted RuntimeOptions, AIRuntime, builder/bootstrap, integration,
  capability registry/graph, selector, Pipeline, legacy-path, and frozen
  authority suites three consecutive times.
- Run canonical `npm test` on the final candidate worktree.
- Review the diff, preserve unrelated user changes, and create a narrow commit.

## Exclusions

No new registry, graph, context store, authority layer, selector redesign,
L11 work, UIX-W2 work, or repair of F-CTX-003, F-CTX-004, F-CAP-006, or
F-CAP-007.
