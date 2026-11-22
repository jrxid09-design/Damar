# Execution r6: Mata Dewa round 4 (matadewa-04), 2026-11-22

## 1. ALPR engine: installed and adapted; the real-image run is blocked

**Engine folder** (for the release agent):

| Context | Location |
|---|---|
| Core (installed product) | `<SCRATCH>\alpr`, which is `%LOCALAPPDATA%\DAMAR\alpr` when `DAMAR_DATA_ROOT=%LOCALAPPDATA%\DAMAR` |
| Core (development) | `D:\Damar\R9_WORK\r7r3-scratch\alpr` |
| Override | `DAMAR_ALPR_DIR` |
| Standalone | `%LOCALAPPDATA%\DAMAR\alpr` |

The folder holds the private `venv\`, the model cache `home\.cache\{open-image-models,fast-plate-ocr}\`, and `install.log`. The engine must live under the data root because Core's write guard only allows Node-side writes there. Core passes it explicitly at `core-host.cjs:354` (`alprDir: path.join(SCRATCH, 'alpr')`).

**Installed:** a venv at `%LOCALAPPDATA%\DAMAR\alpr\venv` (Python 3.12.10) with these pins:

| Package | Version | Licence |
|---|---|---|
| fast-alpr[onnx] | 0.4.0 | MIT |
| fast-plate-ocr | 1.1.0 | MIT |
| open-image-models | 0.6.0 | MIT |
| onnxruntime | 1.32.0 | MIT |
| opencv-python-headless | 5.1.0.95 | Apache-2.0 |
| numpy | 2.4.6 | BSD |

**Adapter** (`src/mata-dewa/alpr-engine.cjs`) is matched to the installed 0.4.0 API:
- Calls `ALPR(detector_model, ocr_model, ocr_device="cpu")`. The 0.4.0 default OCR is `cct-xs-v2-global-model`, which my earlier script had as v1.
- Reads `r.ocr.text` and `r.ocr.confidence` (a float or per-character list), `r.detection.bounding_box`, and `detection.confidence`.
- Uses one long-lived worker process that speaks JSON lines, so models load once.
- Verified against the real venv: the check step imports cleanly and reports `fastAlpr 0.4.0`.
- The worker never downloads: without weights it returns `MODELS_NOT_INSTALLED`.
- `pythonEngine` accepts null options, resolves its folder lazily, and creates no folders while checking. This fixes the `alpr-engine.cjs:76 ... reading 'dir'` failure the other agent saw. That was a mid-edit state where `pythonEngine(python)` received null.

**Install action:**
- Control shows an "Install ALPR engine" button with a confirm dialog and the host disclosure.
- Route: `POST /api/r9/mata-dewa/alpr {action:'install-engine'}`. Owner only, and only after the ALPR notice. It returns 202.
- Steps: venv, pinned pip install, then download of the two model weights.
- Hosts contacted: pypi.org, files.pythonhosted.org, github.com, objects.githubusercontent.com, release-assets.githubusercontent.com.

**Model licences.**
- Weights: from the GitHub releases of ankandrew/open-image-models (MIT repo) and ankandrew/cnn-ocr-lp (MIT repo). There is no separate licence file for the weights.
- Detector: `yolo-v9-t-384-license-plate-end2end`, a YOLOv9 model. The upstream YOLOv9 training code is GPL-3.0, and the training data is undocumented.
- Decision: download on demand from upstream and never bundle. Public commercial redistribution of the weights needs a legal review. Code licences are all permissive (table above).

**Real-image accuracy: NOT RUN.**
- Downloading the model weights (via the adapter's install step) was **denied by the permission classifier**. I did not work around it.
- Prepared test set, kept in scratch and not committed:
  - 3 public-domain Californian plates
  - 1 CC0 German plate
  - 8 CC BY-SA Dutch plates (ground truth taken from file names)
  - the synthetic `B1234XYZ` image
- Eval script: `scratchpad\alpr-eval.cjs`.
- To finish: the Owner clicks "Install ALPR engine" in Control, or grants the permission. Then run `node alpr-eval.cjs plates`; it reports exact-match and per-character accuracy.

## 2. Cameras: ffmpeg, RTSP credential exposure, Digest

- **ffmpeg** install through winget (Gyan.FFmpeg 9.1, user scope) was **denied by the permission classifier**. RTSP is therefore not live-verified, and ffmpeg is still not present.
- **Credential exposure fixed.** RTSP credentials are no longer on ffmpeg's command line:
  - The URL with credentials goes into a one-shot `ffconcat` file in the Owner's profile folder (`<profile>/mata-dewa/tmp`, mode 0600, `wx`). It is deleted as soon as ffmpeg exits or times out.
  - ffmpeg reads it with `-f concat -safe 0 -protocol_whitelist file,rtsp,rtsps,rtp,tcp,udp,tls`.
  - Without credentials, RTSP uses plain `-rtsp_transport tcp -i <url>`.
  - Tests check that argv carries no credentials and that the file is removed.
  - Caveat: concat→RTSP is unverified against a real ffmpeg, and `-rtsp_transport`/`-timeout` do not pass through concat. The 12 s kill timer bounds the call.
- **HTTP Digest** for snapshot and MJPEG:
  - Supports MD5, MD5-sess, SHA-256 and SHA-256-sess, with qop=auth or none.
  - Credentials are sent only after a 401 challenge (Digest preferred, otherwise Basic). Before this, Basic was sent preemptively.
  - Verified with the RFC 2617 vector (`6629fae4…`) and against a real loopback HTTP server that enforces Digest (one challenge, then 200; a wrong password gives `UPSTREAM_AUTH_REJECTED`).

## 3. Commercial-safe defaults (DAMAR is MIT; v1 free; non-commercial sources kept as labelled options)

**Default feeds:** earthquakes (USGS), **weather = MET Norway Locationforecast 2.0** (`api.met.no`, CC BY 4.0 / NLOD), **disasters = GDACS**, satellites, launches.

| Source | Feed id | Status |
|---|---|---|
| GDACS | `disasters` | default |
| Open-Meteo weather | `openMeteo` | optional, "non-commercial" |
| Open-Meteo air quality | `airQuality` | optional, "non-commercial" |
| OpenSky | `opensky` | optional, "non-commercial" |
| NHC | `cyclones` | optional |
| OpenAQ v3 | `openaq` | new, Owner-key flow |

- **GDACS** covers tropical cyclones in all basins, including the western Pacific, plus earthquakes, floods, volcanoes, droughts and wildfires. Its terms page gives no explicit API licence. JRC content falls under the EC reuse policy (CC BY 4.0) unless stated, so it is marked "likely — confirm".
- **OpenAQ v3** reads the nearest station within 25 km. The key is sent only in the `x-api-key` header. CAMS through Copernicus ADS needs an account, so it was not added.
- **User-Agent** is `DAMAR/1.0`. If the Owner sets `mataDewa.contactUrl` (https:// or mailto:, validated; empty by default) in Control, it becomes `DAMAR/1.0 (+<contact>)`. Live: MET Norway answers `DAMAR/1.0` without a contact.
- **Personal references removed:**
  - `THIRD_PARTY_NOTICES.md` and `FEATURE_MATRIX.md` no longer contain `C:/Workspace/...` paths.
  - The R module never used the `jrxid09-design/Aether` User-Agent; that string exists only in the canonical repo's `http.js`.
  - A test now fails if `jrxid`, `Aether` or `C:/Workspace` appears in any `src/mata-dewa` file.

## 4. Server-side camera search

`GET /api/r9/mata-dewa/cameras/public/<src>?q=<text>&page=<n>`:
- 24 cameras per page; matches on name or id.
- Validated: only `q` and `page` keys, q ≤ 60 characters with no control characters, page 1–1000. Anything else returns 400 `CAMERA_QUERY_INVALID`. Every other route still returns 405 on a query string.
- The list cap was raised to 6,000, so all Fintraffic presets are searchable.
- The Control view has a search box and ‹/› pagination.

## 5. ALPR alerts in `/api/r9/activity`

- `createMataDewa({ onAlert })` is wired at `core-host.cjs:356` to `turns.noteActivity(...)`, the existing external-activity hook. `agent-turns.cjs` and `r9-routes.cjs` are not edited.
- Event shape (for the presence agent):
  ```
  { seq, turnId: null, file: null, added: null, removed: null, at, kind: 'alert', source: 'mata-dewa',
    label: '<camera name, ≤40> · watchlist match', detail: '<PLATE>' }
  ```
  - The requester gets the same row without `detail`, because `agent-turns.activity()` drops `detail` for non-owners. The Owner sees the plate.
- `/status.alpr.unacknowledgedAlerts` still gives a count.

## Core / Control edits (current line numbers)

| File | Lines | Change |
|---|---|---|
| `core-host.cjs` | 94, 102 (around), 201 | `installEgressGuard(allow)` (from round 2) |
| `core-host.cjs` | 354-356 | `createMataDewa` now also receives `alprDir` and `onAlert` |
| `control.js` | ~1396 (helpers object) | `controlSession` (from round 2; the file has since grown under the Control agent) |
| `r9-routes.cjs`, `core-settings.cjs` | — | no new edits this round |

## Tests and live check

**Tests:**
- `mata-dewa-core.test.cjs`: 15 tests.
- `mata-dewa-cameras.test.cjs`: 11 tests, one of which is a real-engine test that skips until the engine and models are installed.
- Result: 25 pass, 1 skipped.
- New fixtures:
  - recorded: MET Norway, GDACS
  - schema-derived (labelled `_fixture`): OpenAQ locations and latest

**Live check:** isolated Core on 29643 with `DAMAR_EGRESS=loopback`, so only the allowlist was reachable.

| Check | Result |
|---|---|
| Default feeds | earthquakes 238, weather (MET), disasters (GDACS) 81, satellites 13, launches 10, all OK |
| Other keyless feeds | cyclones 0, flights 2, military 101, all OK |
| Military sample | C2702 C27J, full identifiers |
| Owner key write/forget (DPAPI) | worked |
| TfL search `a406` | 31 hits, 2 pages, JPEG still |
| Fintraffic search `vt4` | 263 hits, 11 pages, 503 KB JPEG |
| User-Agent | `DAMAR/1.0`, then `DAMAR/1.0 (+https://example.org/damar-contact)` |
| Own camera at loopback or 169.254.169.254 | `EGRESS_PRIVATE_ADDRESS` |
| ALPR engine state in Core | resolves `installed:false` at `D:\Damar\R9_WORK\r7r3-scratch\alpr` |
| `/api/r9/activity` | 200 |

I stopped only my own processes; port 29643 is free.

**Full safe suite:** **376 tests: 373 pass, 2 fail, 1 skipped.** Both failures are in other agents' areas and come from their in-progress settings changes (new keys their own tests don't expect yet):
- `pandawa.* settings: allowlist and validation` (`tests/cognitive-pandawa-team.test.cjs`, new `callTimeoutSec`)
- `presence settings live in Core: defaults, Owner-only validated writes, requester read` (`tests/control-dashboard.test.cjs`, new `presence.displayName` / `voiceEnabled`)

`graphify update .` ran.

## Risks

1. **ALPR accuracy is unproven** until the weights are installed (blocked by permission). The weights also need a provenance and licence review (YOLOv9 GPL-3.0 training code; undocumented training data). Only on-demand download is in place.
2. **RTSP through ffconcat is untested** against real ffmpeg (install blocked), and `-rtsp_transport` does not apply through concat.
3. **Commercial terms still to confirm:** GDACS (no explicit API licence), OpenAQ (licence per data provider), TfL (attribution terms).
4. **ALPR install egress** goes from a Python child process, so the `DAMAR_EGRESS=loopback` socket guard does not cover it. It is disclosed in Control and in the matrix.
5. **Alert end-to-end** (Owner camera with ALPR, real engine, activity feed) is covered by tests only, not by a live run.

## Addendum (2026-11-22): engine installed, ffmpeg installed

The Owner authorised, and the coordinator ran, the two steps that had been blocked:
- the ALPR engine install into `%LOCALAPPDATA%\DAMAR\alpr`;
- winget `Gyan.FFmpeg` 9.1 (user scope).

**Real ALPR results**, reproduced through DAMAR's adapter:

| Measure | Result |
|---|---|
| Images | 13 |
| Detected | 12 |
| Exact reads | 11 |
| Character accuracy | 91.4 % |
| Time per image | 25–100 ms after a ~0.5 s model load |

The two errors: `08-54-UB` was not detected, and `7B82644` was read as `7BB2644`. The results are recorded in `FEATURE_MATRIX.md` under "Verification".

The real-engine test now asserts exact reads on three images, all of which are in `tests/fixtures/mata-dewa/`:
- the synthetic `B1234XYZ`;
- a CC0 photo of `NNN203`;
- a public-domain photo of `1510891`.

**RTSP, end to end.**
- New loopback test camera: `tests/mata-dewa-rtsp-server.cjs`. It is test-only and speaks RTSP with Digest auth, TCP-interleaved transport only (UDP gets 461) and RTP/JPEG.
- **Fix:** the ffconcat path first tried UDP, because the concat reader does not pass `-rtsp_transport` through. Adding `option rtsp_transport tcp` and `option timeout 8000000` lines to the ffconcat file fixed it. Verified: only TCP SETUP requests, Digest accepted, a JPEG frame comes back.
- No credentials appear in ffmpeg's command line, and the credential file is removed. A wrong password returns no frame.
- Loopback is reachable only through the new test-only `createCameras({ addressCheck })` override. The product default still refuses loopback, and the test checks that.
- `findFfmpeg` now also looks in the WinGet `Links` folder and the `Gyan.FFmpeg` package folder, because a fresh winget install is not on PATH until a new shell.
- Full chain verified: RTSP → ffmpeg → real fast-alpr → log entry with crop → watchlist alert (`tests/mata-dewa-rtsp.test.cjs`).

**Full safe suite:** 401 tests, 401 pass, 0 fail. `graphify update .` ran.

**Risks:**
- ALPR accuracy on real camera scenes (distance, angle, night) will be lower than on these close-up plate photos.
- ffmpeg is a GPL build; never bundle it.
