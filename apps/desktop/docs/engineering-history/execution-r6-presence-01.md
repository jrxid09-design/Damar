# R6 presence 01 — DAMAR Idle Presence + Notch (Windows desktop v1)

Owner authorization 2026-11-21 (via lead). Written in R only; C read-only; no Git in R/C; no paid inference.

## Files (all new, `src/presence/`)

| File | Role |
|---|---|
| `package.json` | `electron` devDependency pinned **30.5.1** (prototype `^30`). Installed with `npm install`; binary extracted from the existing local cache `%LOCALAPPDATA%\electron\Cache\3fc8b100…\electron-v30.5.1-win32-x64.zip` by running `node_modules/electron/install.js` (npm blocked the postinstall). No download of Electron itself. `node_modules` = 262 MB inside R. |
| `main.cjs` | Electron host, port of `C/ui-prototypes/w5/main.js`. Transparent frameless always-on-top window, tray, Alt+D, click-through/standby focus rules kept. Removed: `/api/ui/*` proxy to fixed loopback 2906, `?r9r2-demo=1` navigation, `DAMAR_UI_OFFLINE_PREVIEW`, `DAMAR_TOKEN` env. Added: private `damar-presence://` scheme, `setWindowOpenHandler` deny, `will-navigate`/webview blocked, all device permissions denied, Core polling, display selection from Core config. `DAMAR_PRESENCE_SELFTEST=1` = hidden window probe used by tests. |
| `preload.cjs` | Sandboxed bridge (prototype shape) + `getPresence`/`onPresence`. No Core URL or credential reaches the renderer. |
| `host-policy.cjs` | Pure window options + IPC channel allowlist + `/api/ui/*` read mapping; every mutation refused (no conversation send, no dismiss, nothing approval-like). |
| `core-presence.cjs` | Core binding. Credential source = CLI's (`<session>/credentials.json`, `session.json` address check, `src/cli/service.cjs:40-42`), but **requester** token only; GET allowlist `/api/r9/lifecycle`, `/api/r9/sessions`, `/api/r9/pandawa/runs`, `/api/r9/presence/settings`. Session dir: `--session` or the CLI profile's `core_session` (same order as `src/cli/main.cjs:78-80`). Polls state 2 s, settings 5 s; 404/unavailable -> prototype defaults. |
| `projection.cjs` | Port of `C/src/presence-ui/projection.js:6-45` rules: allowlisted counts only; Pandawa task/output text never projected; sensitive items "Sensitive notification"; privacy `redacted`/`counts-only`/`hidden`; voice never implies health; unreachable Core -> NOT_CONNECTED, nothing claimed. |
| `renderer-files.cjs` | Allowlisted scheme handler; Owner page served byte-identical + scripts appended before `</body>` (same mechanism as the prototype server); CSP `default-src 'none'; connect-src 'none'` (renderer has no network). |
| `renderer/idle_present.html`, `damar-island-fsm.js`, `argon-character-engine.js`, `damaricon-clean.png` | Verbatim Owner sources (hashes = fidelity matrix: `574d3cae…`, `67159b5c…`, `98fe24b5…`). |
| `renderer/damar-island.js` | Port of `C/scripts/preview-adapters/damar-island.js` (sha `399c148c…`), geometry/tokens unchanged; deltas listed in its header. Current sha `94313200…`. |
| `renderer/presence-adapter.js` | Applies Core config live (dedup), reduced motion, hides settings panel (gear opens Control), replaces simulated Computer Use with a truthful notice, voice-yield hooks. |
| `renderer/argon-assets/visuals/*`, `LICENSE-ASSETS.md` | Copied from `C/ui-prototypes/w5/third_party/argon-damar` (engine loads `mochi_damar_hero_rig.png` from its absolute prototype path, mapped by the scheme). |
| `THIRD_PARTY_NOTICES.md` | Coucou MIT notice + Owner/legal flag (see risks). |

Tests (new): `tests/presence-fsm.test.cjs` (7), `tests/presence-projection.test.cjs` (8), `tests/presence-core.test.cjs` (4).

## Core changes

None by this work order (told not to edit `r9-routes.cjs`). Consumed route added by the Control agent per the agreed contract: `r9-routes.cjs:207-211` (`GET /api/r9/presence/settings`, requester or owner, read-only); store `core-settings.cjs:19-29` (defaults + rules), `:120` (`presence()` view), `:137-141` (Owner write via `POST /api/r9/settings` action `update` `values.presence`).

## Config keys consumed (defaults = prototype)

`presence.idleToNotchMs` 10000 · `presence.morphMs` 620 · `presence.reducedMotion` system|on|off · `presence.notchEnabled` true · `presence.notificationPrivacy` redacted|counts-only|hidden · `presence.display` primary|<Electron display id> · `presence.position` top-center. Applied live (5 s poll, change-only). No local settings store; no in-surface settings UI (prototype popover hidden; gear opens `http://127.0.0.1:<core>/control/` in the browser, no credential passed).

## Launch

```
D:\Damar\R9_WORK\candidate\damar-cli-single-product-01\src\presence\node_modules\electron\dist\electron.exe ^
  D:\Damar\R9_WORK\candidate\damar-cli-single-product-01\src\presence [--session "<Core session dir>"] [--profile "<CLI profile dir>"]
```
(`npm start -- --session …` from `src/presence` is equivalent.) Set `DAMAR_CORE_PORT`/`DAMAR_CORE_URL` when Core is not on 29623. Without a session the surface runs and says "DAMAR Core not connected".

## Behaviour verified

- Fake timers: orb -> exactly 10 000 ms -> morph -> exactly 620 ms -> compact; 24 h later still compact, no notch timer; orb activity restarts window; pointer enter/leave/hover-reveal/click-outside (prototype tests ported).
- Real Electron renderer (hidden window) bound to fixture Core on 29642: webPreferences nodeIntegration=false, contextIsolation=true, sandbox=true, webSecurity=true; `require`/`process` undefined; renderer `fetch` blocked; morph 620-634 ms measured; compact holds 3 s (no auto-hide); voice -> orb, held while voice, notch returns after voice; pointer-leave -> hidden with orb opacity 0; `notchEnabled=false` holds orb; settings popover display none; Core config source `core`.
- Fixture Core: session appears; turn "create a python script…" produces pending permission -> approvals PENDING read-only, status "permission waiting · answer in CLI", no prompt text leaked; requester token gets 403 on the permission route; Owner settings update reaches Presence live.

## Evidence

`evidence/presence-r6/`: `prototype-{1..6}-*.png` vs `product-{1..6}-*.png` (full idle presence, orb standby, morph, compact, expanded, hidden), product-only `7-attention-compact`, `8-attention-expanded`, `9-voice-yields-orb`; `screenshots.json`; generator `shoot.cjs` + `compare-server.cjs` (offscreen Electron, 1440x900, window bg #2a2d34 behind the transparent page). Chrome is not installed, so chrome-devtools MCP could not run; Electron's Chromium was used instead. Product vs prototype differ only in data text (prompt placeholder "Message DAMAR" when connected) and animated canvas frames.

## Coucou feature matrix (upstream rev ab98143, README + windows/src/island)

| Coucou feature | DAMAR equivalent | Core data source / status |
|---|---|---|
| Hidden when idle, peek on hover of top edge, enter expands, leave folds | Notch FSM (pointer-only, no timers per Owner) | Implemented (UI-only). |
| Alert waiting stays visible / "tells you the moment the agent needs you" | New pending permission peeks the notch to compact (event, not timer); "Answer in CLI" button | Implemented from `GET /api/r9/lifecycle` `outstanding.pendingPermissions`. **Owner to confirm** (spec says pointer-only; this is a Core event). |
| Approve / Deny / Always from the notch | Deliberately NOT implemented: notch shows waiting, decision in CLI/Control with Owner auth | Policy (handover). |
| Live agent sessions in the notch | Status line: Core lifecycle, running turns, Pandawa runs, session count; Pandawa runs feed the page's Missions card | Implemented: `/api/r9/lifecycle`, `/api/r9/sessions`, `/api/r9/pandawa/runs` (requester). |
| What the agent reads/edits/runs, live diffs (+N −M) | — | **Needs Core route**: read-only, requester-scoped activity feed, e.g. `GET /api/r9/activity?from=N` -> `[{seq, turnId, kind: read|edit|command|delegate, file: basename|null, added, removed, at}]`, redacted per `notificationPrivacy`, no content. Turn SSE is Owner-only. |
| Agent finished -> happy jump | Character emote | Needs the same activity/turn-completed feed (or `GET /api/r9/turns/recent` requester-readable: `[{turnId,status,endedAt}]`). |
| AskUserQuestion choices in the notch | — | Out of scope v1 (answers are Owner decisions; would need Owner auth in notch). |
| Chat in the notch | Page composer returns "Conversation runs in DAMAR CLI" | Out of scope v1: `/api/r9/turns` needs Owner credential + attached session lease. |
| Plan/usage pill | — | Data exists (`GET /api/r9/provider/budget`, `/api/r9/usage?cliSession=`) but no Owner-approved DAMAR visual; shown in Control. |
| Choose screen / multi-display | `presence.display` | Implemented (Core config). |
| Keyboard shortcut | Alt+D (prototype) | Implemented. |
| Tray | Prototype tray + "Open DAMAR Control" | Implemented; not verified on interactive desktop. |
| Launch greeting / idle breathing / eyes / emotes | Prototype intro choreography, orb, character engine | Implemented as in prototype (no new art). |
| Voice ("OK Coucou") | Prototype wake word; voice yields notch to orb | Hooks implemented; mic permission denied in v1 -> **needs Core voice route** (voice state + transcript events) and Owner decision on mic. |
| Drop a file on the notch | — | Needs Core ingress route (attachments) — out of scope v1. |
| Integrations (Stripe, GitHub, Vercel…), Spotify/Apple Music, Mail, WhatsApp, portfolio, weekly recap, phone link, desktop Mochi, wardrobe, own sounds, dictation/notetaker, 16 languages | — | Out of scope v1 (no Core capability / no Owner design). |
| Private by design | No telemetry, renderer has no network (CSP), requester token only, main process only talks to loopback Core | Implemented. |

## Fidelity gaps / decisions for Owner

1. Expanded notch (C `damar-island.js`): the 396x240 character stage fills the 158 px panel, so the status line and buttons (`Return to Presence`, `Dashboard`, new `Answer in CLI`) are clipped — same in prototype screenshot 5. Not changed (no redesign). R's older inherited island copy used a 70 px stage; Owner to choose.
2. Product hides the orb while the notch is pointer-hidden after the first morph (Owner directive 2 in the island header); the C adapter let the orb reappear in that state.
3. Settings popover removed from view (Owner: no settings UI); gear opens Control. Replay-intro etc. no longer reachable.
4. Simulated Computer Use walkthrough replaced by truthful notice; prototype voice quick prompts therefore inert.
5. Reduced motion: CSS transitions/animations reduced; canvas/WebGL orb, particles and character keep animating.
6. Cinzel loads from Google Fonts (Owner source); offline falls back to declared fonts.
7. Character naming "Mochi Damar" in engine/asset notes conflicts with Coucou LICENSE-ASSETS (name "Mochi" reserved) — legal/Owner review before distribution (see THIRD_PARTY_NOTICES.md).

## Remaining risks (need a real interactive desktop)

Not verified: tray icon/menu, Alt+D global shortcut, real cursor hover at the top edge with click-through forwarding (`setIgnoreMouseEvents` forward), focus non-stealing in standby (`setFocusable(false)`), always-on-top over full-screen apps, multi-monitor/DPI switching, CLI launch via `cmd start damar.cmd` from the notch, Control opening in default browser, close/outro. Tests used a hidden window only and never touched other desktop windows.

## Test counts

Focused: presence-fsm 7/7, presence-projection 8/8, presence-core 4/4.
Full safe suite (`node --test --test-concurrency=1 --test-reporter=tap`, all `tests/*.test.cjs` except `computer-use.test.cjs`, 65 files): **292 tests, 288 pass, 4 fail**, 0 cancelled/skipped (`evidence/presence-r6/full-suite.tap`). All 19 presence tests pass. Failing (not presence; their sources `src/cli/ui-settings.cjs` and `src/core-host/model-grants.cjs` were modified by other agents at 20:03-20:04 during this run, untouched by this WO):
- `tests/model-grants.test.cjs:43` "invalid limits, alias, expiry, extra fields and journal damage rejected" (Missing expected exception)
- `tests/ui-settings.test.cjs:4` "appearance persistence is explicit private-session theme/banner only with original defaults"
- `tests/ui-settings.test.cjs` "UI language: Indonesian default, English persisted, legacy profiles without the key stay valid, invalid values rejected"
- `tests/ui-settings.test.cjs` "profile keeps last provider/model across appearance saves, merges selections, and rejects half or hostile entries"

`graphify update .` run in R (20 961 nodes; node_modules not indexed).
