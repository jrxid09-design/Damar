# R6 Control-04 checkpoint (2026-11-22): CLI and Control UI for the Core features other agents built

The Owner decided: DAMAR is MIT open source, v1 is free, and support runs through GitHub Issues and Discussions.

## 1. Presence display name
- Control > Settings > Idle Presence & Notch has a new field, "Your name (greeting, optional)" (`control.js:795`, maximum 40 characters). It is saved as `presence.displayName`, which Core validates (`core-settings.cjs:20,30`).
- `tests/control-dashboard.test.cjs`: the presence defaults now include `displayName: ''`.

## 2. Memory & Context (`cognitive.*`)
- Control > Settings > Memory & Context (`control.js:807`) has these fields:
  - memoryEnabled (on/off)
  - memoryConsent (always/autonomy)
  - memoryRetentionDays (0-3650; 0 = keep forever)
  - memoryContextChars (500-20000)
  - historyTurns (0-50)
  - historyChars (2000-400000)
  - mind (on/off)
- Saving sends `/api/r9/settings` values.cognitive, confirmed by the Owner. Core checks every key (`COGNITIVE_SETTINGS_INVALID`).
- "Export memory…" (`'data-memory-export'`) calls `/api/r9/memory` action `export` and downloads `damar-memory-export.json` on this PC.
- "Clear workspace memory…" (`'data-memory-clear'`) calls action `clear` for the workspace folder set in Memory & Continuity. The dialog warns that it cannot be undone.

## 3. Pandawa team and discussions
- Settings > Pandawa Team (`control.js:820`):
  - One model picker per member (damar, puntadewa, werkudara, janaka, nakula, sadewa).
  - The options are `<connectionId>/<model>`, built (`modelRefs`, `:834`) from `GET /api/r9/provider` connections and the models each one reports. A saved value missing from that list is kept and shown.
  - Empty means DAMAR's model, or the active provider for DAMAR itself.
  - Also: discussion maxRounds (1-10) and tokenBudget (1000-2000000).
  - Saving sends values.pandawa (Core error: `PANDAWA_SETTINGS_INVALID`).
  - Combos appear once the provider agent exposes them as connections. They have no separate code path here.
- New Discussions view (nav: DAMAR Intelligence > Discussions; `renderDiscussionsView`, `:641`):
  - A list from `GET /api/r9/pandawa/discussions`, refreshed every 5 s.
  - A detail pane (`openDiscussion`, `:663`) streams live from `/events?from=N`. The stream uses a new fetch-based SSE reader on the Core client (`createCore().stream`, `:79`) because EventSource cannot send the Owner bearer header; events are redacted before display.
  - The detail shows: mode, state, round n/N, member → model (marking "(active)" fallbacks), per-member usage (calls and in/out tokens, `~` = estimated), and a transcript (rounds, member messages, Owner interjections, member errors, DAMAR's synthesis, final status and tokens).
  - "+ New discussion" starts a debate or delegation (one "member: task" per line) from the Control session.
  - Interject and Stop are offered only for discussions this Control session started. Core requires the discussion's own CLI session lease; CLI-started discussions say so instead.
- CLI (`src/cli/discussion.cjs`, new), wired into `main.cjs:186-205`:
  - `/discuss <topic>` runs a debate.
  - `/delegate janaka: task; sadewa: task` splits parallel subtasks.
  - `/team` (or `/discuss` with no topic) lists member → model from Core.
  - Discussions render live: a header with member → model, "Round n/N", `[member · round r/N] …`, and the DAMAR synthesis (Decision / Rationale / Dissent).
  - While a discussion runs, any typed line is sent as an Owner interjection. Esc asks Core to stop the discussion.
  - All text has English and Indonesian versions (`cli.language`). The `discovery.cjs` palette has entries for `/discuss`, `/delegate` and `/team`.
- `src/cli/service.cjs`: `streamOnce` takes an optional route. New `discussionEvents(id, …)` (`:148`) resumes from the next event and, as a last resort, reads the discussion's durable record.

## 4. Support links
- `src/control/support-links.js` is the only place the public repository is set: `https://github.com/<org>/damar` (TODO(publish)).
- Control loads it as `/control/support-links.js` (allowlisted in `serve.cjs`). It is used by the Settings > Help & Support panel (`helpPanel`, `:839`) and two command-palette entries.
- CLI `help` returns `support: { issues, discussions, license: 'MIT' }` from the same file and lists discuss/delegate in its quick start.

## Tests
- `tests/control-dashboard.test.cjs`: 14/14. The new round-4 test, against the live fixture Core on 29641:
  - Team and cognitive settings: valid writes and rejected invalid ones.
  - Pickers populated from providers and models.
  - A real offline-fixture debate followed over the Control SSE reader to its final event.
  - Discussions view rendering, memory add/export/clear, and requester refused with 403.
- New `tests/cli-discussion.test.cjs`: 4/4 (parsing, live rendering, interjection, Esc → cancel, /team, help support links).
- Full safe suite: see the Results section below.
- No paid inference (offline fixture only).

## Results
- Full safe suite (75 files, computer-use excluded, concurrency 1, tap): **385 tests, 384 pass, 0 fail, 1 skipped**. The skipped test is `real fast-alpr engine` (Mata Dewa): it runs only when the ALPR engine and models are installed on this PC.
- `graphify update .` was run.

## Follow-up (2026-11-22): English-first start, defaults test, call timeout, usage by member
- **Root cause of the Indonesian start.** `src/cli/service.cjs` `r9()` keeps a list of the routes the CLI may call. It never included `GET /api/r9/cli/settings` or the `/api/r9/pandawa/discussions` routes, so the CLI refused those calls before sending them.
  - Every CLI Core-settings read failed and the CLI stayed "offline". The one-time import never ran, so an old local profile kept showing its language.
  - Old CLI builds wrote `language:'id'` into every profile, because it was the default, not a choice. With the import never running, a machine with an old profile kept starting in Indonesian.
  - Live `/discuss` and `/team` were refused for the same reason.
- **Fixes:**
  - `service.cjs`: the routes above are now on the list: the two GETs, the discussion detail, POST start, and POST `/interject` and `/cancel` (Owner role only, same checks as before).
  - `ui-settings.cjs`: a legacy `language:'id'` is not imported into Core and not shown before the first Core read, so a fresh or upgraded DAMAR starts in English. The Owner can still pick Indonesian in Settings, CLI or Control. Side effect: an upgraded user who really had chosen Indonesian gets English once and has to pick it again.
- **Checked like the release smoke (ConPTY, real `w5-main.cjs`):**
  - Fresh profile, no Core: English.
  - Fresh profile with an isolated fixture Core on 29641: English.
  - Legacy profile `{language:'id', theme:'emerald'}` with Core: English. Core `cli` became `{theme:'emerald', language:'en', ...}` and the profile was reduced to `{schema:1, core_session}`.
  - Live `/team` and `/discuss` on the fixture Core: rounds, member replies and the synthesis appeared, and it ended `Discussion ended: COMPLETED`.
  - The probes were scratch scripts (`lang-probe.cjs`, `discuss-probe.cjs` in the session scratchpad), not repository tests.
- **`tests/control-dashboard.test.cjs`:** the presence defaults check now compares against `PRESENCE_DEFAULTS()` exported by `core-settings.cjs`, plus four pinned documented values. The CLI defaults check uses `CLI_DEFAULTS()` and asserts English. New presence keys no longer break the test.
- **Control:**
  - Settings > Pandawa Team has a new field, "Time limit per member reply (seconds, 30-1800)", saved as `pandawa.discussion.callTimeoutSec` (default 300).
  - The Usage view has a new panel, "Usage by Pandawa member", summing `byMember` from the loaded session usage receipts.
  - Both have English and Indonesian text.
- **Tests added:**
  - `cli-discussion.test.cjs`: service route allowlist regression (5/5 in the file).
  - `ui-settings.test.cjs`: legacy `id` language is not imported.
  - `control-dashboard.test.cjs`: `pdTimeout` field and the byMember panel.
- **Full safe suite (75 files): 399 tests, 398 pass, 0 fail, 1 skipped** (the Mata Dewa ALPR engine test, which needs the engine installed). `graphify update .` was run.
