# Execution R6: cognitive 02, Pandawa per-member models and DAMAR-led discussions (2026-11-22)

## What exists now
New file `src/core-host/pandawa-team.cjs` (host-side; no snapshot change).

**Per-member models.** Settings key `pandawa.models.<member>` for `damar`, `puntadewa`, `werkudara`, `janaka`, `nakula` and `sadewa`.
- Value: `'<connectionId>/<model>'` or `null`.
- Resolution order: the member's assignment, then DAMAR's assignment, then the active selection.
- Dispatch goes through the provider registry's new `target(id, model)` hook. A live connection is executable only while the Owner has a model grant for that id, base URL and model; offline fixtures always work. The key stays inside Core.

**Modes**
- `debate`: in round 1 every member proposes. In rounds 2 to N each member critiques the others and revises. The discussion stops early on budget (`TOKEN_BUDGET_REACHED`) or when every member's reply begins with AGREE (`CONSENSUS`). DAMAR then writes a synthesis under **Decision / Rationale / Dissent**, and members that failed are reported in it.
- `delegate`: up to 5 subtasks run in parallel, then DAMAR merges the results.
- Bounds: `pandawa.discussion.maxRounds` (1–10, default 3), `pandawa.discussion.tokenBudget` (1000–2,000,000, default 60000), 2 discussions running at once, 1 per CLI session, a 180-second limit per call, replies capped at 4000 characters.

**Roles and authority.** Each member keeps its canonical mandate from the snapshot's `pandawaIdentity.roleProfile`. Members get **no tools** (fixture ledgers show `tools=0`). A discussion only proposes; real actions still go through agent turns and the Owner's permission cards.

**Cognitive layer**
- Shared team memory is the workspace's project memory, as a fenced `<project-memory>` block.
- Each member has its own memory: its last 3 positions from earlier discussions in the same CLI session, fenced as `<member-memory>`.
- Other members' messages and the Owner's interjections are fenced as data. A message cannot close its own fence.

**Thread and receipts.** The thread is append-only in `<core session>/discussions.jsonl`. After a restart an unfinished discussion becomes `OUTCOME_UNKNOWN` and is never replayed. Receipts are kept per member: connection, model, calls, input and output tokens, using the provider's reported numbers or an `estimated` flag.

**Activity.** Rows of kind `discussion` (`discussionId`, `round`, `of`, `state`, never text) go to `/api/r9/activity` through `turns.noteActivity`, which feeds the notch.

## Routes (`r9-routes.cjs:173-174` delegates to `team.handle`)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/r9/pandawa/discussions` | Owner + CLI lease | Body: `cliSession`, `client`, `topic`, plus optional `mode` (`debate`/`delegate`), `members[]`, `rounds`, `tasks[{worker,task}]`. Returns 202 with the view |
| GET | `/api/r9/pandawa/discussions?cliSession=` | Owner or requester | List, members and current `pandawa` settings. Requester views have no topic or text |
| GET | `.../{disc_id}` | Owner or requester | Detail with events and receipts. Requester view is redacted |
| GET | `.../{disc_id}/events?from=N` | Owner or requester | SSE. Event types: `started`, `round`, `message`, `owner`, `member_error`, `receipt`, `synthesis`, `cancel_requested`, `final` |
| POST | `.../{disc_id}/interject` | Owner + lease | Body `{text}` |
| POST | `.../{disc_id}/cancel` | Owner + lease | |

## Settings keys for Control
- `pandawa.models.{damar,puntadewa,werkudara,janaka,nakula,sadewa}`: `'<connectionId>/<model>'` or `null`.
- `pandawa.discussion.maxRounds`: 1–10.
- `pandawa.discussion.tokenBudget`: 1000–2,000,000.

Write them with `POST /api/r9/settings {action:'update', values:{pandawa:{…}}}`; read them from the settings `read` action (`view().pandawa`) or from the discussions list. The aliases Janaka/Arjuna resolve to the canonical `janaka`.

## Shared-file edits (minimal, additive)
- `provider-registry.cjs:108-111`: `target()` hook. This is the provider agent's file; please keep the hook through the combos/gateway work.
- `r9-routes.cjs:35` and `:173-174`.
- `core-host.cjs:292` and `:329-335`.
- `core-settings.cjs:48-49`, `:67`, `:143-145`, `:178`.
- `agent-turns.cjs:205-206` (`noteActivity`).

## Not done (owners)
- **CLI live view** (`src/cli`, Control agent): render the SSE events, add interject and stop, and show member to model in `/subagent`. The data is ready in the list and detail `models` and `receipts`.
- **Control views**: past discussions and per-member model and usage. Data comes from the GET routes above.
- **Session usage totals**: discussion receipts are not yet added into `/api/r9/usage` (they are kept per discussion). Adding them is one join in `usageFor`.
- **Model routing for tool-bearing delegation**: `pandawa_delegate` and `/api/r9/pandawa/runs` still use Core `agentHub` with the active model. Per-member routing there needs a snapshot change or a provider gateway route; I recommend the provider agent's `/v1` gateway.
- **Lifecycle**: the restart guard does not yet count running discussions. Cancel-on-shutdown is wired.

## Tests
`tests/cognitive-pandawa-team.test.cjs`, run against 2 real offline fixture servers through the real registry: **6/6 pass**. They cover:
- per-member routing (Werkudara on fixture B, the others on A) and receipts per member
- distinct replies per member
- the 2-round bound and the rounds-above-max refusal
- DAMAR synthesis
- parallel delegation and merge
- the token budget stop
- an Owner interjection fenced into round 2 (an injected `</owner-message>` is neutralised)
- cancel, and one discussion per session
- an unauthorized member model failing only that member
- requester redaction
- restart to `OUTCOME_UNKNOWN`
- settings validation

The full safe suite result is in execution-01.

## Live check (own Core on 29652, Owner router; `cog-live-result-mwqqjs14.json`)
- Puntadewa and DAMAR ran on `cx/gpt-6-luna`; Werkudara ran on `dhl/deepseek-ai/DeepSeek-V4-Flash-0731`.
- 2-round debate on "default long-term memory vs opt-in for public v1". Final status COMPLETED.
- Synthesis: "Decision: off by default, explicit opt-in, clear review/edit/delete controls".
- Receipts: Puntadewa 2 calls, 988 in / 378 out; Werkudara 1 call, 2384 in / 437 out; DAMAR 1 call, 890 in / 118 out. All provider-reported.
- Activity showed rounds 1/2 and 2/2, then COMPLETED. The requester view was fully redacted.
- **Defect found and fixed:** in round 2, Werkudara's DeepSeek call hit the 180-second timeout. The error was logged without the member's name, and the discussion was wrongly reported as `CONSENSUS`. After the fix, errors carry the member, consensus requires replies from every member, and the synthesis is told which members failed. The fix was re-tested offline but **not re-run live**.
