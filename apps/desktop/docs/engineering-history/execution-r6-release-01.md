# R6 release engineering 01: DAMAR v1 Windows release

Date: 2026-11-21/22. Candidate: `D:\Damar\R9_WORK\candidate\damar-cli-single-product-01` (R). Canonical `C:\Workspace\Damar` was read only and never edited. No Git operations, uploads or publishing.

## Installer choice
- None of Inno Setup, WiX or NSIS was installed, and there is no .NET SDK. I chose **Inno Setup 6.7.1**, taken from the nuget `tools.innosetup` package and unzipped into `R/.release-tools`. Nothing was installed and no admin was needed. The package is pinned by SHA-256.
- The **Python runtime** is CPython 3.12.10 from the nuget `python` package (PSF-signed, pinned SHA-256). It is the full layout without `include`, `libs`, `pip` or `ensurepip`, ships as `runtime/python`, and does not read the registry (sys.path checked).
- The **Electron runtime** is only `src/presence/node_modules/electron/dist`, shipped as `runtime/electron`. No electron-builder.

## Build
```
node scripts/release/build-release.cjs            # [--skip-installer] [--skip-zip]; DAMAR_VERSION=1.0.0 default
powershell -File scripts/release/smoke-release.ps1 -Setup dist\DAMAR-Setup-1.0.0-UNSIGNED.exe -Work <empty dir>
```
New files: `scripts/release/build-release.cjs`, `scripts/release/smoke-release.ps1`, `release/` (`damar.cjs` launcher, `damar.cmd`, `gui-launch/` windowless Electron shortcut target, `installer/damar.iss`, `docs/` public docs and screenshots, `licenses/` with the Cinzel OFL and Node.js v24.19.0 license texts), and `.graphifyignore` (`dist/`, `.release-tools/`). `dist/` is not matched by the `tests/*.test.cjs` glob.

## Artifacts (R/dist)
| File | Bytes | SHA-256 |
|---|---|---|
| DAMAR-Setup-1.0.0-UNSIGNED.exe | 119,986,038 | 931a305f3e50318dd0da06cd89887b25e3321a9aa33b46bad28fdb7cf16cd22f |
| DAMAR-1.0.0-portable-win-x64-UNSIGNED.zip | 169,551,563 | 9f81b6f225efd7ec7111327bd3659f514ece3d5e480a26c5c62c12c534de61f6 |

The same folder also holds:
- `DAMAR-1.0.0-MANIFEST.json` and `DAMAR-1.0.0-SHA256SUMS.txt`: 5,438 files, 403.2 MiB, aggregate `540a2596abaaaba4…`. `MANIFEST.json` is also installed into `{app}`.
- `DAMAR-1.0.0-sbom.cdx.json` (CycloneDX 1.5) and `THIRD_PARTY_LICENSES.txt` (also shipped).
- `scan-report.json`, `REPRODUCIBILITY.md`, `build-report.json`, `SHA256SUMS.txt`, `UNSIGNED-README.txt`, `build.log` and `stage/DAMAR` (the exact ship set).

## Installer behaviour
- Installs per user to `%LOCALAPPDATA%\Programs\DAMAR` with `PrivilegesRequired=lowest`.
- Start menu `DAMAR\` gets DAMAR CLI (`damar.cmd`, working directory = user folder), DAMAR Control and DAMAR Presence (both go through `electron.exe release\gui-launch`, so no console window flashes), and Documentation.
- Optional tasks: **addpath** (on by default) adds `{app}` to the HKCU PATH and is removed on uninstall. **autostart** (off by default) adds an HKCU Run entry for Presence.
- Upgrade in place: `PrepareToInstall` runs the old `damar shutdown`, and `[InstallDelete]` replaces the program folders wholesale.
- Uninstall: runs `damar shutdown`, then asks "Also remove your DAMAR data?", default **No**. A silent uninstall keeps data unless `/PURGE` is given.
- `/DAMARSMOKE` is a test-only switch: no shortcuts, no ARP key, no PATH or Run changes.
- Ship set excludes `tests`, `evidence`, `.sw-factory`, `graphify-out`, all of `scripts/` (including `scripts/owner/**`; the build fails with `SCRIPTS_IN_SHIP_SET` if any appear), `__pycache__`, `*.pyc`, `*.jsonl`, `credentials*.json`, `session.json`, `core-host.json`, `src/core-host/windows-authority` (optional C# service), `START_DAMAR_CORE.ps1`, internal `docs/` (only `KEYBINDINGS.md` ships), and `inherited-v53/{cc2,ui-prototypes,scripts except r7r3-recover.cjs,PRIVATE_README,package-inventory}`.
- Product launcher (`release/damar.cjs`):
  - Data root is `%LOCALAPPDATA%\DAMAR`: `sessions\core-*`, `profile`, `logs\core.log`, `run`, `state`.
  - A hidden supervisor owns one Core and is stopped through a stop-file that becomes IPC `R7R3_STOP`. No force-kill.
  - Startup picks one of three paths: resume if `FINISHED.json` exists, recover (`--recover-from`) after a crash, or a fresh session. A recovery that never reaches READY falls back to a fresh session next time.
  - The bundled Python goes first on PATH, and `NODE_OPTIONS`/`DAMAR_TOKEN` are stripped.
  - The development root `damar.cmd` is replaced in the ship set by the product `damar.cmd`, so Presence's CLI button works.

## Core changes (backward compatible; other agents also edit core-host.cjs)
Core was hard-wired to `D:/Damar/R9_WORK/r7r3-scratch`, which blocked any installed product. New env `DAMAR_DATA_ROOT` (absolute) replaces that root. When it is unset, behaviour is unchanged.
- `src/core-host/core-host.cjs`
  - ~L12-14: `DATA_ROOT` const; `SCRATCH = DATA_ROOT || 'D:/…/r7r3-scratch'`.
  - ~L40: `cleanEnvironment` forwards `DAMAR_DATA_ROOT` to the child.
  - ~L285: `PROTECTED` gains `...(DATA_ROOT ? [DATA_ROOT] : [])`, so the agent can never read tokens or keys in the data root.
  - ~L314: the default sandbox registry is `DATA_ROOT/damar-sandbox-registry.jsonl` when set.
  - ~L389: the startup `run.catch` now calls `if (process.connected) process.disconnect();`. **Bug fix:** a child whose startup failed kept its IPC channel open and never exited, so the parent and supervisor hung forever (seen in smoke 1 with `PROVIDER_ID_INVALID` from a mid-refactor build).
- `inherited-v53/src/r7r3/launcher.cjs` L12 and `inherited-v53/scripts/r7r3-recover.cjs` L6: same `DAMAR_DATA_ROOT` fallback expression.

## Signing
- Configured through environment variables:
  - `DAMAR_SIGN_PFX` (+ `DAMAR_SIGN_PFX_PASSWORD`) or `DAMAR_SIGN_THUMBPRINT`: signtool with SHA-256 and RFC 3161 timestamp.
  - `DAMAR_AZURE_DLIB` + `DAMAR_AZURE_METADATA`: Azure Trusted Signing via signtool `/dlib /dmdf`.
  - `DAMAR_SIGNTOOL` and `DAMAR_SIGN_TIMESTAMP_URL` are optional.
- Inno signs both the setup and the uninstaller (`SignTool=damarsign`, `SignedUninstaller=yes`). The build then verifies with `signtool verify /pa` plus `Get-AuthenticodeSignature`, and fails on mismatch.
- **Status: UNSIGNED.** No certificate is configured, the artifacts carry the `-UNSIGNED` suffix and `UNSIGNED-README.txt`, and `Get-AuthenticodeSignature` reports NotSigned.
- **signtool.exe is not installed** on this machine (no Windows SDK), so the signing path was not executed end to end.
- Vendor binaries: `node.exe` Valid (OpenJS), `python.exe`/`pythonw.exe` Valid (PSF), **`electron.exe` NotSigned**.

## SBOM and licenses
- 107 components: npm 93 MIT, 5 ISC, 2 BSD-2, 2 BSD-3, plus 2 PyPI "MIT License"; PSF-2.0 (CPython); OFL-1.1 ×2 (Cinzel and Cinzel Decorative); Node.js MIT; Electron MIT (Chromium notices in `LICENSES.chromium.html`); Coucou MIT (source only); God's Eye View MIT.
- No copyleft or incompatible license was detected. License findings: 0.
- DAMAR's own license is MIT, "Copyright (c) 2026 Maronns-Dev" (`inherited-v53/LICENSE`, identical in canonical). It ships as `LICENSE.txt`.
- The build adds any `ffmpeg*`, `.onnx`, `.tflite`, `.pt` or `.weights` file to the SBOM as license=UNDECLARED with a review note, so the Mata Dewa CCTV/ALPR dependencies will be flagged automatically when they land. None are present today.
- **Flags / blockers (owners):**
  1. **Presence (presence agent):** the Owner must confirm that the "Damar Notch" art is independent of Coucou's Mochi. The character art was renamed to `damar_notch_hero*.png` (no Mochi filenames or strings in the ship set now), but `inherited-v53/package-inventory.json` (not shipped) still says `HOLD_RESTRICTED_ARGON_ART_AND_NOTICE_REVIEW`. Until this is resolved, the asset provenance is unclear.
  2. **Presence:** the Cinzel `.ttf` files ship without an adjacent `OFL.txt`. The OFL text is included in `THIRD_PARTY_LICENSES.txt`, which satisfies the license, but adding `OFL.txt` next to the fonts is recommended.
  3. `electron.exe` is unsigned upstream. It will be flagged by SmartScreen and AV heuristics. Consider signing it with the DAMAR certificate.
  4. Mata Dewa: the Open-Meteo free tier is **non-commercial** (runtime data, not bundled). This is acceptable for a free product, but a commercial offering needs a paid plan. CCTV/ALPR and military ADS-B features have not landed and will need a privacy and legal review per jurisdiction.

## Ship-set scan (dist/scan-report.json)
- **Secrets: 0.** There are 10 reviewed false positives (dotenv README example key and the prototype `damar.py` redaction self-test strings), allowlisted by exact file and text.
- **Mochi: 0.**
- **Private router (release blocker, 41 hits; not fixed, owned by others):**
  - `src/core-host/provider-registry.cjs` L55/58: `LEGACY_ROUTER ninerouter localhost:20127`.
  - `inherited-v53/src/r7r3/endpoint.cjs`: gateway `http://localhost:20127/v1`, used by core-host as the default `custom` baseUrl.
  - `inherited-v53/src/r7r3/control-v2.html` ×17 and `control-v2.js`: legacy UI still served at `/cc2` and `/uix/*`.
  - `prototype-w5-cli/20261114-000108/damar.py` ×7.
  - core-snapshot (canonical): `AIProviderFactory.js`, `providerConfigService.js` ×2, `cognition/*` ×10.
- **Personal / dev paths (27):**
  - Presence: `idle_present.html` ×4 and `presence-i18n.js` ×2 hard-code the Owner's name ("Good morning, Maronns.", "Ya, Maronns…"). **Blocker for public release.** `core-presence.cjs` L34 has a default profile under `D:\Damar\R9_WORK`.
  - Core-host: `core-host.cjs` keeps the dev defaults `D:/Damar/R9_WORK` and `C:/Workspace/*` in PROTECTED (harmless, but visible). The inherited launcher and recover scripts keep the dev default.
  - Root: `RUN_DAMAR_CLI.ps1` has a default `-UiProfile` under `D:\Damar\R9_WORK`. The product launcher always passes `-Profile`; the dev default was left unchanged.
  - Canonical snapshot: `package.json` repository/homepage `github.com/jrxid09-design/Aether` (Owner GitHub handle), the `mataDewa/providers/http.js` User-Agent with the same URL, and contract-path comments `C:\Workspace\…`.
  - Mata Dewa: `THIRD_PARTY_NOTICES.md` and `FEATURE_MATRIX.md` cite `C:/Workspace/Damar/…`. This text is also reproduced in `THIRD_PARTY_LICENSES.txt`.
  - I removed none of these because they are all in files owned by other agents or the canonical snapshot. Every file I own is clean.
- **Screenshots:** README uses `control-overview` and `control-security` only. `control-providers` shows "NineRouter", and the presence screenshots show the unresolved character art or the Owner's name, so none of those were used.

## Clean-machine smoke
`scripts/release/smoke-release.ps1`, final run **smoke3: 26/26 PASS**. The report is at `dist/smoke-report.json`.

Setup:
- Fake `LOCALAPPDATA`, `APPDATA` and `USERPROFILE` in the scratchpad.
- PATH limited to System32 only (no system Python or Node resolvable).
- `/DIR` throwaway install with `/DAMARSMOKE`.
- My own Core on port 29650. No other Core or process was touched; the only processes killed were my own.

Steps covered:
- Per-user silent install, and all 5,438 manifest hashes verified on disk.
- Real profile untouched: no ARP key, Start-menu entry or PATH change.
- `damar --help` and `damar version`.
- Bundled Python 3.12.10 imports rich, pygments, markdown_it and mdurl from the install. CLI `--help` runs with the bundled Node.
- `damar core start` reaches READY in about 2 s. `core status` works and all data lands in the fake `LOCALAPPDATA`.
- CLI one-shot `--command status` sees Core online, and `damar sessions` works.
- Core found the bundled Python, so the AppContainer sandbox is available.
- Control `/control/`: 200 with strict CSP, plus `control.js`, `control.css`, icon and `views/mata-dewa.js`.
- `damar control --print` produces a fragment-only credential URL. An Owner-token API call is accepted and an anonymous one is refused.
- Legacy `/cc2`, `/__r6`, `/uix` requests do not crash Core.
- Presence self-test with the bundled Electron: nodeIntegration=false, contextIsolation, sandbox, webSecurity.
- Clean stop writes `FINISHED.json`, and the next start resumes the same session.
- Killing my own Core tree, then starting again, recovers into a new identity.
- Upgrade in place while Core runs: setup stopped Core and the new Core came up ready.
- Uninstall removes the program, keeps the data, and leaves Core stopped.
- Reinstall, then uninstall with `/PURGE`, removes the data.

Earlier runs:
- **smoke1** failed: the Core child died with `PROVIDER_ID_INVALID` from a mid-refactor provider build, then hung. That led to the IPC disconnect fix in core-host.cjs; a rebuild resolved the error.
- **smoke2** had one false negative: the regex in my sandbox check matched the word "unavailable" in the success text. The check was fixed.

## Test suite
Command, from R: `node --test --test-concurrency=1 --test-reporter=tap` over the 71 `tests/*.test.cjs` files except `computer-use.test.cjs`. Output is in `dist/test-run.tap`.

**Result: 352 tests, 347 pass, 5 fail, 0 cancelled.**

All 5 failures are in `tests/presence-core.test.cjs`:
- `idle Core: reachable, READY, nothing pending; settings from Core equal the prototype defaults`
- `session + turn with a permission request -> Presence sees it; redacted activity feed; requester can never decide`
- `notch decision: Owner token from main (no CLI lease), first decision wins, the CLI stream sees the answer`
- `Control changes presence.* in Core -> Presence applies it live without restart`
- `Electron host against this Core: security flags, no network from renderer, demo-free, lifecycle timing in a real renderer`

Cause: `before` hook `CORE_EXIT_1`. The test hard-codes port 29642, and during the run that port was held by another agent's concurrent presence-test Core (PIDs 13580, then 16636, scratch `presence-test-1795285456217`; not touched). The failures are environmental, not caused by the release changes. Rerun that file when 29642 is free.

`graphify update .` was run in R: 21,545 nodes, 44,406 edges, 1,057 communities.

## Remaining risks for a public international launch
1. **Blockers owned by others:**
   - The private router default and strings (provider agent refactor in progress).
   - The Owner's name hard-coded in the Presence UI.
   - Clearance of the Notch character art.
   - Legacy inherited control surfaces (`/cc2`, `/uix/*`, `/__r6/*`) still mounted. They contain router references; they are served on loopback and did not crash Core in the smoke.
2. **No code signing.** SmartScreen will warn on the installer, and `electron.exe` is unsigned upstream. Signtool and the Windows SDK must be installed on the signing machine.
3. **CLI defaults to Indonesian.** International users must type `language en`. The CLI owner should default to English or follow the OS locale.
4. **Core data-root write guard** refuses junctions and 8.3 or redirected path components (`realpath` must equal the path). Profiles with a redirected or junctioned `%LOCALAPPDATA%` will fail to start Core. This is documented in TROUBLESHOOTING.
5. **Core copies the ~20 MB canonical snapshot** into every new Core session directory, and session directories accumulate under `%LOCALAPPDATA%\DAMAR\sessions` with no pruning.
6. **Core forces `NODE_ENV=test`** in its child (inherited). This should be reviewed before GA.
7. **No auto-update or update-signature verification** in v1. Updating means running a newer installer, and rollback means running the previous installer (offline, data kept). Users verify downloads with `SHA256SUMS.txt`, or with the signature once one exists. There is no support channel or security contact address yet, so SECURITY.md says "report privately to the maintainers". The Owner must supply one.
8. **Inno Setup has no Indonesian translation** among its official languages. The installer is English only; Indonesian was optional.
9. **Installer and zip are not byte-reproducible** (embedded timestamps). Content reproducibility is via the manifest (`REPRODUCIBILITY.md`).
10. **Untested paths:**
    - The real HKCU PATH and Start-menu entries were not exercised (to keep the real profile untouched). PATH add/remove is Inno Pascal code that was reviewed but not run.
    - The GUI shortcuts (`gui-launch`) were not clicked in the smoke.
    - No interactive CLI turn with a live provider (no inference authorized).
