# Implementation plan

## Objective

Add one canonical context-capability projection/query at the existing `AIRuntime.resolveTools()` boundary. The query will filter and explain candidate tools using already assembled current request context plus existing AITool metadata and optional V1 registry observations. It will not authorize or execute.

## Minimal design

1. Add `src/ai/capability/ContextCapabilityIntegration.js` as the sole integration owner.
2. Project each existing AITool record into a read-only view with source state, relevance, availability, runtime reachability, and explanations. V1 registry records are joined by explicit metadata (`capabilityId`/`capabilityIds`) only; no name-based phantom mapping.
3. Evaluate only source-backed constraints: message/context lexical relevance, tool roles/channels, AITool metadata availability/reachability where explicitly supplied, and V1 availability/dependency status where joined. Unknown is not available/reachable.
4. Feed the view into the existing `ai/tools/Pipeline.select()` candidate path without changing Authorization or execution. Preserve the existing read-only selection behavior by only removing candidates proven irrelevant/unavailable/unreachable.
5. Pass assembled context/messages from `AIRuntime.resolveTools()` and preserve diagnostics/provenance in `lastSelection`.
6. Add focused tests for contextual filtering, relevance-vs-availability, unknown reachability, cross-registry projection, counterfactual materiality, and authority non-escalation.
7. Reconcile only the directly affected W1 artifact notes and write final evidence outside the product source.

## Verification

- Existing context/tool/registry/graph/manager/authority suites.
- New integration suite run three consecutive times.
- Final `npm test` from a clean worktree state with unrelated user changes preserved.
