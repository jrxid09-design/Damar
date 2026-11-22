# Mata Dewa feature matrix against God's Eye View

Revised in round 4, 2026-11-22. Owner decisions recorded on 2026-11-21:
- open Core egress is the default;
- military aircraft are shown;
- CCTV and ALPR are allowed on the Owner's own cameras;
- public release targets commercial-safe defaults.

The capability list comes from the gods-eye-view README ("What's on the Globe", 23 layers), its API-key section and DATA_SOURCES.md. DAMAR code is in `src/mata-dewa/` (Core) and `src/control/views/mata-dewa.js` (Control). The "Earlier DAMAR code" column names the corresponding module in DAMAR's earlier Mata Dewa provider set.

Status values:

- **default**: keyless, on by default, commercial-compatible terms.
- **v1**: keyless, optional.
- **v1-key**: implemented. The Owner adds their own key in Control; it is stored with DPAPI and never read back.
- **out**: out of scope, with the reason given.

The "Commercial" column is a summary of the source's terms, not legal advice.

| # | GEV capability | DAMAR feed or route | Source host | Key | Rate limit (DAMAR floor) | Licence | Commercial | Earlier DAMAR code | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Earthquakes | `earthquakes` | earthquake.usgs.gov | none | ≥ 60 s | US public domain | yes | usgs provider | **default** |
| 2 | Weather / wind | `weather` (MET Norway Locationforecast 2.0) | api.met.no | none; identifying User-Agent | ≥ 600 s, cached | CC BY 4.0 / NLOD 2.0 | yes | openMeteo provider (replaced) | **default** |
| 3 | Cyclones and disasters (all basins incl. western Pacific) | `disasters` (GDACS: TC, EQ, FL, VO, DR, WF) | www.gdacs.org | none | ≥ 600 s | GDACS terms; EC JRC reuse policy (CC BY 4.0) unless stated | likely; confirm with JRC before a commercial release | — | **default** |
| 4 | Satellites | `satellites` (one CelesTrak group; mean elements) | celestrak.org | none | ≥ 2 h | public; citation | yes | celestrak provider | **default** |
| 5 | Space launches | `launches` | ll.thespacedevs.com | none | ≥ 600 s; 15/h | TSD terms | yes | — | **default** |
| 6 | Live flights | `flights` (area) | api.adsb.lol | none | ≥ 30 s, ≤ 250 nm | ODbL 1.0 | yes (ODbL) | adsbLol provider | **v1** |
| 7 | Military flights | `military` (worldwide) | api.adsb.lol | none | ≥ 60 s | ODbL 1.0 | yes (ODbL) | — | **v1** |
| 8 | Cyclones (NHC/CPHC) | `cyclones` | www.nhc.noaa.gov | none | ≥ 300 s | US public domain | yes | — | **v1** (Atlantic and E/C Pacific; GDACS covers all basins) |
| 9 | Weather (Open-Meteo) | `openMeteo` | api.open-meteo.com | none | ≥ 600 s | CC BY 4.0 data | **no** (free API) | openMeteo provider | **v1**, labelled non-commercial |
| 10 | Air quality (model) | `airQuality` | air-quality-api.open-meteo.com | none | ≥ 900 s | CC BY 4.0, CAMS | **no** (free API) | — | **v1**, labelled non-commercial |
| 11 | Air quality (measured) | `openaq` (nearest station within 25 km) | api.openaq.org | OpenAQ key (free) | ≥ 900 s; 60/min | per provider, mostly CC BY 4.0 | per provider | — | **v1-key** |
| 12 | Flights via OpenSky | `opensky` | auth.opensky-network.org, opensky-network.org | client ID and secret | ≥ 60 s | OpenSky terms | **no** | keyed provider | **v1-key**, labelled non-commercial |
| 13 | Live vessels (AIS) | `vessels` | stream.aisstream.io (wss) | AISStream key | ≥ 120 s | beta, no terms | unclear | keyed provider | **v1-key** |
| 14 | Active fires | `fires` | firms.modaps.eosdis.nasa.gov | FIRMS MAP_KEY | ≥ 600 s | NASA open data | yes | keyed provider | **v1-key** |
| 15 | Traffic flow | `traffic` | api.tomtom.com | TomTom key | ≥ 120 s | TomTom terms | per plan | keyed provider | **v1-key** |
| 16 | CCTV: official public cameras | `/cameras/public/{tfl-london, fintraffic}?q=&page=` (server-side search, 24 per page; latest still only) | api.tfl.gov.uk; s3-eu-west-1.amazonaws.com (path `/jamcams.tfl.gov.uk/` only); tie.digitraffic.fi; weathercam.digitraffic.fi | none | list 6 h, still 60 s | TfL Open Data terms; Fintraffic CC BY 4.0 | TfL: per its terms; Fintraffic: yes | cctv media (concept) | **v1** (regions chosen by the Owner; no ALPR) |
| 17 | Owner's own cameras | `/cameras`, `/cameras/own/<id>/frame` | Owner-registered URL only (LAN allowed; loopback and link-local refused) | camera credentials (DPAPI) | on demand | — | — | cctv media | **v1**: HTTP snapshot or MJPEG with Basic or Digest (MD5 / SHA-256, sent only after a 401 challenge); RTSP via optional ffmpeg (credentials go in a one-shot private ffconcat file, never on the command line) |
| 18 | ALPR | `/alpr`: log, crops, watchlist, alerts, export, delete, install-engine | local only; install downloads from pypi.org, files.pythonhosted.org, github.com and GitHub asset hosts | — | scan interval ≥ 5 s | fast-alpr 0.4.0 stack (MIT); weights need a provenance review | see THIRD_PARTY_NOTICES | — | **v1**: Owner cameras only, after the CCTV and ALPR notices; engine installed on demand |
| 19 | Mapped ALPR camera locations (OSM / DeFlock) | — | — | — | — | — | — | — | **out**: maps other people's surveillance devices |
| 20 | Map stack (Esri / Google 3D / Cesium) | — | tile CDNs | keys | — | — | — | — | **out**: Control CSP allows same-origin only; SVG plot instead |
| 21 | Ask the planet (voice + AI) | — | OpenAI | metered | — | — | — | — | **out**: no paid LLM inference |
| 22 | GNSS integrity | — | — | — | — | — | — | — | **out**: anomalies are easily misread as interference |
| 23 | Fire perimeters (WFIGS) | — | — | — | — | — | — | — | **out**: US only; FIRMS and GDACS wildfires cover fires worldwide |
| 24 | News / conflicts | — | — | — | — | — | — | — | **out**: not observational |
| 25 | Street-level imagery | — | — | — | — | — | — | — | **out**: imagery of people and property |
| 26 | Radio | — | — | — | — | — | — | — | **out**: audio streaming |
| 27 | Transit / rail / bikeshare | — | 30+ hosts | — | — | — | — | — | **out**: dozens of hosts |
| 28 | Directions | — | — | — | — | — | — | osrm provider | **out** for now |
| 29 | OSM places | — | — | — | — | — | — | osm provider | **out**: needs a self-hosted Overpass |
| 30 | Mapped military installations | — | — | — | — | — | — | — | **out** |
| 31 | Restricted airspace (FAA SUA) | — | — | — | — | — | — | — | **out**: US only |
| 32 | Wildlife sightings | — | — | — | — | — | — | — | **out**: sensitive-species locations |
| 33 | Observed weather tiles | — | — | — | — | — | — | — | **out**: imagery tiles |
| 34 | Cockpit / 3D / reconstructions | — | — | — | — | — | — | — | **out** |
| 35 | Local ADS-B / SDR | — | hardware | — | — | — | — | rf modules | **out**: no RF sensing is claimed |
| 36 | Bundled datasets | — | — | — | — | — | — | — | **out**: not copied (TeleGeography is CC BY-NC-SA) |

## Egress

**Mata Dewa's own allowlist** (`src/mata-dewa/egress.cjs` `HOSTS`). The same list is passed to Core's loopback guard when `DAMAR_EGRESS=loopback`.

- `earthquake.usgs.gov`
- `api.open-meteo.com`
- `air-quality-api.open-meteo.com`
- `api.adsb.lol`
- `celestrak.org`
- `ll.thespacedevs.com`
- `www.nhc.noaa.gov`
- `opensky-network.org`
- `auth.opensky-network.org`
- `stream.aisstream.io`
- `firms.modaps.eosdis.nasa.gov`
- `api.tomtom.com`
- `api.tfl.gov.uk`
- `s3-eu-west-1.amazonaws.com` (path `/jamcams.tfl.gov.uk/` only)
- `tie.digitraffic.fi`
- `weathercam.digitraffic.fi`
- `api.met.no`
- `www.gdacs.org`
- `api.openaq.org`

Every public fetch applies these rules:

- HTTPS on port 443 only
- exact host match
- the resolved address must be public
- no redirects
- deadline and streamed byte caps, also applied after gzip decoding
- errors carry codes only

**User-Agent.** Requests send `DAMAR/1.0`. When the Owner sets a contact URL in Control (`mataDewa.contactUrl`: https:// or mailto:, empty by default), it becomes `DAMAR/1.0 (+<contact URL>)`. No personal or repository identifiers are sent.

**ALPR install.** The install step reaches the following hosts, and only when the Owner clicks "Install ALPR engine":

- `pypi.org`
- `files.pythonhosted.org`
- `github.com`
- `objects.githubusercontent.com`
- `release-assets.githubusercontent.com`

This runs in the Python child process; the `DAMAR_EGRESS=loopback` socket guard covers only the Core process.

## Privacy rules

- **Aircraft** are shown with full public identifiers. LADD and PIA aircraft are withheld. OpenSky has no such flag.
- **Vessels**: identifiers are kept only for commercial or service AIS ship types.
- **Public cameras**: the latest still only, never recorded, never used for ALPR.
- **ALPR**:
  - Owner cameras only, after both notices are accepted
  - processing is local
  - retention defaults to 30 days
  - export and delete are available
  - no plate-to-owner lookups
  - watchlist alerts reach `GET /api/r9/activity` as kind `alert`; the requester sees the camera label only, the Owner also sees the plate

## Verification (2026-11-22, this PC)

**ALPR (real engine).** fast-alpr 0.4.0 with `yolo-v9-t-384-license-plate-end2end` and `cct-xs-v2-global-model`, CPU, installed by the Owner action into `%LOCALAPPDATA%\DAMAR\alpr`. Tested on 13 plate images: 3 public domain, 1 CC0, 8 CC BY-SA 3.0/4.0 from Wikimedia Commons, and 1 synthetic.

| Measure | Result |
|---|---|
| Plates detected | 12 of 13 |
| Exact reads | 11 of 13 |
| Character accuracy | 91.4 % |
| Time per image | ~25–100 ms (first call ~0.5 s, model load) |

The two errors: Dutch `08-54-UB` was not detected, and California `7B 82 644` was read as `7BB2644`. These are mostly close-up plate photos, so camera scenes (distance, angle, night) will score lower. The CC0 and public-domain images are kept as fixtures, and `tests/mata-dewa-cameras.test.cjs` asserts their exact reads whenever the engine is installed.

**RTSP.** Tested end to end with ffmpeg 9.1 (Gyan full build; GPL, never bundled) against a loopback RTSP test camera (`tests/mata-dewa-rtsp-server.cjs`):

- Digest auth succeeds.
- Only TCP-interleaved SETUP requests are made (the ffconcat `option rtsp_transport tcp` line is honoured).
- No credentials appear in ffmpeg's command line, and the one-shot credential file is removed.
- A wrong password returns no frame.
- The product default still refuses loopback.
- The full chain RTSP → ffmpeg → real ALPR → log entry with crop → watchlist alert passes (`tests/mata-dewa-rtsp.test.cjs`).
