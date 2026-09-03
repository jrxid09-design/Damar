# Mata Dewa — God's Eye View Adoption Boundary Map

**Wave 5 Lane 5 · Mata Dewa**
**Status:** Canonical adoption audit. Produced before coding per the Lane 5
brief. This document is the exact KEEP / ADAPT / REPLACE / REMOVE mapping of
the God's Eye View (GEV) reference source into the embedded Damar Mata Dewa
mode.

---

## 1. What Mata Dewa is (and is not)

Mata Dewa is an **embedded Damar mode**, not a second application. God's Eye
View (`bilawalsidhu/gods-eye-view`) is the **implementation foundation for the
spatial surface only**. It is adopted as a set of modules inside Damar's own
runtime and UI ownership — never shipped as a separately launched user app,
never given its own public port, never given its own AI/voice runtime.

Canonical Damar flow is preserved and never duplicated:

```
interaction → RuntimeHost → InteractionBus → Manager → Context Intelligence
            → Capability Intelligence → Tool/Provider routing → governed execution → verification
```

Mata Dewa owns: SEE / OBSERVE / NORMALIZE / CORRELATE / MONITOR / VISUALIZE /
WATCH / ALERT-WITH-EVIDENCE.
Damar owns: UNDERSTAND / REASON / DECIDE / SPEAK / AUTHORIZE ACTION.

---

## 2. Upstream baseline

| Field | Value |
|---|---|
| Repository | `https://github.com/bilawalsidhu/gods-eye-view.git` |
| Local reference | `/mnt/c/Workspace/gods-eye-view-reference` |
| Version | `0.1.1` |
| License | **MIT** — `Copyright (c) 2026 Bilawal Sidhu` |
| Module system | ESM (browser), Cesium `^1.124.0`, `vite-plugin-cesium` |
| Backend | The Vite dev/preview server itself (`vite.config.js`, ~7.7k lines, ~20 inline connect proxies on port 4173) |

**Endpoint verification (performed during adoption):** the four keyless
upstreams Mata Dewa boots on were probed live and all returned HTTP 200 —
USGS `all_day.geojson`, CelesTrak `gp.php?GROUP=stations&FORMAT=tle`,
Open-Meteo `v1/forecast`, adsb.lol `v2/lat/{lat}/lon/{lon}/dist/{r}`. No
historical endpoint is assumed valid; each is re-verified and, where a source
now requires a key, it is classified accordingly rather than bypassed.

---

## 3. Adoption policy (confirmed against current source)

The brief's *expected* policy was confirmed against the actual code. Findings
that changed the naive expectation:

- **`src/ui.js` (StyleManager, 10,310 lines) is not liftable.** It is the
  largest coupling hub (post-processing, HUD, panels, radio, CCTV panel,
  global-context modes, share-link, navigation authority, cockpit vision).
  It is **carved, not copied** — Mata Dewa re-implements only the HUD
  *concepts* and a Damar-owned panel surface.
- **Voice tool schemas + system prompt live inside `vite.config.js`**, not in
  `src/voice/`. Separating voice means extracting `GEV_REALTIME_TOOLS` (28
  tools) and re-mapping them onto Damar capabilities — there is no clean
  "voice module" to keep.
- **`src/hud.js` imports `getBasemapLabelContext` from `voice/gevActions.js`**,
  so the HUD drags the voice graph in even without voice. The HUD is adapted
  with that import severed.
- **`main.js` imports `voice/gevRealtime.js` unconditionally** — the OpenAI
  path is linked at boot. That import is dropped entirely in the embed.
- **`vite.config.js` sets `X-Frame-Options: DENY` + `frame-ancestors 'none'`.**
  Irrelevant to Mata Dewa: we do **not** iframe the upstream app; we adopt its
  modules into Damar's own renderer. The headers are noted, not inherited.

### 3.1 KEEP (adopted with little/no structural change)

| Upstream path | What it is | Where it lands in Damar |
|---|---|---|
| `src/mapStackController.js` | 5-stack basemap switcher (photoreal/bing-aerial/bing-labels/esri-imagery/osm), generation-guarded, emits change events | `apps/console/renderer/views/mataDewa/lib/mapStack.js` (ESM→IIFE, Cesium global) |
| `src/renderGovernor.js` | Idle render-loop governor (requestRenderMode hold/release) — critical on CPU/iGPU | `apps/console/renderer/views/mataDewa/lib/renderGovernor.js` |
| `src/scenes/director.js`, `scenes/recipes.js`, `scenes/scenePolicy.js` | Deterministic cinematic scene playback + pure scene policy | `apps/console/renderer/views/mataDewa/lib/scenes.js` |
| `src/annotations/*` (engine, resolvers, renderers) | World-anchored "whiteboard" annotation engine | `apps/console/renderer/views/mataDewa/lib/annotations.js` |
| `src/hud.js` (HUD *concepts*) | NRO/NGA intelligence HUD (MGRS/lat-lon, sensor metrics, timestamps) | `apps/console/renderer/views/mataDewa/hud.js` (re-owned, voice import severed) |
| `src/data/dataCredits.js` | `DATA_CREDITS` provider-attribution registry → Cesium credit lightbox | `apps/console/renderer/views/mataDewa/lib/credits.js` |
| `src/data/manager.js` (DataLayerManager *pattern*) | Uniform layer lifecycle/registry contract `{id, enable, disable, update, getStats}` | Re-implemented as the Damar-owned LayerPanel driven by the headless registry (see §5) |
| `src/styles/*` (visual filters) | retro/surveillance/thermal/anime/noir/snow post-process shaders | `apps/console/renderer/views/mataDewa/lib/styles.js` |
| Pure policy/math helpers (`directionText`, `geoid`, `trafficFlow/PresetStyle`, `firmsCsv`, `aisWatchdog`, `radioCountry`, `detection*`) | No Cesium/DOM imports, heavily unit-tested | Server: `src/mataDewa/spatial/geo.js` (+ provider modules) |
| Cesium globe, camera/navigation, entity visualization, tracking, map-stack switching | The mature spatial surface | `apps/console/renderer/views/mataDewa/globe.js` + vendored Cesium `1.124.0` |

### 3.2 ADAPT (reused shape, re-owned by Damar)

| Upstream concept | Adaptation |
|---|---|
| Data-layer modules (`flights`, `earthquakes`, `satellites`, `cctv`, `traffic`, …) | Their *provider semantics* move server-side into `src/mataDewa/providers/*` behind the Spatial Provider Registry. The renderer no longer fetches upstreams directly; it renders **normalized `SpatialObservation`s** from Damar. |
| The ~20 `/api/*` Vite connect proxies | Re-implemented as a small, honest provider layer server-side (`src/mataDewa/providers/http.js`) with the same guardrails (SSRF allowlist, timeouts, size caps, bounded disk cache). **No new public listener** — they run inside the Damar daemon process. |
| `GEV_REALTIME_TOOLS` (28 voice tools) | Re-mapped into **Damar capabilities** (`mata_dewa.*`) via the canonical Capability Registry + a Damar plugin (`src/plugins/mataDewa`). No AI-generated imperative executes except through Manager/Authority. See `docs/architecture/MATA-DEWA-CAPABILITY-MAP.md`. |
| HUD summary (`/api/openai/hud-summary`) | **Removed** (OpenAI). The Mata Dewa HUD status line is composed locally from observation/watch state — keyless. |
| Provider key brokering | Replaced by the canonical **Secret Vault** (`src/runtime/vault`). Mata Dewa is the vault's first canonical consumer. Config persists only `secretref:v1:…` strings, never cleartext. |
| `firstRunExperience`, `keySetup` POWER-UP panel | Replaced by Damar's own settings/console surface; credentials entered via the Mata Dewa credentials API into the vault. |

### 3.3 REPLACE (dropped, Damar canonical used instead)

| Upstream | Replaced by |
|---|---|
| `src/voice/gevRealtime.js` (OpenAI Realtime WebRTC, `RTCPeerConnection`, `/api/realtime/token`, `api.openai.com/v1/realtime/calls`) | **Damar VoiceRuntime** (`src/voice`) → `host.channels` → Manager. Untouched, certified. |
| OpenAI voice agent + tool execution (`src/voice/gevActions.js` as the *runtime dispatcher*) | **Manager → Capability Intelligence → governed execution.** The *action semantics* are extracted into the capability map; the dispatcher itself is not run. |
| Standalone AI decision logic / system prompt (in `vite.config.js`) | Damar Manager reasoning. Mata Dewa never decides; it observes and reports. |
| Standalone user ingress (the GEV browser app on port 4173) | Damar Console (Electron) as the single UI; the Express daemon as the single ingress. |
| Standalone control authority | Canonical Action Intent → Authority → Actuation → Verification (`src/action`, `src/authority`). |
| `OPENAI_API_KEY` / `OPENAI_REALTIME_*` env surface | None. No OpenAI dependency is required or imported. |

### 3.4 REMOVE (not adopted)

| Upstream | Reason |
|---|---|
| The entire Vite application shell (`index.html`, `vite.config.js` as a server, `package.json` scripts) | Mata Dewa is not a second app; no second public port. |
| `src/voice/gevRealtime.js`, `src/voice/voiceCost.js` | OpenAI Realtime runtime + cost tracker. |
| `/api/realtime/token`, `/api/realtime/debug-log`, `/api/openai/hud-summary` endpoints | OpenAI brokered endpoints. |
| `firstRunExperience.js`, `keySetup*.js`, `keySetupHardening.mjs` | GEV-specific onboarding/key chrome. |
| `sharelink.js` v2 URL-hash share codec | Not a Mata Dewa feature (single-user embedded mode). |
| `pinokio/`, `tools/` standalone CLIs | Out of scope. |
| `src/data/local_data/telegeography_submarine_cables/` | **CC BY-NC-SA 3.0 — non-commercial.** Excluded from adoption to keep Mata Dewa's data licensing clean. |
| `public/models/*.glb` | Third-party, not MIT; per-file terms. Not needed for the embedded surface. |

---

## 4. Where each adopted piece lives in Damar

```
Damar daemon (Node, CJS)                     Damar Console (Electron renderer, browser ESM)
─────────────────────────                    ─────────────────────────────────────────────
src/mataDewa/                                 apps/console/renderer/views/mataDewa/
├─ index.js            (service facade)       ├─ view.js        (APPS entry: render/mount/unmount)
├─ service.js          (headless lifecycle)   ├─ globe.js       (Cesium viewer bootstrap)
├─ config.js           (mode ZERO/PLUS/PRO)   ├─ hud.js         (Damar-owned HUD)
├─ stateStore.js       (persisted watches)    ├─ layers.js      (layer panel ← registry)
├─ registry/           (provider registry)    ├─ tracking.js    (entity track/select)
├─ providers/          (keyless + keyed)      ├─ alerts.js      (alert surface)
│   ├─ http.js         (fetch guardrails)     ├─ assets.js      (watched-asset surface)
│   ├─ usgs.js celestrak.js openMeteo.js      └─ lib/           (ADOPTED GEV modules, MIT header)
│   ├─ adsbLol.js osm.js osrm.js overpass.js       ├─ mapStack.js        (KEEP §3.1)
│   └─ keyed: opensky, aisStream, firms,           ├─ renderGovernor.js  (KEEP §3.1)
│       tomtom, googleMaps, cesiumIon, bmkg        ├─ scenes.js          (KEEP §3.1)
├─ spatial/            (geo primitives,        ├─ annotations.js     (KEEP §3.1)
│   index/grid, access, epistemic)             ├─ styles.js          (KEEP §3.1)
├─ observations/       (SpatialObservation)    └─ credits.js         (KEEP §3.1)
├─ events/             (SpatialEvent + fusion)
├─ assets/             (SpatialAsset + import)  apps/console/renderer/vendor/cesium/
├─ watch/ alert/ routes/ coverage/ timeline/    └─ cesium.bundle.js + Assets/Widgets/Workers
├─ location/ media/ capabilities/ actions/         (vendored Cesium 1.124.0)
└─ credentials.js      (Secret Vault seam)
```

**Single lifecycle:** `src/server.js` `bootSubsystems()` starts Mata Dewa
(fail-graceful, like every other subsystem) and `shutdown()` stops it. No user
launch step, no second terminal, no second public port. Provider failure is
contained and reported as degradation; it never kills Damar.

**Single UI:** the APPS registry gains one entry (`id: "mata-dewa"`) in the
existing Console. Activating the mode navigates the *same* application to the
Mata Dewa screen; "Damar, kembali" navigates home. The Cesium surface is
client-side; the daemon serves only normalized JSON + media.

---

## 5. Headless core vs. UI state

The spatial intelligence (providers → observations → fusion → watch → alert)
runs **headless inside the daemon**, independent of whether the Mata Dewa
screen is open. `UI state ≠ core monitoring state`.

Example required flow:

```
UI = NORMAL
  → Watch Engine detects hazard (lightning near a watched tower)
  → Alert Engine emits an evidence-grounded SpatialEvent
  → Damar (Manager) may notify the user through any channel
  → user says "buka" / "aktifkan mode Mata Dewa"
  → the SAME Console navigates to MATA_DEWA
  → globe camera focuses the relevant event/asset
```

The renderer is a **dumb surface**: it polls the daemon for normalized state
and sends intents back. All observation, fusion, watch, and alert logic lives
server-side so it persists when the window is closed.

---

## 6. Keyless-first law

`CREDENTIAL AVAILABILITY ≠ CORE AVAILABILITY` and `PROVIDER FAILURE ≠ MATA
DEWA FAILURE`.

- **MATA DEWA ZERO** (no third-party keys): boots and gives meaningful spatial
  intelligence on the verified keyless baseline — Esri/OSM basemap, USGS
  earthquakes, CelesTrak satellites, Open-Meteo weather, adsb.lol flights,
  OSM/Overpass, OSRM routing.
- **MATA DEWA PLUS** (user-owned/free credentials): OpenSky OAuth, AISStream,
  NASA FIRMS, BMKG — resolved from the vault when present.
- **MATA DEWA PRO** (optional commercial): TomTom traffic, Google Maps/3D
  tiles, Cesium ion, Vaisala/Xweather lightning.

No provider is a global single point of failure. A provider that requires a
key declares `PUBLIC_ACCOUNT` / `API_KEY` access and reports
`unavailable: credentials absent` honestly — it is never bypassed.

---

## 7. Attribution & licensing

- Adapted source retains the **MIT** header: `Copyright (c) 2026 Bilawal
  Sidhu`. A `NOTICE` block is prepended to every adopted file under
  `apps/console/renderer/views/mataDewa/lib/`.
- Provider/data attribution uses the adopted `dataCredits.js` mechanism →
  Cesium's credit lightbox (required by ODbL / provider ToS).
- Material adopted source paths are tracked in §3.1. Excluded data
  (TeleGeography cables CC BY-NC-SA, third-party GLB models) is listed in §3.4.

---

## 8. What this document is not

This is an adoption boundary map, not a runtime design. Runtime design lives
with the code (`src/mataDewa/**`) and the capability mapping
(`docs/architecture/MATA-DEWA-CAPABILITY-MAP.md`). Final Lane 5 certification
is deferred until the latest certified `develop` is integrated and an
independent audit runs — see the Lane 5 brief's Parallel Merge Rule.
