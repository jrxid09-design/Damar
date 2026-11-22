# R6 Control-01 checkpoint (2026-11-21)

Owner-authorized: DAMAR Control dashboard in candidate R, Windows desktop release v1.

## Files
- NEW `src/control/index.html` — CC2-M2 shell markup (sidebar 260/66, topbar, Ctrl+K palette, drawer, toast); no inline script; idle-presence surface and mock task modal removed; Owner action dialog added.
- NEW `src/control/control.css` — verbatim CC2-M2 `public/index.html` lines 9-2091 (tokens/layout unchanged).
- NEW `src/control/control.js` — Core-bound app: views, Core client, redaction, Owner actions, Control session + lease heartbeat. Exports pure helpers for tests under Node.
- NEW `src/control/serve.cjs` — allowlisted static handler (5 paths), loopback/Host guard, strict CSP, nosniff, DENY framing, no-store.
- NEW `src/control/launch.cjs` — Owner launcher; reads `credentials.json` (owner) + `console-credentials.json` (console) like the CLI; opens `http://127.0.0.1:<port>/control/#owner=..&console=..` (fragment only).
- NEW `src/control/damaricon-clean.png` — copy of the approved icon.
- NEW `tests/control-dashboard.test.cjs` — 8 tests against a live fixture Core on 29641.
- NEW `evidence/control-r6/*.png` — 14 Control + 3 prototype screenshots.

## Core changes
- `src/core-host/core-host.cjs:336` require `../control/serve.cjs`; `:340` `/control` paths -> `serveControl` (before the r9/console dispatch). No existing check changed.
- `src/core-host/r9-routes.cjs:207-211` NEW `GET /api/r9/presence/settings` (owner or requester, no query, non-GET -> 405) -> `{success,data:{presence,revision,updatedAt}}`.
- `src/core-host/core-settings.cjs:19-30` `PRESENCE_DEFAULTS`/`PRESENCE_RULES` allowlist; `DEFAULTS` gains `revision:0` and `presence`; `:43` load keeps only valid stored presence keys; `:44` `save()` increments `revision`; `:119-120` `view()` includes presence+revision, new `presence()`; `:137-141` `update()` validates `values.presence` (unknown key or bad type/range -> 400 `PRESENCE_SETTINGS_INVALID`); `:173` exports `PRESENCE_DEFAULTS`.
- Presence writes: Owner-only via existing `POST /api/r9/settings {action:'update', cliSession, client, values:{presence:{...}}}` (attached session lease, same envelope).
- Presence keys: idleToNotchMs int 1000..600000 (10000), morphMs int 0..5000 (620), reducedMotion system|on|off (system), notchEnabled bool (true), notificationPrivacy redacted|counts-only|hidden (redacted), display `^[A-Za-z0-9._:\\-]{1,64}$` (primary), position top-center.

## Launch
1. Start Core: `START_DAMAR_CORE.ps1 -Session <new dir under D:\Damar\R9_WORK\r7r3-scratch>`.
2. `inherited-v53\node.exe src\control\launch.cjs <that session dir>` (add `--print` to print the URL). Deep link: append `&view=<id>` to the fragment.

## Tests
- `tests/control-dashboard.test.cjs`: 8/8 (static+CSP+host guard, auth required, live binding, redaction, unavailable honesty, mutation error envelopes, presence settings, launcher).
- Full safe suite (62 files, computer-use excluded, concurrency 1, tap): 273/273 pass, 0 fail.

## Fidelity gaps vs prototype
- Nav labels Activity->Sessions, Tasks->Usage; New Task->New Run (real Pandawa delegate); runtime pill shows live lifecycle.
- Overview tiles omit the decorative `signal-bar-mini` progress bars (no truthful metric to fill them); prototype task/health panels replaced by run ledger + budget.
- Pandawa DAG SVG (fixture topology) omitted; registry + run ledger kept.
- Idle Presence surface not embedded (separate surface); footer link shows a notice.
- Headless Chromium enforces ~500px minimum layout width, so 390px shots crop identically for Control and prototype; true 390 not measured.

## Remaining risks / open items
- Owner token sits in the browser process command line and page memory while open (same user can already read credentials.json).
- CLI settings still client-side (`src/cli/ui-settings.cjs` -> `<profile>/cli-ui-settings.json`): theme, animate_banner, language, hud_position, provider, model, core_session. Not in Core; Control shows them read-only as "not yet in Core". Agent autonomy/skills/plugin trust are already Core-side and shared.
- Control session ("DAMAR Control") appears in the CLI session list; checkpoint view attaches a detached CLI session (lease lapses 15 s after leaving).
- Mata Dewa, Cyber, Automations, Logs, Mobile: "not available in this release".
- No restart button (by design); model-grant success path not exercised (fixture returns rollback-authority 503).
