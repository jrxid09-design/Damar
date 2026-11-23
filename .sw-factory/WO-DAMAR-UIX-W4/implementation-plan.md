# UIX-W4 implementation plan

## Scope

Build the shared UI platform foundation only. Do not implement the Idle/Presence product, Dashboard pages, Developer Workspace, terminal WebSocket, or any new authority/runtime state owner.

## Architecture decision

The repository has no browser UI toolchain to reuse. Use dependency-free CommonJS modules under `src/ui-platform` and browser-safe DOM descriptors/primitives. This keeps the platform portable, testable with Node's native test runner, local-first, and compatible with a future adapter for a full browser framework without creating a second client/query/token system.

## Work packages

1. Contracts and manifests: typed-by-convention validators for entities, routes, components, current/future gating, density, errors, and authority boundaries.
2. Transport/state: API client, session boundary, read-model/query cache, command client, subscription reconciliation, approval/notification projections.
3. Visual foundation: W3 state binding/priority, semantic tokens/theme, motion/reduced-motion, responsive/accessibility primitives, status and error state primitives.
4. Shell/handoff: idle and dashboard shell boundaries, route outlet/deep links, command palette/entity inspector contracts.
5. Evidence: fixtures, validators, meaningful W2/W3 contract tests, handoffs, architecture and security notes.

## Verification

- Run targeted W4 tests three times.
- Run manifest/artifact validation three times.
- Run native whole-Damar tests twice where practical and reconcile the frozen baseline.
- Run static checks available in this repository; record unavailable UI build/lint/typecheck as bounded by the lack of an existing toolchain.
- Commit only W4-owned changes on the isolated worktree.
