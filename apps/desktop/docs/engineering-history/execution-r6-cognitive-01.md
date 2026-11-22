# Execution R6: cognitive integration 01 (2026-11-22)

Scope: answer whether the cognitive runtime is integrated into DAMAR, fix the cognitive weaknesses that affect real users, and add `cognitive.*` settings. The full audit is in `docs/COGNITIVE_INTEGRATION_AUDIT.md`.

## Verdict
- **`damar-cognitive-runtime` (Python V3) is MISSING from DAMAR.** No code, bridge or reference exists in C or R.
  - The local copy `C:\Workspace\damar-cognitive-runtime` and GitHub are at the same commit, `3ef400a`, with identical trees.
  - The runtime is Linux/WSL2 only; its own docs say native Windows is NOT_SUPPORTED.
  - It has **no license**, so it cannot be redistributed in a public release without the authors' written grant.
- **DAMAR's own JS cognition:**

  | Module | Status in the R product path |
  |---|---|
  | `consciousness/*` | FULLY_INTEGRATED (runs every turn and every Pandawa run) |
  | `memory/*` | Executes but is always empty (nothing in R writes to it) |
  | `cognition/*` (ACC) | PRESENT_NOT_WIRED (shadow design) |
  | Project memory and session history | FULLY_INTEGRATED |

## Fixes (host-side; the snapshot pin is unchanged except for the release scrub below)

| # | Weakness | Evidence (before) | Fix |
|---|---|---|---|
| 1 | Saving memory needed no consent under `full-access`; the saved note was injected as a system "follow them" message (persistent prompt injection) | `agent-turns.cjs:119`, `project-memory.cjs:32` (old) | Saving always asks (`cognitive.memoryConsent`); notes are wrapped in a `<project-memory>` data block and cannot close it. Live: the card appeared under full-access |
| 2 | Memory was tied to one session directory (lost on an abandoned recovery or any new directory) | `core-host.cjs:299` (old) | Profile-scoped `project-memory.jsonl`, legacy file imported once |
| 3 | History and memory replay had no size bound | `agent-turns.cjs:134` (old) | Turn and character budgets; memory ranked by relevance within a budget |
| 4 | Credentials could be stored in memory | (no filter) | `NOTE_CONTAINS_CREDENTIAL` |
| 5 | The mind's attention stage and its reading of the user leaked across sessions and workspaces | `GlobalWorkspace.js:59-69`, `consciousness/index.js:423-432` | Cleared on session change; `cognitive.mind` on/off |
| 6 | No memory retention, export or clear | — | `memoryRetentionDays`; `/api/r9/memory` actions `export` and `clear` |
| 7 | No record of what context a turn used | — | A `cognitive` event at the start of every turn |

**Release scrub (coordinator request).** Added a `scrub` phase to `scripts/build-core-snapshot.cjs`. It is idempotent and recomputes `SNAPSHOT_MANIFEST.json` `src` plus a new `scrubbed[]` list that keeps each file's canonical hash alongside its scrubbed hash.
- Files scrubbed: `cognition/attention/index.js`, `cognition/config/ACCConfig.js`, `cognition/core/envelope.js`, `cognition/goals/records.js`, `cognition/prospective/records.js`, `cognition/worldmodel/beliefAlgebra.js`. All were comment-only "OpenCode/9router deepseek-v4.1-flash" references.
- `AIProviderFactory.js` and `providerConfigService.js` had already been neutralised by the provider agent's `candidateOverlay`.
- Result: `grep 9router|ninerouter|20127|gpt-6-luna core-snapshot/src` finds 0 matches. `hashTree` matches the manifest. Core boots from the scrubbed snapshot.

## Files and lines
- New: `src/core-host/cognitive.cjs`, `tests/cognitive-layer.test.cjs`, `docs/COGNITIVE_INTEGRATION_AUDIT.md`.
- Rewritten (host memory): `src/core-host/project-memory.cjs`.
- `agent-turns.cjs`:
  - :42 stored history raised to 50 turns
  - :119 consent
  - :131-133 `contextFor` and the receipt
  - :205-206 `noteActivity` (phase 2)
- `core-settings.cjs`: :46-49, :66-67, :143-145, :178-179 (`cognitive` and `pandawa` namespaces).
- `core-host.cjs`: :292 shutdown, :299-303 profile memory and `installMind`, :329-335 team (phase 2).
- `r9-routes.cjs`:
  - :35 `team` parameter (phase 2)
  - :173-174 discussions route (phase 2)
  - :277-278 memory `clear` and `export`
- `workspace-tools.cjs:337`: `PROJECT_MEMORY_DISABLED`.
- `scripts/build-core-snapshot.cjs`: `scrub` phase.

## cognitive.* keys (for Control)
| Key | Values | Default |
|---|---|---|
| `memoryEnabled` | bool | true |
| `memoryConsent` | `always` \| `autonomy` | `always` |
| `memoryRetentionDays` | 0–3650 | 0 |
| `memoryContextChars` | 500–20000 | 6000 |
| `historyTurns` | 0–50 | 20 |
| `historyChars` | 2000–400000 | 48000 |
| `mind` | `on` \| `off` | `on` |

## Live checks (own Core on 127.0.0.1:29652)
- **Offline trace, before and after:** 587 snapshot files loaded; 18 `consciousness` files and 0 `cognition` files; both turns and the Pandawa run COMPLETED; the `cognitive` event was present.
- **Live run** through the Owner router at http://127.0.0.1:20127/v1. The key was read from 9router's sqlite and passed directly to `/connect`; it was never printed. Model `cx/gpt-6-luna`, results in `cog-live-result-mwqglxgt.json`:

  | Turn | Session / setting | Result |
  |---|---|---|
  | 1 | A, `full-access` | The `project_memory_add` card was shown and approved; COMPLETED; 12,701 input / 67 output tokens |
  | 2 | B | "The release codename is KESTREL-7, and builds target Windows x64." Memory reached a different session through project memory (1 of 1 notes, 298 chars) |
  | 3 | B | Reasoning correct: "17 — 3 × 4 = 12 builds, plus 5 hotfix builds." History replay: 2 messages |
  | export | — | 1 workspace, 1 note |

## Tests
- `tests/cognitive-layer.test.cjs`: 8/8 pass.
- Full safe suite (72 files, all `tests/*.test.cjs` except `computer-use.test.cjs`): **352 tests, 348 pass, 4 fail.** All 4 failures are outside this work: `alpr-engine.cjs:76`, "Cannot read properties of null (reading 'dir')", in the Mata Dewa agent's in-progress code:
  - `mata-dewa-cameras.test.cjs`: "Control view: registers, uses helpers.controlSession, English default, Indonesian strings, notices and key form"
  - `mata-dewa-core.test.cjs`: "routes: auth, read-only public feeds, envelope, consent gate, 405/413/404"
  - `mata-dewa-core.test.cjs`: "Owner-key feeds: Owner-only write, never read back, used only toward their own host"
  - `mata-dewa-core.test.cjs`: "feed cache persists across restart, bounded, respects interval; stale-with-last-good on failure"

## Remaining risks
- Canonical MemoryService runs empty on every turn, so two memory systems coexist.
- Snapshot cognitive prompt text is Indonesian-only; a live turn answered in Indonesian to an English request.
- `discussions.jsonl` is not in the recovery copy list (`core-host.cjs:123`).
- Two Cores sharing one profile would each load project memory separately and diverge.
- Credential detection is pattern-based, so it is finite by design.
- The Python runtime still needs a license and native Windows qualification before any adoption.
