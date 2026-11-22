# R6 Control-03 checkpoint (2026-11-21): public international release polish

## 1. Presence voice opt-in
- Control: Settings > Idle Presence & Notch has a new "Microphone / voice (opt-in)" control (`src/control/control.js:555`). It defaults to off and is saved as `voiceEnabled` in the presence save payload (`:755`). The section now shows the live `GET /api/r9/presence/settings` values (refreshed every 5 s).
- `tests/control-dashboard.test.cjs`: the presence defaults now include `voiceEnabled: false`.
- I did not touch the presence agent's `/api/r9/activity` route or its notch permission changes.

## 2. English default, Indonesian as the alternative (one key: `cli.language`)
- Core: `CLI_DEFAULTS.language = 'en'` (`src/core-host/core-settings.cjs:35`). The same key sets the language for both the CLI and Control.
- CLI: the language now falls back to English everywhere it is normalized:
  - `main.cjs`, `settings-center.cjs` (t() and the draft), `w5-input.cjs`, `appearance.cjs`
  - `discovery.cjs` (palette default)
  - `ui-settings.cjs` (DEFAULTS)
  - `w5-renderer.py:111-112` (English unless `language == "id"`)
  - All CLI strings already had both languages through tr()/t().
- Control: an `L()` lookup (`control.js:83+`) with an Indonesian dictionary covering navigation, page and panel titles, table headers, labels, buttons, badges, dialogs, onboarding and the static `index.html` text (`data-i18n`).
  - The language follows `cli.language` from `GET /api/r9/cli/settings` on every refresh, and `<html lang>` is updated to match.
  - Data values and dynamically composed sentences stay in English.

## 3. Live sync
- CLI: while idle (no Settings open, no Owner prompt) it checks `GET /api/r9/cli/settings` every 4 s. When the revision changes it runs `syncCliSettings()`, so changes made in Control show up without reopening Settings (`main.cjs:149`).
- Control: the 5 s refresh reads `cliSettings` and `presence` and re-reads the session-bound settings while the Control session is held. An unsaved form (`formDirty`), a typing field or an open dialog is never overwritten.

## 4. Risks fixed
- `damar sessions` (non-interactive) takes its language from Core `cli.language` when Core is reachable (`main.cjs:81-86`). The local profile and the English default are fallbacks.
- The Save message is now "Saved to DAMAR Core and applied." / "Disimpan ke DAMAR Core dan diterapkan." The appearance notice says "saved to DAMAR Core".
- Probes updated:
  - `tests/conpty-model-persistence.cjs`: selection and appearance read from `GET /api/r9/cli/settings`, using a shared scratch `DAMAR_CORE_SETTINGS_FILE` across S1/S2. Hint and save regexes updated.
  - `tests/conpty-hud-journeys.cjs`: the theme check reads Core `cli`.
  - `tests/profile-native-restart.cjs`: now checks that with no Core no local appearance copy is written.
  - `tests/visible-*-probe.py`: expectations updated.
- **None of these probes were run.** They bind or contact 127.0.0.1:29623 (the Owner's Core port) and open real ConPTY sessions.

## 5. Control polish
- **First-run onboarding** on the Overview page (`control.js:309`). Three steps, each worked out from Core state:
  1. Connect a provider.
  2. Allow models (grant `*`).
  3. Start the CLI (`damar.cmd`).
  - Completed steps are marked Done, and the whole panel disappears once all three are done. "Hide" is remembered in the browser.
  - The provider steps call `DamarControl.onboarding.connect/grant(helpers)`; the provider agent has registered those at `control.js:657`. Without them the buttons open the Providers view. No router, host or model is hardcoded.
- **Plain-language errors**: `describeFailure` maps Core error codes to English or Indonesian text with the fix (`ERRORS`, `control.js:119`), falls back by HTTP status, and always shows the raw code in parentheses.
- **Accessibility**:
  - `aria-current="page"` on the active nav item and `aria-label="Views"` on the nav.
  - Decorative SVGs and status dots are `aria-hidden`.
  - Table headers use `scope="col"`.
  - The skip link, `<html lang>` and the palette placeholder are localized.
  - The CC2-M2 tokens are unchanged, so the M2 contrast audit still applies.
- Evidence screenshot: `evidence/control-r6/r3-overview-onboarding-1440.png`.

## Scope change honoured
After the 9router directive I added no code that names 9router, ninerouter, port 20127 or gpt-6-luna. `src/control/*` contains none of these strings. Provider, Models and Grant views and `provider-endpoint`/`subagents`/provider parts of `settings-center` are left to the provider agent. My round-2 Grant form and `modelAuthorized` edits are now theirs.

## Tests
- New or updated:
  - `control-dashboard.test.cjs`: 12/12, including a new "public-release polish" test (plain errors, Indonesian, onboarding shell with no private router, voice opt-in, `th scope`).
  - `ui-settings.test.cjs`: English defaults.
  - `visual-design.test.cjs`: the helper passes `language:'id'` for the Indonesian journeys, plus a new test that the default is English.
  - `w5-renderer-lifecycle.test.cjs`: the harness sets `language='id'` for its Indonesian journeys.
- The failures the coordinator listed are fixed: control-dashboard :128/:163, ui-settings :14, visual-design :37/:66/:97/:115, w5-renderer-lifecycle :77/:207.
- Full safe suite (67 files, computer-use excluded, concurrency 1, tap): **307 tests, 295 pass, 12 fail**. All 12 are in tests for code being edited by other agents at the same time (those source files changed at 20:21-20:30 during this run):
  - Lead (`model-grants.cjs`): `model-grants.test.cjs` #134, #138, #139, #140.
  - Presence agent (`src/presence/*`): `presence-core.test.cjs:82` #151 (`'Core undefined · idle'`), `presence-fsm.test.cjs:8` #152, `presence-projection.test.cjs:101` #166.
  - Provider agent (`provider-registry`, `provider-endpoint`, `subagents`, provider parts of `settings-center`):
    - `provider-registry.test.cjs` #190, #191 (`PROVIDER_URL_REQUIRED`)
    - `settings-center.test.cjs:110` #211
    - `settings-provider-payload.test.cjs:6` #229 and `:26` #230
- I did not change their source files this round.
- `graphify update .` was run.

## Follow-up (2026-11-22): CLI handles permissions answered on Damar Notch
- `src/cli/agent-turn.cjs`:
  - The permission card is no longer awaited inside the turn's event loop; open cards are tracked by permissionId. Because events are delivered one at a time and awaited, an awaited card would have blocked `permission_answer` from ever arriving.
  - When a `permission_answer` arrives for an open card, the card closes (`rl.dismissPermission`) and a one-line note appears, e.g. "Answered from Damar Notch: Allowed once" / "Dijawab dari Damar Notch: Diizinkan sekali", in the `cli.language` language.
  - The `permission_answer` that echoes the CLI's own answer is ignored.
  - If the CLI's answer gets 409 `PERMISSION_NOT_PENDING`, it shows "Already answered elsewhere: <target>" with no error code.
  - When the turn ends, any card still open is closed.
  - The CLI's own notice is added before its POST, so the transcript order is unchanged.
- `src/cli/w5-input.cjs`: new `dismissPermission()` closes an open agent card and resolves it as `'external'`.
- New `tests/cli-notch-permission.test.cjs` (3 tests, using the same awaited, in-order event contract as `ServiceClient.turnEvents`):
  - A notch answer closes the card with no second POST (English and Indonesian notes).
  - A 409 from Core is reported as answered elsewhere.
  - The CLI's own answer posts once and ignores the echo.
- Full safe suite (70 files): **342/343 pass**. The one failure was `presence-core.test.cjs:119` (presence agent's Electron timing test, "orb does not return after morph"). It passed 5/5 when the file was rerun alone, so it looks like a timing flake, not a regression. `graphify update .` was run.
