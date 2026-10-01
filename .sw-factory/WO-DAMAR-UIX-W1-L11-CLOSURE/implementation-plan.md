# Implementation plan

1. Reproduce each audited gap against the current ContextItem/Pipeline,
   capability descriptor/registry/graph, and feedback stores.
2. Add the minimum canonical context truth primitives: explicit freshness
   state/version/invalidation and structured fact observation state that
   exposes conflicts without treating UNKNOWN or CONFLICTING as true.
3. Extend the existing capability descriptor/registry graph with explicit
   descriptive relation projections and reverse dependency/counterfactual
   queries; do not add a second graph or authority semantics.
4. Add a read-only canonical feedback projection that joins supplied existing
   ToolStats/autonomy/self-model evidence without creating a new persistence
   store or changing authority.
5. Add behavioral tests for each finding and focused readiness/frozen-path
   regression coverage.
6. Reconcile only the directly affected W1 register/evidence, run targeted
   tests three times, then run the final whole suite from a clean candidate
   worktree and commit only scoped files.

Acceptance: all four findings have runtime-material candidate closures;
UNKNOWN remains non-positive; certified integration and authority remain
intact; no L11 rationalization/synthesis is performed.
