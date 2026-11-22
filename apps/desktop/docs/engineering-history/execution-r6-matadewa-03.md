# Execution r6: Mata Dewa round 3 (matadewa-03), 2026-11-21/22

## A. Military and full aircraft identifiers (Owner decision)

- `redactAircraft` (`src/mata-dewa/feeds.cjs`) now returns `hex`, `callsign`, `registration`, `type`, `military`, position (4 decimals), altitude, ground speed and track.
- It withholds only LADD (dbFlags 8) and PIA (dbFlags 4) aircraft and counts them as `withheld`.
- New `military` feed: `api.adsb.lol/v2/mil`, worldwide.
- Live check returned 54 aircraft, for example `{"hex":"ae2fa5","callsign":"RCH5039","reg":"08-8193","type":"C17","military":true}`.
- OpenSky publishes no LADD/PIA flag, so results from that feed cannot apply the filter (documented in the matrix).

## B. Camera grid (`src/mata-dewa/cameras.cjs` and the Control view)

**Official public cameras:**

| Source | Terms | Hosts |
|---|---|---|
| TfL JamCams (London) | TfL Open Data terms, "Powered by TfL Open Data" | `api.tfl.gov.uk`; images on `s3-eu-west-1.amazonaws.com`, path-limited to `/jamcams.tfl.gov.uk/` |
| Fintraffic weather cameras (Finland) | CC BY 4.0 | `tie.digitraffic.fi`, `weathercam.digitraffic.fi` |

- The Owner enables regions with the `mataDewa.cctvSources` setting.
- Core serves the latest still only (cached 60 s; camera lists cached 6 h). Nothing is recorded, and image URLs off the allowlist are dropped.
- Caltrans was dropped: its endpoint did not respond to my recording request.
- Live: TfL returned 753 cameras and a 14.6 KB JPEG; Fintraffic returned 2,000 cameras (capped) and a 278 KB JPEG.

**Owner cameras:**
- `POST /api/r9/mata-dewa/cameras` with `add`, `update` or `remove`. Owner only, up to 16 cameras.
- Kinds:
  - `snapshot`: HTTP JPEG
  - `mjpeg`: the first frame of the stream
  - `rtsp`: one frame through ffmpeg. ffmpeg is an optional dependency found on the user's PATH and is not bundled (GPL/LGPL needs a licence review first). It was not found on this machine, so RTSP returns `FFMPEG_NOT_FOUND`.
- Credentials are stored with DPAPI as `matadewa-cam-<id>` and never returned. `cameras.json` holds only the name, kind, URL and the ALPR and `hasCredential` flags.
- URLs with embedded credentials are refused.
- LAN addresses are allowed only for these registered URLs (`fetchCamera` / `isCameraAddress`). Loopback, link-local (including 169.254.169.254), multicast and unspecified addresses are refused.
- There is no discovery, scanning or default-credential guessing.
- ONVIF is not spoken: the Owner enters the camera's snapshot or RTSP URL.
- Control shows frames as JSON base64 drawn on a `<canvas>` with `createImageBitmap`, so Control's CSP (`img-src 'self'`) is unchanged.

## C. ALPR (`src/mata-dewa/alpr.cjs`)

**Scope:** Owner cameras with ALPR enabled only. The module has no access to public cameras.

**Engine:**
- `fast-alpr` (MIT; models from open-image-models and fast-plate-ocr, MIT), run locally in the Core's Python.
- It is **not installed here**, and installers were off-limits, so ALPR reports `available:false` and Control shows `pip install fast-alpr`.
- The engine script has not been run against the real package. Tests use an injected fake engine and a synthetic sample image (`tests/fixtures/mata-dewa/alpr-sample.jpg`).

**Pipeline and storage:**
- Scans every `alprIntervalSec` (default 15 s).
- Keeps reads with confidence ≥ 0.5 whose plate normalises to `[A-Z0-9]{2,12}`.
- Skips a repeat of the same plate on the same camera within 120 s.
- Log is `<profile>/mata-dewa/alpr/log.jsonl` with `crops/<id>.jpg`.
- Retention is `alprRetentionDays` (default 30). It is purged hourly and on access, removing crops too. The log is also capped at 50,000 entries.

**Watchlist and alerts:**
- Up to 200 watchlist entries.
- A watchlist hit raises an alert; the unacknowledged count appears in `/status.alpr.unacknowledgedAlerts`.

**Routes (Owner only):**

| Route | Purpose |
|---|---|
| `GET /alpr` | status, entries, watchlist and alerts |
| `POST /alpr` | `delete`, `delete-all`, `watchlist-add`, `watchlist-remove`, `ack-alerts` |
| `GET /alpr/alerts` | alerts only |
| `GET /alpr/export` | full export as JSON |
| `GET /alpr/crops/<id>[/frame]` | one crop image |

**Not built:** plate-to-owner or identity lookup, cross-camera tracking of people on public feeds, ALPR on public cameras.

**Not wired yet:** the notch activity feed. `src/presence/*` belongs to another agent and has no generic notification hook. The alert count is exposed in `/status` for it to read.

## D. Legal notices

- New settings `mataDewa.cctvNoticeAt` and `mataDewa.alprNoticeAt` (ISO time or null), validated in `feeds.cjs` and recorded through `/api/r9/settings`.
- Control shows each notice once (texts in `NOTICE.cctv` and `NOTICE.alpr`, in English and Indonesian) until the Owner accepts it.
- Core enforces them:
  - adding a camera or reading an own-camera frame without the CCTV notice returns `CCTV_NOTICE_REQUIRED`;
  - enabling ALPR without the ALPR notice returns `ALPR_NOTICE_REQUIRED`;
  - scans run only when both notices are accepted.

## Tests, live check, suite

**Tests:**
- `tests/mata-dewa-core.test.cjs`: 12 tests.
- `tests/mata-dewa-cameras.test.cjs`: 6 tests.
- All 18 pass with no network.
- Recorded fixtures: USGS, Open-Meteo (weather and air quality), adsb.lol (area and military), CelesTrak, LL2, NHC (empty), TfL, Fintraffic, plus two camera images.
- Schema-derived fixtures, labelled `_fixture`: OpenSky, AISStream, FIRMS, TomTom (no Owner keys were available), an NHC storm, and the synthetic ALPR image.

**Live check:** isolated Core on 29643 with `DAMAR_EGRESS=loopback` and its own settings, key store and sandbox registry under `D:\Damar\R9_WORK\r7r3-scratch\md-live-r6b-20261121-204115-aux`.

| Check | Result |
|---|---|
| 8 keyless feeds | all OK |
| Military sample | full identifiers |
| `fires` without a key | `FEED_KEY_REQUIRED` |
| Requester writing a key / Owner writing a key (DPAPI) / forgetting it | 403 / 200 `hasKey:true` / `hasKey:false` |
| TfL and Fintraffic | lists and JPEG stills served |
| Own camera before the notice | `CCTV_NOTICE_REQUIRED` |
| Own camera at `127.0.0.1` | `EGRESS_PRIVATE_ADDRESS` |
| ALPR engine | not available |
| `cli.language` | null, so English |
| Restart via the lifecycle route | cache preserved |
| Shutdown | port 29643 free afterwards |

The run used two Cores; I stopped only the processes I started (2532, 16732 and its child 25420).

**Full safe suite** (`tests/*.test.cjs` except computer-use, concurrency 1, TAP): **340 tests, 340 pass, 0 fail**.

`graphify update .` ran.

## Risks

1. **ALPR engine.** It has not been verified against the real `fast-alpr` package, which is not installed. The fast-alpr API may differ by version; the script reads its attributes defensively. The models download from GitHub on first run, and the licence of the model weights needs a check before release. ALPR is also legally sensitive (GDPR or local law); the notice and the controls are in place, but the legal responsibility stays with the Owner.
2. **RTSP credentials.** They are passed to ffmpeg on its command line (URL userinfo), so other processes of the same Windows user can see them while ffmpeg runs. Digest-auth HTTP cameras are not supported (Basic only).
3. **Notch alerts.** The notch does not show ALPR alerts yet; that needs a presence-side hook from the presence agent.
4. **Commercial terms.** Open-Meteo, OpenSky and AISStream terms block or cloud commercial distribution (alternatives are in `FEATURE_MATRIX.md`). The TfL terms need attribution and have conditions; review them before a commercial release.
5. **Camera data volume.** Fintraffic has more than 2,000 presets; the list is capped at 2,000 and Control's redaction caps arrays at 500, so the filter only searches the first 500.
6. **Unclean stop.** Stopping my Core by killing its parent left no `FINISHED.json`, so `--resume` was not possible. This is existing lifecycle behaviour, not something Mata Dewa changed.
7. **Cyclone coverage.** Cyclones cover NHC basins only; there is no western-Pacific/Indonesia coverage yet.
