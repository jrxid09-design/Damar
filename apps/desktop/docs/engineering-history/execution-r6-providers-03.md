# R6 providers 03 — performance + polish (2026-11-22)

Owner direction: no artificial limits; DAMAR is MIT and free. The legacy Owner-store migration was run by the lead (MIGRATED, backup created); `scripts/owner/` untouched this round.

## 1. Concurrent usage meter (`provider-budget.cjs`)
- **No global lock.** Each request reserves an upper bound (Core input bound + max output) synchronously (atomic in Node's single thread) against the shared caps (session runaway caps + the target grant's `completions`/`totalTokens`); settling replaces it with the provider-reported usage. `total + inFlight + reservation > limit` → `LIVE_INFERENCE_BUDGET_EXHAUSTED` before dispatch, so concurrent requests can never over-commit. CLI turns, Pandawa members, Mata Dewa and gateway streams now run in parallel.
- **Fail-closed per request, never global.** Lost usage (transport failure, cancelled stream, partial usage, restart with an open reservation) charges that request's reserved upper bound and marks it `uncertain` (counter + last 20 in `recentUncertain`, shown in Control). Only an unwritable ledger file (`blocked`) stops everything — nothing could be recorded.
- **Models that never report usage** (evidence from the cognitive agent): learned per provider/model (`usageReporting: reports|missing`); such responses are metered by a conservative estimate = Core input upper bound + UTF-8 byte count of the generated text (content, reasoning, tool-call name/arguments; ≥ token count) capped by max_tokens, settled `ESTIMATED`, `estimated:true` in the ledger, receipts (`r9-routes.cjs` receipt status `ESTIMATED`) and Control. Nothing is refused.
- **Root cause found live:** the Owner's router appends `data: [DONE]` to some *non-stream* JSON bodies (`{...}data: [DONE]`, e.g. `dhl/zai-org/GLM-5.3-Flash`). The canonical fetch client's `response.json()` fails → "no usage" → old meter locked. The router transport now tolerates that terminator; in Core the canonical non-stream provider calls go through it (`installCanonical(..., { transport: true })`). Live: GLM now reports usage (`usageReporting: reports`) and three parallel Pandawa runs on it completed with confirmed receipts.
- **Refusal accounting (item 4):** 400/401/403/404/413/422/429 = pre-generation → zero tokens; a 5xx whose body reports usage → recorded; any other non-2xx → uncertain for that request. Paid answers that overshoot a cap are returned (they were generated); the next reservation sees the new total.
- **Routed target grant (cognitive `routeOverride`):** Core's meter provider now resolves a Pandawa member route to its target: limits/injected allowance from the **routed target's grant**, ledger rows/receipts billed to the member's connection + model (`p.billed`). The cognitive agent's `routeOverride` lines in `provider-router.cjs` were kept (restored verbatim after my rewrite of that file — `:52-54`, `:100`).

## 2. Concurrency limits
- Per connection: `maxConcurrency` (default 8, 1–256; routing default + per-connection override via `POST /api/r9/provider-admin/limits`); extra requests **queue** (FIFO), never refused; a stream holds its slot until it ends.
- Per provider key: soft `maxPerKey` (default 8) — rotation prefers keys below it; per-key `inFlight` shown.
- Per gateway key: `limits.concurrency` (default 8, ≤ 256) → over the cap `429 concurrency_limit_reached`.
- Routing settings (`cooldownMs`, `maxCooldownMs`, `maxConcurrency`, `maxPerKey`) validated and persisted.

## 3. Gateway transport
- Upstream calls (gateway + tests, and Core's canonical non-stream calls) use `node:http/https` with separate header (`providerRequestMs`) and per-chunk inactivity (`inactivityMs`) clocks from Core's provider-deadlines; no redirects; long silent streams are not cut.
- SSE: `data: [DONE]` is appended when the upstream omits it (only after a complete stream; never doubled); usage passes through and is metered.

## 4. Injected-token allowance in Control + auto-calibration
- Connect dialog and new **Limits…** dialog: allowance and max parallel requests per connection; keys block shows both.
- Model test returns `calibration` when provider prompt tokens exceed Core's bound, with `suggestedInjectedTokens` (rounded up ×1.25 to 256); Control shows it with **Apply suggested allowance…** (Owner confirms) → `/connect {injectedTokens}`.
- Control **Usage meter** panel: in flight / reserved, total, estimated, uncertain, over-bound, models without usage reports, recent uncertain requests.

## 5–6. Snippets
- **Hermes Agent: verified live** (v0.21.2 installed here): `config.yaml` `model: { default, provider: "custom", base_url, api_key }` (format from its own `cli-config.yaml.example`), isolated `HERMES_HOME` → `hermes chat -q … --oneshot -Q` → `5`, exit 0. The Owner's `~/.hermes` untouched.
- **opencode: verified again** (isolated XDG dirs) → `5`.
- Added (format from each tool's documented OpenAI-compatible setup, not run here): Continue.dev (`config.yaml`), Cline / Roo Code (OpenAI Compatible provider fields), Aider (`--openai-api-base/--openai-api-key --model openai/<id>`), LibreChat (`librechat.yaml` custom endpoint), Open WebUI (Connections or `OPENAI_API_BASE_URL`/`OPENAI_API_KEY`; Docker note). Claude Code needs an Anthropic Messages shim — not trivial, skipped.

## Files
`provider-budget.cjs` (rewritten accounting, 215 lines), `provider-router.cjs` (node transport, concurrency queue, calibration, stream flag, tolerant JSON, `routeOverride` kept; 189), `provider-keys.cjs` (per-key inFlight, concurrency settings), `gateway.cjs` (per-key concurrency, `[DONE]`, 8 snippets), `provider-registry.cjs` (`setLimits`/`limitsOf`, per-connection `maxConcurrency`), `provider-admin-routes.cjs` (`/limits`, meter + concurrency in state), `core-host.cjs` (provider block: routed-target meter provider, router timeouts, canonical transport, admin budget), `r9-routes.cjs` (2 receipt lines: `ESTIMATED`), `control.js` (Providers view: limits/allowance, meter panel, calibration, routing concurrency, all snippets, Indonesian strings). Tests: `provider-budget.test.cjs` (rewritten to the concurrent semantics + parallel load, refusals, estimate, billed route), `provider-router.test.cjs` (+4: 20-way concurrency with cap, `[DONE]` + key concurrency, silent-stream transport + estimate, calibration; snippets), `provider-registry.test.cjs` (routing defaults).

## Live check (my Core on 29651, gateway 29653; profile from round 02; Cores stopped, my processes only)
Receipts: `execution-r6-providers-03-live-receipt-a.json` (gateway/clients), `-b.json` (Pandawa).
- 3 parallel gateway calls (2 × `my-router/cx/gpt-6-luna`, 1 × combo `damar-default`) started together: all 200 ("0", "2", "4"), wall 1964 ms ≈ the slowest single call (1422–1964 ms) → truly parallel.
- Streamed combo: 200, ends with `data: [DONE]` (upstream omits it; appended once).
- `my-router/dhl/zai-org/GLM-5.3-Flash` via gateway: usage now parsed (14 in / 16 out).
- 3 parallel Pandawa runs on GLM-5.3-Flash (canonical path): all COMPLETED ("2", "4", "6"), receipts confirmed (11,636 in / 343 out, 3 receipts). (The Pandawa *run route* still dequeues runs one at a time by design; the meter no longer serializes.)
- Hermes `5`, opencode `5`. Meter after all: 30 attempts, 146,733 tokens, inFlight 0, uncertain 0, estimated 0, **blocked false**.
- Model test calibration on gpt-6-luna: 2496 prompt tokens ≤ bound with the 8192 allowance → no suggestion (unit test covers the suggestion path).
- Leak scan of 3,705 session/profile files: 0 router-key hits; temporary client config dirs (containing a scratch gateway key) deleted.

## Tests
- Full safe suite (76 files, excl. computer-use): **397 tests — 382 pass, 14 fail, 1 skipped**. All 14 failures are `control-dashboard.test.cjs` (`CORE_EXIT_1` in its `before` hook): its fixed port 29641 was in use by another agent's concurrent run at that moment (TIME_WAIT connections from another client). Re-run alone: **14/14 pass**. No other failures (the round-02 flaky renderer test passed).
- `graphify update .` run in R.

## Remaining risks
1. Estimated usage is conservative (output bytes ≥ tokens), so budgets drain faster for models without usage reports — by design (never under-count).
2. Charging the reserved upper bound for lost usage can over-count; correct only with provider-side billing data.
3. Pandawa runs are still dequeued one at a time by the `/api/r9/pandawa/runs` route (not the meter); parallel Pandawa needs that queue changed (outside provider code).
4. Snippets for Continue, Cline/Roo, Aider, LibreChat, Open WebUI are from documented formats, not run here.
5. Gateway concurrency over the cap answers 429 (clients retry); per-connection excess queues without a wait timeout beyond the request's own deadlines.
