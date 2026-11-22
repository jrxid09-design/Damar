# R6 providers 01: provider-agnostic DAMAR (2026-11-21)

Owner requirement: "people should be free to use any router/provider". No vendor or router is built in or default.

## Design as built
- **Connections.** A connection is `{id (slug ^[a-z0-9][a-z0-9-]{0,31}$), label, baseUrl, kind:'openai-compatible', injectedTokens}` plus an optional key. There can be up to 32. Owner actions: add, rename, change URL, set active, pick model, remove (`POST /api/r9/provider/remove`).
- **Persistence.** Connections are stored in `provider-connections.json` with `{schemaVersion:2, connections:[...]}`, written atomically with mode 0600. The file sits next to the DPAPI key store (`DAMAR_KEY_STORE`, default `%LOCALAPPDATA%\DAMAR\provider-keys`), so it is user-scoped and survives new Core sessions. Isolated fixture tests use the session directory instead. No key is ever written to this file.
- **No default.**
  - Removed: `ninerouter`, the fixed gateway, `GATEWAY_URL_IS_FIXED`, `APPROVED_LIVE_MODEL`, the `9router/` model-prefix aliasing, and the "remote presets unavailable" list.
  - A fresh install has `active:null`, `providers:[]` and `onboarding:'CONNECT_A_PROVIDER'`.
  - `active()` returns `kind:'none'`, `reason:'NO_PROVIDER_CONNECTED'`.
  - Fixtures exist only with `DAMAR_CORE_TEST_FIXTURES=1`.
- **Presets.** `PRESETS` in `provider-registry.cjs` is static and returned by `GET /api/r9/provider` as `presets`. It is used only to prefill the CLI `connect <preset>` and the Control "Add provider" form, and nothing connects automatically.
- **URL policy (`BASE_URL`).** Plain http only to 127.0.0.1, localhost or [::1]. https to any host. No userinfo, query string or other scheme. Core fetches `<baseUrl>/models` before accepting a connection and changes nothing if the fetch fails.
  - Error codes: `PROVIDER_URL_NOT_ALLOWED` (replaces `LOOPBACK_BASE_URL_REQUIRED`), `PROVIDER_URL_REQUIRED`, `CONNECTION_ID_INVALID`.
  - A remote https connection needs a key before it can be selected. A local http connection (Ollama, LM Studio) may run without one.
- **Keys.** Keys are write-only and are never read back. They are DPAPI-remembered per connection id and forgotten on revoke or remove.
- **Grants per connection.**
  - The `model-grants` journal keeps one current grant per connection id: id + baseUrl + model or `*`.
  - A revoke record can name a provider (that connection only); the old unnamed revoke clears all grants.
  - `authorization().revision` is the revision of that connection's own grant record, so granting connection B does not knock connection A out of executable.
  - The registry view exposes `grant`, `grantStatus` (`granted` | `none` | `needs-new-grant` | `not-required`) and `authorizedModels`. If the baseUrl changes or the grant expires, the status becomes `needs-new-grant`.
  - The grant/revoke routes validate against the list-level `configurationVersion` (the old code read `providers[0]`, which crashes when there are no providers).
- **Allow all models.**
  - CLI `provider allow <id> [days]` (default 30, max 365) is Owner-confirmed and posts a `*` grant for the id + its baseUrl.
  - Control "Add provider" does connect and then grants `*` for 30 days in one step (checkbox, on by default).
- **Budget.** `byteInputBound(body, provider)` uses the connection's `injectedTokens` (default 4096, settable 0–65536 via `/connect`).
- **Migration (once).** It runs when no v2 file exists:
  - The legacy session `provider-routes.json` and/or a remembered `ninerouter` key become `ninerouter` → "My router" at `http://localhost:20127/v1`.
  - A valid `custom-loopback` URL becomes "Custom endpoint".
  - Ids are kept, so DPAPI blobs (entropy is per id) and existing grants (id + baseUrl) keep matching. A grant whose URL no longer matches shows `needs-new-grant`.
  - The marker `migratedFrom:'legacy-v1'` is written. Removed connections do not come back. Core also writes `provider-migration.json` to the session directory when a migration happens.
- **Runtime.** `provider-runtime.activate` accepts any connection slug. It no longer has a gateway default: `baseUrl` is null until a selection is made, and the id falls back to `'custom'` for canonical federation.

## Files and line changes (mine; +added/−removed vs. pre-task snapshot; shared files may include other agents' hunks)
| File | Change |
|---|---|
| src/core-host/provider-registry.cjs | rewritten (+154/−85): connections, presets, URL policy, migration, remove, per-connection grant view |
| src/core-host/model-grants.cjs | +22/−12: per-connection grants and revoke, no gateway param |
| src/core-host/provider-runtime.cjs | +8/−7: no gateway or ninerouter; any slug; id fallback |
| src/core-host/provider-budget.cjs | +6/−6: per-connection injected-token allowance |
| src/core-host/provider-deadlines.cjs | +1/−1: neutral comment |
| src/core-host/core-host.cjs | provider block only: endpoint.cjs gateway refs removed, `initialKey` removed, routeFile/legacyRouteFile, `provider-migration.json`, `canonicalPresets` removed |
| src/core-host/r9-routes.cjs | provider hunks only: list-level `configurationVersion`, `revoke {approval, provider?}`, `/connect` accepts `label`/`injectedTokens`, new `/api/r9/provider/remove` |
| src/cli/provider-endpoint.cjs | localhost ≡ 127.0.0.1 alias for any connection |
| src/cli/subagents.cjs | +49/−17: hints, presets in the `connect` picker, preset prefill, `CONNECTED` result with next step, `provider allow/rename/remove`, no prefix aliasing |
| src/cli/commands.cjs | `provider allow/rename/remove` parsing; usage text |
| src/cli/settings-center.cjs | URL policy pre-check (`BASE_URL`), labels and grant status in the Provider dropdown, "no provider yet" reason (en/id), ninerouter rule removed |
| src/cli/main.cjs | usage text; `connect` quick-start line (en + id); `catalog` no longer probes a fixed gateway (points to `model list`) |
| src/cli/command-registry.cjs | `catalog` description and route |
| src/control/control.js | provider/models/grant views and onboarding step only (see below) |
| scripts/safety-mutations.cjs | M14 and M20 anchors updated to the new code |
| scripts/command-universe.cjs | `connect` description |
| docs/GETTING_STARTED.md, CLI_ENVIRONMENT.md, LIVE_INFERENCE_TEST_PLAN.md, PHYSICAL_ACCEPTANCE_PROCEDURE.md, SETTINGS_REFERENCE.md | provider-neutral wording |
| tests | provider-registry (rewritten, 8 tests), model-grants (+1 test), provider-budget (+1), subagents (+3), settings-center (+1, 1 rewritten), control-dashboard (+1, onboarding fixture aligned), plus id renames in user-witness, key-store, apply-recovery, settings-provider-payload, ui-settings. Probes updated: core-key-remember, core-model-grants, core-native-provider-routing, core-provider-config, core-host-http (comment). |

### control.js edits (for the Control agent)
1. `onboarding()`: `connected = live.length > 0` and `granted = live.some(p => p.grantStatus === 'granted')`. The `custom-loopback` check is gone.
2. `renderProvidersView`:
   - Added a "+ Add provider…" button and an empty-state panel "Connect a provider" when there is no live connection.
   - Each card shows Kind "OpenAI-compatible" and a "Model grant" row (granted / needs a new grant / none).
   - "Revoke" is now "Forget key" (only shown when a key exists), and a new "Remove" button was added.
   - The grant panel lists `gr.grants` per connection.
3. `version()` prefers `pv.configurationVersion`.
4. `root.DamarControl.onboarding = { connect → Add provider dialog, grant → Grant dialog }`. This uses the hook the Control agent left for `data-onboard`.
5. Actions:
   - `data-connect-provider` gains a Name (label) field.
   - `data-revoke-grant` picks a connection.
   - New `data-add-provider`: preset select prefills id, label and endpoint; then key, remember, and "Allow all models for this connection (30 days)", which chains `/connect` and then a `*` model-grant.
   - New `data-remove-provider`.

   New English strings go through `L()`. Indonesian dictionary entries are left to the Control agent's i18n table.

## Migration result on this machine
- The default `%LOCALAPPDATA%\DAMAR\provider-keys` does not exist. The Owner's key store used with `-KeyStore` is `D:\Damar\R9_WORK\r7r3-scratch\owner-provider-keys` (contains `ninerouter.dpapi`).
- I ran a dry run on a **copy** (the copy of the blob was deleted afterwards) together with the latest session route file `{"ninerouter":"http://localhost:20127/v1","custom-loopback":null}`:
  - `migration: {from:'legacy-v1', connections:['ninerouter']}` produced the connection "My router", `http://localhost:20127/v1`, `hasKey:true`, `keyRemembered:true` (the DPAPI key decrypted under its kept id), `grantStatus:'none'` (grants are per Core session, so a new session needs `provider allow`).
  - The second start gave `migration:null`, count 1.
  - Result file: `r7r3-scratch/r6-providers-migration-20261121203652/keys/provider-connections.json`.
- The real store was not modified. Migration runs on the Owner's next Core start that uses that key store.

## Live check (Owner-authorized)
- **Port 29651 was already in use** by another agent's process (PID 2160, `node compare-server.cjs`, started 20:35), which I did not touch. I ran my own Core on **29652** instead.
  - Session: `D:\Damar\R9_WORK\r7r3-scratch\r6-providers-live-20261121203854`.
  - Scratch key store and witness: `...-aux`.
  - After the check I stopped my Core (my parent task, then its orphaned child PID 3936, verified by its command line).
- The key was read from `%APPDATA%\9router\db\data.sqlite` `apiKeys.key` where `isActive=1`. It went straight into the `/api/r9/connect` body and was never printed or logged.
- Receipt (`execution-r6-providers-01-live-receipt.json`):
  - fresh install: `active:null`, 0 providers, `onboarding:CONNECT_A_PROVIDER`, 12 presets
  - connect `my-router` "My router" at `http://127.0.0.1:20127/v1`: 200, 46 models, `hasKey:true`, key not in the response
  - grant `*` for 30 days: 200, `{provider:'my-router', model:'*', effective:true}`
  - select `cx/gpt-6-luna`: 200, `executable:true`
  - Pandawa sadewa "what is 2+3": run `run_22e7fc00209842f0abb0ed70829ed0af` COMPLETED; output "2 + 3 = 5."
  - usage: `my-router/cx/gpt-6-luna` input 3177, output 12, 1 receipt; budget attempts 1, totalTokens 3189, not blocked
- Leak scan: 1241 files in the session and aux directories contain 0 plaintext key hits.

## Tests
- Full safe suite from R: `node --test --test-concurrency=1 --test-reporter=tap` over 68 `tests/*.test.cjs` files (excluding `computer-use.test.cjs`). **334 tests, 334 pass, 0 fail.**
- Before the change, the 11 affected files ran 75 tests with 2 failing, both in other agents' areas. Both pass now.
- Probe `tests/core-model-grants.cjs` (port 29993) **fails**: it asserts `MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE` ("no witness"), but core-host now always passes a default `DAMAR_WITNESS_DIR` to the Core child, and the grant returns `MODEL_GRANT_ROLLBACK_DETECTED`. The probe's premise is out of date, not the provider code. No real-profile directory was created.
- Not run: `core-provider-config.cjs` and `core-native-provider-routing.cjs` hardcode port 29623, which I must not touch. Their ids, URL policy and grant steps were updated.
- `graphify update .` was run in R.

## Preset list (verified 2026-11-21 against vendor docs)
| Preset | Base URL | Status |
|---|---|---|
| OpenAI | https://api.openai.com/v1 | verified |
| OpenRouter | https://openrouter.ai/api/v1 | verified |
| Groq | https://api.groq.com/openai/v1 | verified |
| Together AI | https://api.together.ai/v1 | verified (docs now say `.ai`, not `.xyz`) |
| DeepSeek | https://api.deepseek.com | verified without `/v1` (`/v1` is not documented) |
| Mistral AI | https://api.mistral.ai/v1 | verified |
| Google Gemini (OpenAI-compatible) | https://generativelanguage.googleapis.com/v1beta/openai | verified (trailing slash optional; Core trims it) |
| Anthropic (OpenAI-compatible) | https://api.anthropic.com/v1 | base URL verified. `/models` is a native Anthropic endpoint; its `data[].id` parses, but compat auth via Bearer on `/models` is not stated |
| xAI | https://api.x.ai/v1 | base URL verified; the `/models` auth header is not stated on that page |
| Ollama | http://127.0.0.1:11434/v1 | verified (default bind 127.0.0.1:11434) |
| LM Studio | http://127.0.0.1:1234/v1 | base path verified; **port unverified** (1234 is the example; the server reuses the last port used) |
| Custom | (empty) | — |

## Remaining risks
1. **Release leak scan.** `scripts/release/build-release.cjs` `privateRouter` regex (`/ninerouter|localhost:20127/`) will flag the migration constants in `src/core-host/provider-registry.cjs` (`LEGACY_ROUTER`).
   - The release agent needs a reviewed FALSE_POSITIVE entry for that file, or the public build must drop the legacy migration.
   - The tests `provider-registry.test.cjs` and `control-dashboard.test.cjs` also contain those strings, but tests are presumably not shipped.
2. **Grants are per Core session.** The model-grants journal lives in the session directory, so connections persist across sessions but grants do not (pre-existing design). Every new session needs `provider allow`.
3. **Inherited legacy pieces still mention the router.**
   - `inherited-v53/src/r7r3/endpoint.cjs` `gateway`, the `/api/r7r3/models` launcher route and `control-v2.js` text. No longer used by the CLI; left unchanged because inherited code is out of scope.
   - The hash-pinned `core-snapshot` `providerConfigService.js` hint "(mis. 9router)". Pinned, so not edited.
4. **Live run not executed for remote presets.** Remote https presets were not run live (no keys).
   - With `DAMAR_EGRESS=loopback` only local connections work (documented).
   - Anthropic's `/models` via Bearer is unverified.
5. **Rename needs a reachable endpoint.** Rename goes through `/connect`, which re-fetches `/models`, so renaming an unreachable endpoint fails.
6. **Remove keeps the grant.** `remove` does not revoke the grant record. Re-adding the same id + URL matches it again; this is intended but worth knowing.
7. **UI probes not updated.** `tests/conpty-model-persistence.cjs`, `visible-baseurl-probe.py` and `visible-settings-probe.py` (interactive) still look for `ninerouter`/`custom-loopback` rows.
8. **Phase 2 not started.** Phase 2 (router-grade Providers: multi-key rotation, combos, DAMAR `/v1` gateway) was received during this run and has not been started; it needs a separate assignment and report (execution-r6-providers-02.md).
