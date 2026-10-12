# WO-UI-W0 — Legacy Console retirement and Web Dashboard architecture

## Scope

- Prove the Electron Console is not a RuntimeHost/runtime dependency.
- Remove Console-only desktop implementation and launcher/CLI entrypoints.
- Preserve shared daemon routes, authority, transport, types, and assets unless independently reusable.
- Write the requested Web Dashboard architecture evidence outside the production tree.
- Validate runtime startup and affected regression suites, then commit a controlled descendant of the certified SHA.

## Exclusions

- Do not implement the Web Dashboard.
- Do not implement Damar Idle/Presence.
- Do not rename or remove shared `/api/v1/console` contracts in this retirement change.
- Do not modify `C:/Workspace/Wises`.

## Implementation sequence

1. Complete repository archaeology and classify Console files/dependencies.
2. Write evidence and product/architecture documents to `C:/Workspace/Damar-audit-evidence/web-dashboard/`.
3. Remove Console-only tree and update package/launcher/CLI references so normal runtime and CLI remain valid.
4. Run targeted tests, runtime startup verification, affected package checks, and full regression as practical.
5. Perform a fresh read-only audit pass and record P0/P1/P2 findings.
6. Commit the retirement/refactor without rewriting history.

## Acceptance evidence

- `apps/console` is absent from the canonical source tree and no production entrypoint launches it.
- `src/server.js` and RuntimeHost have no import or asset dependency on the retired tree.
- Shared API routes, authority gates, telemetry/SSE, WebSocket transport, companion contracts, and CLI runtime remain present.
- The nine requested evidence documents exist at the requested external path.
- Runtime startup and regression results are recorded in the checklist and retirement document.
