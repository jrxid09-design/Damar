# Third-party notices: Mata Dewa

## God's Eye View

- Source: <https://github.com/bilawalsidhu/gods-eye-view> (shallow clone read on 2026-11-21; none of its scripts were run)
- Author: Copyright (c) 2026 Bilawal Sidhu
- License: MIT for source code only. Its LICENSE says the MIT grant does not cover third-party data or bundled datasets.
- What DAMAR took from it: the capability list (layers and data sources) in `FEATURE_MATRIX.md`, and small request and normalisation details adapted in `feeds.cjs`:
  - the Open-Meteo `current=` field selection for weather,
  - the Launch Library 2 `2.3.0/launches` request and its 15-calls-per-hour budget,
  - the adsb.lol point-API request shape and its 250 nm radius cap,
  - the CelesTrak `gp.php?GROUP=…&FORMAT=tle` request.
- No God's Eye View file was copied verbatim. No bundled dataset was copied: the TeleGeography cables (CC BY-NC-SA), ALPR, CCTV, Wikidata, Natural Earth and UCS datasets are all excluded.

MIT License text, as the MIT terms require:

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime data sources

These sources are fetched at runtime and never bundled. Each keeps its own terms. Control shows each source's attribution and a commercial-use note.

| Feed | Source | Terms | Attribution shown | Commercial use |
|---|---|---|---|---|
| earthquakes (default) | USGS | U.S. public domain | USGS Earthquake Hazards Program | yes |
| weather (default) | MET Norway Locationforecast 2.0 | CC BY 4.0 / NLOD 2.0; identifying User-Agent required | Data from MET Norway | yes |
| disasters (default) | GDACS (UN, EC JRC) | GDACS terms; JRC content under EC reuse policy (CC BY 4.0) unless stated | GDACS | likely, confirm |
| satellites (default) | CelesTrak | public data, citation requested | CelesTrak (T.S. Kelso) | yes |
| launches (default) | The Space Devs Launch Library 2 | TSD terms, attribution encouraged | Launch Library 2 — The Space Devs | yes |
| flights, military | adsb.lol | ODbL 1.0 | adsb.lol contributors | yes (ODbL) |
| cyclones | NOAA/NWS NHC & CPHC | U.S. public domain | NOAA/NWS NHC / CPHC | yes |
| openMeteo, airQuality | Open-Meteo (CAMS) | CC BY 4.0 data; free API non-commercial | Open-Meteo.com | **no** (paid plan needed) |
| openaq (Owner key) | OpenAQ v3 | OpenAQ terms; per-provider data licences (mostly CC BY 4.0) | OpenAQ and data providers | per provider |
| opensky (Owner key) | OpenSky Network | non-commercial terms | The OpenSky Network | **no** |
| vessels (Owner key) | AISStream.io | beta, no formal terms | AISStream.io | unclear |
| fires (Owner key) | NASA FIRMS | NASA open data, citation requested | NASA FIRMS (LANCE/EOSDIS) | yes |
| traffic (Owner key) | TomTom Traffic API | TomTom terms | © TomTom | per plan |
| public cameras | TfL JamCams | TfL Open Data terms (OGL v2 based) | Powered by TfL Open Data | per TfL terms |
| public cameras | Fintraffic weather cameras (digitraffic.fi) | CC BY 4.0 | Fintraffic / digitraffic.fi | yes |

## Optional local components (installed on demand, never bundled)

**ALPR engine.** It is installed only by the Owner's "Install ALPR engine" action in Control, into `%LOCALAPPDATA%\DAMAR\alpr` (override with `DAMAR_ALPR_DIR`). Pinned versions:

| Package | Version | Licence |
|---|---|---|
| fast-alpr | 0.4.0 | MIT |
| fast-plate-ocr | 1.1.0 | MIT |
| open-image-models | 0.6.0 | MIT |
| onnxruntime | 1.32.0 | MIT |
| opencv-python-headless | 5.1.0.95 | Apache-2.0; its bundled third-party notices are in LICENSE-3RD-PARTY.txt |
| numpy | 2.4.6 | BSD-3-Clause |

**Model weights.** These are downloaded on install from the GitHub releases of their MIT-licensed repositories:
- `yolo-v9-t-384-license-plate-end2end`, from ankandrew/open-image-models
- `cct-xs-v2-global-model`, from ankandrew/cnn-ocr-lp

The weights carry no separate licence file. Two provenance questions are open, so **public commercial redistribution of the weights needs a legal review**:
- The detector is a YOLOv9 model. The upstream YOLOv9 training code (WongKinYiu/yolov9) is GPL-3.0.
- The training datasets are not documented.

Downloading on demand from upstream, as DAMAR does, avoids redistributing the weights.

**ffmpeg** (LGPL or GPL, depending on the build). It is found on PATH and used only for one-frame RTSP capture. It is not bundled; any bundling needs a licence review first.

DAMAR source reused: the feed normalisers come from DAMAR's earlier Mata Dewa providers (same project, no third-party licence).
