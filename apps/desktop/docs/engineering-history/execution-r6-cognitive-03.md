# Execution R6: cognitive 03, closing the open items (2026-11-22)

## Results
1. **One memory system.**
   - Choice: route Core's MemoryService reads to the profile project memory, rather than feed Core's SQLite store from R. This is the smaller option: one wrapper, no second store and no duplicated writes.
   - `cognitive.installMemoryBridge` (`cognitive.cjs:115`) replaces `MemoryService.buildContext`:
     - Outside a Pandawa run scope (agent turns) it returns empty, because the turn already carries project memory.
     - Inside a run scope it returns the run's workspace notes as the same fenced block.
   - The SQLite store is no longer queried on every turn.
2. **English-first prompts.**
   - `cognitive.installAssemble` (`:96`) appends a reply-language directive to every assembled prompt: reply in the language of the user's message, otherwise English (Indonesian when `cli.language='id'`).
   - Pandawa runs use the language of the Owner's task (`detectLanguage`, `:80`), because Core wraps the task in Indonesian role text.
   - Live: "capital of Australia" got "The capital of Australia is Canberra."; a Werkudara run answered in English (before the fix it answered in Indonesian).
   - **Pre-existing bug found and fixed in the same wrapper:**
     - Core's `assemble()` drops its whole system prompt (persona, safety authority, tool guidance) when the caller sends any system message.
     - So every turn in a workspace with project memory or a routed skill ran without Core's system prompt. Offline evidence: input fell from 2,967 to 400 tokens.
     - Host context is now appended to Core's system message. Input is now 3,136 tokens.
3. **Recovery, usage and the restart guard.**
   - `discussions.jsonl` is in the recovery copy list (`core-host.cjs:129`).
   - Discussion receipts are counted in `/api/r9/usage` (`r9-routes.cjs:94`), with a new `byMember` breakdown (`:101`, `:104`).
   - `activeDiscussions` is counted in the lifecycle checks (`:120`) and blocks a restart (`:208`).
4. **Per-member routing for tool-using Pandawa runs** (`pandawa_delegate` and `/api/r9/pandawa/runs`).
   - `r9-routes.cjs:67-71`: each run executes inside `cognitive.runScope` with `{ route: team.routeFor(worker), root, lang }`.
   - `provider-router.cjs:23-25,56`: a `routeOverride()` option. When it returns a route, the canonical request's targets come from `registry.targets(member connection, model)` and are still checked against the Owner's grants (empty means `LIVE_INFERENCE_NOT_AUTHORIZED`, failing closed).
   - Run receipts name the member's connection and model (`r9-routes.cjs:77`).
   - Live: Werkudara ran on `cx/gpt-6.1-sol` while `cx/gpt-6-luna` was selected; COMPLETED; usage `byProvider owner-router/cx/gpt-6.1-sol`.
5. **Timeout and router.**
   - `pandawa.discussion.callTimeoutSec` (30–1800, default 300).
   - Live discussion members now call `router.dispatch()` (`pandawa-team.cjs:85`): key rotation, failover and combos, with receipts in the shared usage ledger. Offline fixtures keep the direct call.
   - Live 2-round discussion (Puntadewa on `cx/gpt-6-luna`, Werkudara on `cx/gpt-6.1-sol`): both rounds complete, every member replied, CONSENSUS is genuine this time, and the synthesis states "no member reply failed".
6. **`docs/COGNITIVE_RUNTIME_ADOPTION.md`** written: what adoption needs (an MIT-compatible written license, native Windows support, integration authority, a provider binding through the router) and what DAMAR already took over conceptually.

## New and changed settings (for Control)
| Key | Values | Default |
|---|---|---|
| `pandawa.discussion.callTimeoutSec` | 30–1800 | 300 |

`/api/r9/usage` gained `byMember`. The `cognitive.*` keys are unchanged.

## Provider-layer finding (for the provider agent)
- The usage meter is fail-closed: one successful response with no `usage` sets `blocked` and stops **all** live inference for the life of the Core (`provider-budget.cjs:100-107`, `:69`).
- Through the Owner's router, `dhl/deepseek-ai/DeepSeek-V4-Flash-0731` and `dhl/zai-org/GLM-5.3-Flash` (and `lucif/lucif-flash`) return non-stream replies as `text/event-stream` with no usage. A single Pandawa run assigned to such a model therefore blocked the meter, and every later call failed with `PROVIDER_USAGE_METER_UNAVAILABLE`.
- Suggestion: per-target refusal plus a model capability flag ("reports usage"), instead of a global block.
- My live checks used `cx/gpt-6.1-sol` as the second model, which reports usage.

## Tests
- `tests/cognitive-layer.test.cjs`: 12 tests.
- `tests/cognitive-pandawa-team.test.cjs`: 7 tests.
- Together these 19 cover the assemble wrapper (Core prompt kept, directive), the memory bridge, router route override and fail-closed, language detection, `callTimeoutSec`, `routeFor`/`receiptsFor`, and live dispatch through `router.dispatch`.
- **Full safe suite** (75 files, everything except `computer-use.test.cjs`): **386 tests, 385 pass, 0 fail, 1 skipped.** The skip is the ALPR real-engine test, which only runs when the engine is installed.
- `graphify update .` in R ran successfully.

## Files and lines (this round)
| File | Lines | Change |
|---|---|---|
| `cognitive.cjs` | :73-128 | `runScope`, `detectLanguage`, `languageDirective`, `installAssemble`, `installMemoryBridge` |
| `pandawa-team.cjs` | :20-22, :50, :81-95, :162-166 | Settings, dispatch through the router, `routeFor`, `receiptsFor` |
| `core-host.cjs` | :129 | Recovery copy list |
| `core-host.cjs` | :280 | `routeOverride` |
| `core-host.cjs` | :317-318 | Install the assemble and memory wrappers |
| `core-host.cjs` | :349 | Team gets the router |
| `r9-routes.cjs` | :67-71, :77, :94, :101, :104, :120, :208 | Run scope, receipt attribution, usage, restart guard |
| `provider-router.cjs` | :23-25, :56 | `routeOverride` (minimal) |

Docs: `COGNITIVE_INTEGRATION_AUDIT.md` updated; `COGNITIVE_RUNTIME_ADOPTION.md` new.

## Remaining risks
- Tool-using Pandawa runs that use a member route are reserved in the meter against the *selected* model's grant limits. The call is routed and receipted under the member's model.
- Language detection covers English and Indonesian only. For other languages the directive relies on the model following the user's language.
- Core's Indonesian prompt text itself is unchanged in the snapshot; the directive overrides the reply language, not the prompt.
- Two Cores sharing one profile would each load project memory separately and diverge.
- Credential detection is pattern-based, so it cannot catch every secret.

## Addendum: release rescan, personal paths in the pinned snapshot
The `scrub` phase in `scripts/build-core-snapshot.cjs` was extended. It is idempotent (running it twice gives the same aggregate `0d8f34d6…`) and recomputes the pin; `hashTree(core-snapshot/src)` matches the manifest. `manifest.scrubbed[]` records each changed file's canonical and scrubbed hashes.

**Rules added**
| Hit | Replaced with |
|---|---|
| Mata Dewa User-Agent `damar-mata-dewa/1.0 (+https://github.com/jrxid09-design/Aether)` | `DAMAR/1.0` |
| `jrxid09-design/Aether` repository URLs | `https://github.com/REPLACE-ME/damar` |
| `C:\Workspace\Damar-audit-evidence\…` comment paths | "the internal audit evidence (not shipped)" |
| `C:\Workspace\Aether` and `/mnt/c/Workspace/Aether` examples | `C:\Projects\Example` and `/mnt/c/Projects/Example` |
| `C:\Users\...` and `C:/Users/...` in a comment | `C:\Data\...` and `C:/Data/...` |
| Manifest `canonicalSource.root` (`C:/Workspace/Damar`) | `canonical-damar` (the `src` phase now writes this too) |

- `core-snapshot/package.json` is not part of the pin. Its repository URLs become the placeholder, or `DAMAR_REPO_URL` (`https://github.com/<owner>/<repo>`) when that is set at scrub or build time.
- Newly scrubbed files: `ai/executors/RuntimeExecutor.js`, `cognition/simulation/index.js`, `cognition/spatial/index.js`, `integration/canonicalRuntimeComposition.js`, `mataDewa/providers/http.js`, `services/opencodeTools.js`. The total scrubbed list is 12 files; `package.json` and the manifest root were also changed.
- Legacy "Aether" identifiers (compatibility aliases, migration code and the self-model's former name) are functional and were left alone; the scanner does not flag them.

**Rescan.** The `privateRouter`, `personalPath` and `publishPlaceholder` patterns from `scripts/release/build-release.cjs` were run over `core-snapshot/src`, `package.json` and the manifest. Result: **0 personal-path hits and 0 private-router hits.** The 3 remaining hits are the intended `publishPlaceholder` URLs in `package.json`.

**Core boot.** My own Core on 29652 booted from the scrubbed snapshot (offline fixtures): 587 files loaded, the turn and the Pandawa run both COMPLETED.

**Tests**
- `cognitive-pandawa-team.test.cjs` already expected `callTimeoutSec: 300` (fixed in round 3): 7/7 pass.
- Full safe suite (75 files): 397 tests, 393 pass, 3 fail, 1 skipped (ALPR).
- The 3 failures are in `workspace-writer.test.cjs` ("traversal, absolute, device and protected paths are refused", "a junction anywhere in the path, or a linked target, is refused", "race: a directory swapped for a junction during writes never lets a file land outside"), all `WRITER_NO_RESULT`. Another agent changed `workspace-writer.cjs` and its test (03:21 and 03:25) while the suite ran. Rerun on its own, it passes 9/9.
- `graphify update .` ran.
