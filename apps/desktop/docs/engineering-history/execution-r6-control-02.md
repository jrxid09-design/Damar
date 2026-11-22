# R6 Control-02 checkpoint (2026-11-21)

Scope: CLI settings stored once, in Core (`cli.*`), and used by both the CLI Settings screen and Control; Control's CLI section can now edit them; a view-registration hook for separately shipped views; removal of client-side restrictions under the Owner policy (model grants: `*`, up to 365 days, limits optional).

## Core (exact lines, current file state)
- `src/core-host/core-settings.cjs`
  - 33-42: `cli` namespace. Theme list comes from `src/cli/appearance.cjs`. `CLI_DEFAULTS` = theme damar-ember, animateBanner true, language id, hudPosition left. `CLI_RULES`: theme in themes or legacy themes; animateBanner boolean; language id|en; hudPosition left|right|bottom|hidden. `validSelection` checks provider/model with the same regexes as the session ledger.
  - DEFAULTS: `cli: null` (unset until the first write or import), `lastSelection: null`.
  - 59: on load, keeps only `cli` keys that pass validation, and only a valid `lastSelection`.
  - `view()` includes `cli` and `lastSelection`. 137: `cli()` returns `{cli, defaults, lastSelection, revision, updatedAt}`. 139: `recordSelection(provider, model)` is called only by the provider route; it saves only when the pair changes.
  - 163-167: `update()` validates `values.cli`; an unknown key or a bad value returns 400 `CLI_SETTINGS_INVALID`. `lastSelection` cannot be written through settings.
  - 200: exports `CLI_DEFAULTS`.
- `src/core-host/r9-routes.cjs`
  - 215-218: NEW `GET /api/r9/cli/settings` (owner or requester, no query; any non-GET returns 405).
  - 322: after `POST /api/r9/provider` succeeds, `settings.recordSelection(selected.id, selected.model)`, wrapped in try/catch so it never blocks the selection.
  - Writes: Owner only, through the existing `POST /api/r9/settings {action:'update', cliSession, client, values:{cli}}` with an attached session lease.

## CLI
- `src/cli/ui-settings.cjs` (rewritten, same class name):
  - Appearance is read and written through a Core adapter `{read, write, canWrite}`.
  - Only `core_session` is stored locally.
  - `sync()` reads Core. If Core's `cli` is null, a legacy local profile exists and a session is attached, it imports the legacy values once and then rewrites the file as `{schema:1, core_session}`. A legacy provider/model pair is offered once so startup can restore it through `/api/r9/provider`.
  - When Core is offline: `offline=true`, the last-known values are kept, and `save()` rejects with `CORE_SETTINGS_OFFLINE_READ_ONLY`. Nothing is written locally.
  - Provider/model are never stored by this module.
- `src/cli/main.cjs`:
  - 98-109: `cliCore` adapter (GET `/api/r9/cli/settings`; Owner `/api/r9/settings` values.cli with the attached history session) and `syncCliSettings`, which applies the Core values to the TUI.
  - `persistAppearance` reports when Core is read-only.
  - 116: Settings Center `core()` syncs first, so changes made in Control appear when Settings opens.
  - 123: `persist` is now async.
  - 146: after the session is ready, startup syncs and then restores Core's `lastSelection` through the existing select path.
- `src/cli/settings-center.cjs`: the 3 persist calls are now awaited, so a failed Save is reported and never shown as success. Line 129 uses `modelAuthorized`.

## Control
- `src/control/control.js`:
  - New Core read `cliSettings`.
  - The Settings > Damar CLI panel is editable (theme, banner, language, HUD dock) and shows the last provider/model, through the same `/settings values.cli` path.
  - Model-grant form: provider select (ninerouter or custom-loopback), model defaults to `*`, expiry in days (default 30, maximum 365), limits optional (blank = none, any subset). Helper `grantRequest`.
  - Hook `window.DamarControl.registerView(id, {label, group, icon, render(helpers)})`. It replaces a placeholder (e.g. `matadewa`) or adds a nav item.
- `src/control/serve.cjs`: serves `/control/views/<name>.js` (plain files in `src/control/views/` only) and adds `<script src="views/<name>.js">` tags, in sorted order, after `control.js` in `index.html`.

## Client-side restrictions removed
1. `src/cli/subagents.cjs:169` and `src/cli/settings-center.cjs:129`: removed the hardcoded fallback `['9router/cx/gpt-6-luna']`. The new `modelAuthorized` helper (`subagents.cjs:13`) accepts `*`, the granted id (with or without the `9router/` prefix), or no list at all (then Core decides).
2. `subagents.cjs` HINTS `LIVE_INFERENCE_NOT_AUTHORIZED`, the provider label, and the connect picker help no longer say "not authorized in this build" or "never run inference in this build". They now point to Control > Providers > Grant.
3. `settings-center.cjs` provider option, `main.cjs` restore notice, and `discovery.cjs` `/connect` entry: "configure only" is now "needs a model grant".
4. `src/cli/agent-turn.cjs`: `/permission` used to say only `ask` was available. It now reads the profile from Core and sets ask, workspace, full or read through Core settings, after an Owner confirmation card.
5. `src/cli/agent-turn.cjs`: `/add-dir` was refused as "not available". It now lists and adds extra folders through Core settings `extraDirs`, after an Owner confirmation card; Core validates the path and its protected-roots check still applies. `discovery.cjs` entries were updated.

Kept on purpose (real protections or real gaps): the loopback-only URL for `custom-loopback` (Core rule), the fixed `ninerouter` gateway, `/commit` (Core has no git authority), `/compact` (Core trims context itself).

## Tests
- `tests/ui-settings.test.cjs`: 3 tests rewritten for the Core-backed contract (a fake Core built on the real `core-settings.cjs`): shared values, changes made in Control reach the CLI, offline is read-only with no local write, one-time migration, a stale local profile never overrides Core, Core-remembered selection, hostile files refused.
- `tests/settings-provider-payload.test.cjs`: `*` grant allows any model; `modelAuthorized` cases.
- `tests/subagents.test.cjs:81`: hint text updated.
- `tests/control-dashboard.test.cjs`: +3 tests (CLI settings route and lastSelection, grant form, view registration and injection); 11/11 pass.
- Full safe suite (65 files, computer-use excluded, concurrency 1, tap): **295/295 pass, 0 fail**.
- No paid inference: tests use the offline fixture Core on 29641 only.

## Remaining risks
- A running CLI picks up changes made in Control only when its Settings opens, at startup, or on reload; there is no push and no polling.
- The non-interactive `damar sessions` output language now defaults to Indonesian once the local profile has been migrated, because that path does not read Core.
- `cli.theme` validation in Core depends on `src/cli/appearance.cjs`, a Core-to-CLI data dependency.
- The Settings Center Save status text still says "Saved to the profile", unchanged because the ConPTY probes match on it; the values are actually saved to Core.
- The live ConPTY probes (`conpty-model-persistence.cjs`, `conpty-hud-journeys.cjs`, `profile-native-restart.cjs`) read `cli-ui-settings.json` for appearance and provider/model. They are not in the safe suite, were not run, and need updating to read `GET /api/r9/cli/settings`.
