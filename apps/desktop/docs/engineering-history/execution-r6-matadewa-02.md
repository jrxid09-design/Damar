# Execution r6: Mata Dewa round 2 (matadewa-02), 2026-11-21

## 1. Loopback guard admits the Mata Dewa allowlist

`src/core-host/core-host.cjs`:

| Lines | Change |
|---|---|
| 93-94 | `installEgressGuard(allow = [])` |
| 102 | also passes a connection when `allow.includes(host) && port === 443` |
| 195 | when `DAMAR_EGRESS=loopback`, the guard gets `require('../mata-dewa/egress.cjs').HOSTS` |

Live run on 29643 with `DAMAR_EGRESS=loopback`:
- all 8 keyless feeds returned OK, and both public camera sources worked;
- `egress-denied.json` recorded `{"count":0}`.

## 2. Owner-key feeds

The Owner adds keys in Control; Core keeps them in the existing `key-store.cjs` (DPAPI).

- Key ids are `matadewa-opensky`, `matadewa-vessels`, `matadewa-fires` and `matadewa-traffic`. They use `-` instead of `:` because `key-store.cjs` IDs must match `^[a-z0-9-]{1,40}$`; I left `key-store.cjs` unchanged.
- Route: `POST /api/r9/mata-dewa/keys/<feed>`, Owner only.
  - Body is `{apiKey}`, `{clientId, clientSecret}` or `{forget:true}`.
  - Values must be 4-256 printable characters.
  - The response is only `{feed, hasKey}`. Keys are never returned.
- Feeds:

| Feed | Source | How it is fetched |
|---|---|---|
| `opensky` | OpenSky | OAuth client-credentials token, then `states/all` for the area's bounding box |
| `vessels` | AISStream | 8 s `wss` window, ≤ 5,000 messages, ≤ 4 MB |
| `fires` | NASA FIRMS | VIIRS area CSV |
| `traffic` | TomTom | flow segment at the area centre |

- Same caps as the keyless feeds. Errors are codes only, so the FIRMS key in the URL path and the TomTom key in the query string cannot leak.
- Vessels: MMSI, IMO, name and call sign are kept only for commercial or service ship types (31–35, 40–89). Everything else is anonymous, with positions rounded to 0.01°.
- Without a key, the feed returns 409 `FEED_KEY_REQUIRED` with `signupUrl`. Control shows "Add your key" with the signup link and a password field.

## 3. Persisted cache

- File: `<session dir>/mata-dewa-cache.json`. It holds the latest snapshot per feed and area, with fetch timestamps.
- Writes are atomic and debounced, capped at 8 MB (oldest entries dropped first). A corrupt file is ignored.
- Live check: I called `POST /api/r9/lifecycle/restart` on my Core. After the restart, `fetchedAt` was unchanged for earthquakes, launches and satellites, so no new upstream requests were made.

## 4. Cyclones

- New `cyclones` feed from NHC `CurrentStorms.json` (US public domain), on by default. It covers the Atlantic and eastern/central North Pacific only.
- The live feed returned 0 active storms (it is November). A schema-derived fixture covers the parser.
- JTWC (western Pacific, which matters for Indonesia) is not added. GDACS is the candidate.

## 5. `helpers.controlSession`

- `src/control/control.js` line 1007: added `controlSession: function () { return controlSession(); }` to the helpers object. Nothing else in `control.js` was touched.
- The view now calls `H.controlSession()`; its own session code is gone (a test checks this).
- The `UNAVAILABLE.matadewa` fallback is kept, so `tests/control-dashboard.test.cjs` is unchanged.

## 6. i18n

- The view reads `GET /api/r9/cli/settings` and uses `cli.language`: `'id'` gives Indonesian, anything else (including null) gives English.
- About 40 UI strings exist in both languages; a test checks every English key has an Indonesian translation.
- Feed and source data (labels, licences) stay in English.

## 7. Attribution and licensing

The attribution table in Control shows each source, its licence and a "Commercial use" column. The Open-Meteo free API is marked non-commercial.

## Other changes

| File | Lines | Change |
|---|---|---|
| `src/core-host/core-host.cjs` | 331 | `createMataDewa` now also receives `keyStore`, `cacheFile`, `profileDir` (`<settings dir>/mata-dewa`) and `python` |
| `src/core-host/r9-routes.cjs` | 172 | the delegation passes `{ who, body }`; Owner checks happen inside the module |

## Commercial-distribution flag

**Open-Meteo `weather` and `airQuality` cannot be distributed commercially on the free API.** Proposed alternatives:

- weather: **MET Norway Locationforecast** (CC BY 4.0 / NLOD, free commercial use, needs an identifying User-Agent and caching);
- air quality: **OpenAQ v3** (measurements, free key, mostly CC BY 4.0) or **CAMS via Copernicus ADS** (commercial use allowed, free account);
- or Open-Meteo's paid plan.

**OpenSky** is non-commercial. **AISStream** has no formal terms.
