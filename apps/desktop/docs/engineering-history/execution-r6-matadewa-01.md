# Execution r6: Mata Dewa v1 (matadewa-01), 2026-11-21

## Source and licence

- God's Eye View was shallow-cloned to `%TEMP%\gev-063617c6\repo`. Nothing in it was run.
- Licence: **MIT** for code only. Its data and bundled datasets are excluded from that grant.
- Decision: DAMAR adapts request and normalisation details and copies no file verbatim. Attribution and the MIT text are in `src/mata-dewa/THIRD_PARTY_NOTICES.md`.
- No GEV dataset was copied (for example, the TeleGeography cables are CC BY-NC-SA).

## Feature matrix

The full matrix is `src/mata-dewa/FEATURE_MATRIX.md` (32 rows).

| Status | Count | Rows |
|---|---|---|
| v1 | 6 | earthquakes (USGS), weather (Open-Meteo), airQuality (Open-Meteo CAMS, global, replaces GEV's Canada-only ECCC), flights (adsb.lol, redacted, off by default), satellites (CelesTrak mean elements, no SGP4), launches (LL2) |
| cred | 4 | OpenSky, AISStream, NASA FIRMS, TomTom |
| out | 22 | each with its reason in the matrix |

The "out" rows include:

- 3D map stack (CSP and keys)
- voice AI (paid LLM)
- military flights, ALPR, CCTV and street level (privacy and surveillance)
- transit and rail (would need general egress)
- cyclones and fire perimeters (v1.1 candidates)
- SDR/RF (no physical RF sensing is claimed)

## Files

New:
- `src/mata-dewa/egress.cjs`: exact-host allowlist, HTTPS/443 only, public-address lookup guard, no redirects, deadline, streamed byte cap, code-only errors.
- `src/mata-dewa/feeds.cjs`: feed definitions, parsers ported from C/src/mataDewa/providers, aircraft redaction, `mataDewa.*` settings rules.
- `src/mata-dewa/index.cjs`: service plus read-only routes (`GET /api/r9/mata-dewa/status`, `GET /api/r9/mata-dewa/feeds/<id>`).
- `src/mata-dewa/FEATURE_MATRIX.md` and `src/mata-dewa/THIRD_PARTY_NOTICES.md`.
- `src/control/views/mata-dewa.js`: registered via `DamarControl.registerView` (the other agent's hook was present). Contains the consent card, egress disclosure, SVG world plot, feed panels, attribution and the Owner settings editor.
- `tests/mata-dewa-core.test.cjs` (9 tests) and `tests/fixtures/mata-dewa/*` (recorded 2026-11-21; USGS trimmed to 25 features, LL2 to 5).

Core edits (additive; line numbers as of the end of this run):
- `src/core-host/r9-routes.cjs`:
  - line 35: added the `mataDewa = null` dependency.
  - lines 171-172: delegate `/api/r9/mata-dewa/` after the role check.
- `src/core-host/core-settings.cjs`:
  - lines 44-45: require `feeds.cjs`.
  - line 61: sanitize on load.
  - line 137: `mataDewa` added to `view()`.
  - line 142: `mataDewa()` getter.
  - line 169: validated merge in `update()` (400 `MATA_DEWA_SETTINGS_INVALID`).
- `src/core-host/core-host.cjs`:
  - line 325: `createMataDewa({ settings: coreSettings })` passed to createR9Routes.
- `control.js` and `serve.cjs` were not touched.

## Routes

- Both credentials can read: owner and requester.
- Responses use the `{success, data}` envelope.
- Non-GET requests or a query string get 405. A request body on GET gets 413. Unknown feeds get 404.
- Without consent, feeds return 409 `MATA_DEWA_CONSENT_REQUIRED`. A disabled feed returns 409 `FEED_DISABLED`.
- Settings are written only by the Owner through `/api/r9/settings` with `values.mataDewa` (session-bound, as for presence).

## Egress allowlist

- `earthquake.usgs.gov`
- `api.open-meteo.com`
- `air-quality-api.open-meteo.com`
- `api.adsb.lol`
- `celestrak.org`
- `ll.thespacedevs.com`

## Tests

- `tests/mata-dewa-core.test.cjs`: 9/9 pass, with no network.
- Full safe suite (`tests/*.test.cjs` except computer-use, `--test-concurrency=1`, TAP): **305 tests, 305 pass, 0 fail**.
- `graphify update .` ran.

## Live check

Core on 29643, isolated session `D:\Damar\R9_WORK\r7r3-scratch\md-live-r6-20261121-201222` with its own settings, keys and sandbox registry under `...-aux`. The Core was stopped afterwards (only the processes I started: PIDs 15140 and 16520).

| Check | Result |
|---|---|
| unauthenticated | 401 |
| requester status | 200 |
| POST | 405 |
| feed before consent | 409 `MATA_DEWA_CONSENT_REQUIRED` |
| invalid settings | 400 |
| requester writing settings | 403 |
| owner writing settings | 200 |
| earthquakes | OK, 251 items, 2.1 s |
| weather | OK, Jakarta 28 °C, 0.9 s |
| airQuality | OK, US AQI 175, 1.0 s |
| flights | OK, 6 aircraft, no identifiers in the response, 0.8 s |
| satellites | OK, 13 (ISS perigee/apogee 413/423 km), 1.1 s |
| launches | OK, 10, 1.4 s |
| repeat earthquakes call | served from cache in 2 ms |
| Control `/control/views/mata-dewa.js` | 200; `index.html` injects the script |

No browser was available (Chrome is not installed), so the view's DOM behaviour was checked only by the Node render test.

## Risks

1. **Core egress is open by default.** During this run another agent changed `core-host.cjs:192-194` so that the loopback-only socket guard is installed only when `DAMAR_EGRESS=loopback`. By default Core therefore has general egress. Mata Dewa enforces its own exact-host allowlist in `egress.cjs` either way. With `DAMAR_EGRESS=loopback`, Mata Dewa feeds fail with `EGRESS_NETWORK_ERROR`; I added no hosts to that guard. The Owner needs to reconcile this with the "no general egress" rule.
2. The view duplicates Control's `controlSession()`, because the hook helpers don't expose it. Adding `helpers.controlSession` in `control.js` would remove the duplication.
3. The DNS guard covers only Mata Dewa's own requests. Under open egress, other Core code can reach these hosts or any other host.
4. Upstream terms:
   - Open-Meteo's free tier is non-commercial.
   - adsb.lol is ODbL.
   - LL2 allows 15 calls per hour.
   - CelesTrak asks for at most one download per group per 2 hours.
   Refresh floors enforce these limits per Core process, but the cache is in memory, so each Core restart refetches.
5. Feed data comes from third parties (not DAMAR sensing). Air quality is a model estimate. Satellites show mean elements, not live positions.
6. The fallback `UNAVAILABLE.matadewa` text in `control.js` stays in place for when the view script fails to load. The existing `control-dashboard` test still asserts it in Node.
