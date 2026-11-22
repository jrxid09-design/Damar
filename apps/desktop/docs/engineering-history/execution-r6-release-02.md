# R6 release engineering 02: coordinator follow-ups

Date: 2026-11-22. This builds on `execution-r6-release-01.md`. The Notch art flag is dropped: the Owner confirmed provenance in `src/presence/renderer/argon-assets/LICENSE-ASSETS.md`. No Git operations, uploads or publishing.

## What changed per item

**(1) Old inherited control pages retired.**
- `core-host.cjs` L21 adds `LEGACY_UI = /^\/(cc2|uix|__r6|__preview-adapters|s|mobile)(\/|$|\?)/` plus a `retired()` helper that answers 404 `LEGACY_SURFACE_RETIRED`.
- The check runs in both the boot-phase handler (L211) and the main handler (L378, after `/control/`). It runs before the inherited listeners, so `/cc2`, `/uix/*`, `/__r6/*`, `/__preview-adapters/*`, `/s/*` and `/mobile` are never served, in dev or product.
- The inherited `r5`/`r6`/`r7` modules still load, because the launcher requires them.
- Ship set: `inherited-v53/src/r7r3/{control,control-v2}.{html,js,css}`, `mobile.js` and `presence.js` are no longer shipped. Our `src/control` is unchanged.
- No test used these routes. Presence's own renderer still contains a `/cc2?r9r2-demo=1` navigation (`idle_present.html` ~L2191, inside its custom scheme). That one is for the presence owner.

**(2) NODE_ENV.**
- Audit: in core-snapshot/src, `NODE_ENV` is only printed in banners and reported as `config.environment` (telemetry/system info). It is allow-listed in sandbox env shims.
- `canonicalRuntimeComposition`'s test seam keys on a global Symbol, not `NODE_ENV`.
- Express: in `test` it suppresses error stack logging, and in `production` finalhandler hides stack traces from HTTP error bodies. Both are acceptable or better in production.
- The only hard dependency is core-host's own fixture gate (`FIXTURES_REQUIRE_ISOLATED_TEST_ENVIRONMENT`).
- Change, `core-host.cjs` L42: `NODE_ENV: DAMAR_CORE_TEST_FIXTURES === '1' ? 'test' : 'production'`. Fixture Cores (the tests) keep `test`.

**(3) Session retention.** In `release/damar.cjs`, `pruneSessions()` runs after Core reports READY.
- It keeps the newest `DAMAR_KEEP_SESSIONS` (default 5, range 1–1000) `core-YYYYMMDD-HHMMSS` folders, counting the active one.
- It deletes only older folders that stopped cleanly (`FINISHED.json`), were already recovered from (recorded in `state/recovered.json`), or never started.
- It never deletes the active folder or a crashed folder that has not been recovered.
- Errors are logged (`PRUNE_SKIPPED`) and never affect Core.

**(4) Redirected or junctioned `%LOCALAPPDATA%`.**
- The refusal is a real need *inside* the data root. The inherited `outputGuard` stops Core being redirected by a junction or symlink planted inside its scratch tree, because the guard is the only thing confining Core's writes.
- The refusal is *not* a real need for the user's own profile folders above the data root.
- Fix, in the launcher only:
  - The launcher resolves `%LOCALAPPDATA%\DAMAR` with `fs.realpathSync.native`, which also expands 8.3 names, and passes that real path as `DAMAR_DATA_ROOT`.
  - On a first run where the folder did not exist yet, it creates it and relaunches once.
  - It now also passes `DAMAR_KEY_STORE` (`<data>\provider-keys`) and `DAMAR_WITNESS_DIR` (`<data>\authority`) explicitly. Before, Core derived them from the non-real `LOCALAPPDATA`. The live-inference usage ledger therefore now lives in `provider-keys\`; SECURITY.md is updated.
- The guard still applies to every path inside the data root.
- The smoke now runs entirely with `LOCALAPPDATA` as a junction.

**(5) Signed Electron.**
- Upstream Electron 30.5.1 Windows binaries are **not Authenticode-signed**. The official release zip that the npm package installs yields `electron.exe` with status NotSigned. Electron expects apps to sign their own copy.
- When a DAMAR signing certificate is configured, `build-release.cjs` now signs the redistributed `runtime/electron/electron.exe` before the manifest is made.
- Unsigned builds document it (see run 01).

**(6) Update check.**
- `damar update check` fetches `<url>` (a JSON manifest) and `<url>.sig` (a base64 Ed25519 signature over the exact bytes).
- It verifies against the public key baked into `release/update.json`. It requires https, `product=DAMAR`, an X.Y.Z version, an https installer URL and a sha256, then prints whether an update exists plus the URL and hash. It never downloads or installs anything.
- No URL or key configured means disabled, which is the default: `update.json` is `{url:null, publicKey:null}`. `DAMAR_UPDATE_URL` can override the URL.
- Build-side variables:
  - `DAMAR_UPDATE_PUBLIC_KEY` plus `DAMAR_UPDATE_URL` bake the configuration.
  - `DAMAR_UPDATE_SIGNING_KEY` plus `DAMAR_UPDATE_DOWNLOAD_BASE` emit `dist/DAMAR-update-manifest.json` and its `.sig`.
- Docs: INSTALL covers update checks, rollback (run the previous installer offline; data is kept) and backup advice. TROUBLESHOOTING and CHANGELOG are updated.

**(7) Dev paths neutralised.**
- `RUN_DAMAR_CLI.ps1` L5–8: the profile default is `<DAMAR_DATA_ROOT>\profile`. Otherwise it is `<checkout>\..\..\r7r3-scratch\damar-cli-profile`, which is the same folder as before in dev, but no machine path is written in the file.
- `core-host.cjs`:
  - L15–16: the dev fallback is `path.resolve(CANDIDATE,'../../r7r3-scratch')`, identical in dev.
  - L300: the fidelity protected root is now `path.join(SCRATCH, …)`.
  - L329: the default sandbox registry is `path.join(SCRATCH, …)`.
  - L128: `recover(..., SCRATCH)`.
  - L204: `start({..., scratchRoot: SCRATCH})`.
- `inherited-v53/src/r7r3/launcher.cjs` L10–13 and `inherited-v53/scripts/r7r3-recover.cjs` L5–6 take the root as a parameter (or `DAMAR_DATA_ROOT`) and throw if it is missing. No literal path remains.
- The run-01 change is kept: `core-host.cjs` L412 calls `process.disconnect()` on a startup failure.
- Deliberately left: `core-host.cjs` L299 still lists `C:/Workspace/Damar`, `C:/Workspace/uix-w5-visual-prototype` and `C:/Workspace/damar-uix-control-center-v2` as PROTECTED. They are dev-machine *protections* of the Owner's canonical repos, contain no user name, and are inert on a user machine. Removing them would weaken protection for Cores the Owner runs in dev. They can move to an env var if the Owner prefers.

**Installer and RedirectionGuard (found by the junction smoke).**
- Inno Setup 6.5+ turns on Windows RedirectionGuard by default. The guard blocks traversal of junctions created without admin rights, and Inno's `Exec` children inherit it.
- With a junctioned `%LOCALAPPDATA%`, the upgrade-time `damar shutdown` therefore could not see the running Core. Setup failed with exit code 5 because `node_sqlite3.node` was in use, and the uninstaller left Core running.
- Fix: `RedirectionGuard=no` in `release/installer/damar.iss`, with a comment explaining it. The guard protects *elevated* installers from junction planting; this installer is per-user, never elevates, and writes only locations the user already controls.

**Resume after upgrade (found in smoke6).**
- A clean resume once failed with `E_PERSIST_FAILED`, which comes from the canonical audit ledger: `core-snapshot/src/runtime/auditLedger/fileSink.js`, lock acquisition, `failOwned` or unreadable lock.
- The likely cause is a stale `audit-ledger.jsonl.lock` whose recorded PID Windows had reused for a live process. The same step passed in smokes 3, 4 and 5 and again afterwards.
- Mitigation in `release/damar.cjs` `coreStart`: one automatic retry. A failed resume leaves the session unfinished (the launcher removed `FINISHED.json`), so the retry takes the crash-recovery path into a new identity.
- The root cause (no sink `close()` on shutdown, and PID-only liveness) belongs to the canonical runtime owner. `r7r3-recover` has the same PID-reuse weakness (`SOURCE_PID_LIVE_OR_REUSED_RECOVERY_REFUSED`).

**Owner decisions applied.**
- **License:** MIT, open source, v1 free. `LICENSE.txt` keeps "Copyright (c) 2026 Maronns-Dev" unchanged. That is the holder the Owner wrote into the canonical repository's own `C:\Workspace\Damar\LICENSE`, so I treated it as the Owner's chosen name. The repository URL in canonical `package.json` is `github.com/jrxid09-design/Aether`, which names no separate org. If the Owner prefers neutral wording, replacing the holder line in `inherited-v53/LICENSE` with "DAMAR contributors" is a one-line change (that file is the source of `LICENSE.txt`).
- **Support / security contact:** GitHub. README has a new *Support* section (Discussions, Issues, and SECURITY.md for security). SECURITY.md points to the GitHub private advisory form, and TROUBLESHOOTING to Issues.
- All of them use one placeholder, `https://github.com/REPLACE-ME/damar`. The build replaces it when `DAMAR_REPO_URL=https://github.com/<org>/<repo>` is set at publish time. The scan reports any leftover placeholder as `publishPlaceholder`, which is a **release blocker** until the variable is set.

New check: `tests/release-launcher.test.cjs` covers signed-manifest verification (valid, tampered, wrong key, http installer), version ordering, retention rules, and the NODE_ENV switch.

## Build
`node scripts/release/build-release.cjs` (output in `dist/build.log` and `dist/build-report.json`). The final ship set is 5,441 files, 402.9 MiB, aggregate `d372eaaaa40fa3a6…`.

| Artifact | Bytes | SHA-256 |
|---|---|---|
| DAMAR-Setup-1.0.0-UNSIGNED.exe | 119,943,534 | 5039092824841f199f51d2cab13a13b4fa3ab955e2bdb2fb3a008d51abe304c5 |
| DAMAR-1.0.0-portable-win-x64-UNSIGNED.zip | 169,381,603 | 0aae891f0fee8b7ddabe03f9be70b5860be75649838ecbf0ffd63fa95ae65387 |

Signing status is unchanged: unsigned, and signtool is not installed.

## Rescan (dist/scan-report.json): blockers list
- **Secrets: 0.** The 10 reviewed false positives are unchanged.
- **Mochi: 0.**
- **Private router (9router, ninerouter, 20127, gpt-6-luna): 0.** The provider agent's refactor removed them, and the retired control-v2 files are no longer shipped.
- **Publish placeholder: 4** (README L49–50, SECURITY L64, TROUBLESHOOTING L32). This is a **blocker until `DAMAR_REPO_URL` is set** at publish time.
- **Personal / dev paths: 11** (was 27). The Owner name in Presence is fixed by the presence agent, and the Mata Dewa notice paths by the Mata Dewa agent. Remaining, all routed:
  - canonical snapshot (cognitive, provider and Mata Dewa agents):
    - `core-snapshot/package.json` L34/41/43: the `jrxid09-design/Aether` URLs.
    - `core-snapshot/src/mataDewa/providers/http.js` L29: the same URL in the User-Agent.
    - `SNAPSHOT_MANIFEST.json` L4: root `C:/Workspace/Damar`.
    - `RuntimeExecutor.js` L1431: comment `C:\Users\...`.
    - `cognition/simulation/index.js` L18, `cognition/spatial/index.js` L14 and `canonicalRuntimeComposition.js` L192: contract paths `C:\Workspace\Damar-audit-evidence`.
    - `services/opencodeTools.js` L45: `C:\Workspace\Aether`.
  - core-host: L299, the dev PROTECTED roots (see item 7).
- **Licenses: 0 findings** over 107 shipped components.
- **Mata Dewa ALPR / ffmpeg (not bundled; enforced):**
  - The build now **fails** (`OPTIONAL_MEDIA_OR_MODEL_BUNDLED`) if any `ffmpeg*.exe/.dll` outside Electron, any `.onnx`, `.tflite`, `.pt`, `.pth`, `.weights`, `.caffemodel` or `.safetensors` file, or any `pyvenv.cfg` (a Python venv) is in the ship set. The current ship set has none. `runtime/python/Lib/venv` is the stdlib module, which the ALPR install needs, not a venv.
  - The SBOM adds 9 **`scope: "excluded"`** components (`damar:shipped=false`). They are read from `src/mata-dewa/alpr-engine.cjs` PINS and model constants, so the SBOM follows the code:
    - fast-alpr 0.4.0 (MIT)
    - fast-plate-ocr 1.1.0 (MIT)
    - open-image-models 0.6.0 (MIT)
    - onnxruntime 1.32.0 (MIT)
    - opencv-python-headless 5.1.0.95 (Apache-2.0; its wheel bundles an LGPL FFmpeg)
    - numpy 2.4.6 (BSD-3-Clause)
    - the models `yolo-v9-t-384-license-plate-end2end` and `cct-xs-v2-global-model` (MIT repositories)
    - ffmpeg (user-provided on PATH; LGPL or GPL depending on the build)
  - `THIRD_PARTY_LICENSES.txt` gets an "OPTIONAL COMPONENTS DOWNLOADED ON DEMAND (NOT INCLUDED)" section.
  - **Flag for the Owner/legal:** the detector is YOLOv9-derived, and the upstream YOLOv9 training code is GPL-3.0. The weights' terms are stated only via their MIT repository and need confirmation.
  - The ALPR folder defaults to `<DAMAR_DATA_ROOT>\alpr` (`%LOCALAPPDATA%\DAMAR\alpr`), so uninstall with `/PURGE` (or answering Yes) removes it. PRIVACY.md and SECURITY.md now cover the on-demand install, Owner cameras, and the data location.
- **Remaining personal-path hits** are all inside `core-snapshot/`, which is a hash-pinned copy of canonical made by `scripts/build-core-snapshot.cjs`. Fixes made in canonical by other agents only reach the product when the Owner or canonical agent regenerates `core-snapshot` (and its `SNAPSHOT_MANIFEST.json`). I cannot edit canonical or the pinned copy.

## Clean-machine smoke
`scripts/release/smoke-release.ps1` against the **final shipped installer** (sha256 `5039092824…`). Final run **smoke8: 30/30 PASS**, report copied to `dist/smoke-report.json`.

Setup:
- Fake `USERPROFILE`/`APPDATA`, with **`LOCALAPPDATA` a directory junction**.
- PATH limited to System32 only.
- `/DIR` throwaway install with `/DAMARSMOKE`.
- My own Core on port 29650. No other process touched.

New steps since run 01:
- Data lands at the junction's real path.
- 7 legacy paths (`/cc2`, `/cc2?x=1`, `/__r6/control.js`, `/uix/control-v2.js`, `/__preview-adapters/mobile.js`, `/s/idle_presence`, `/mobile`) answer 404 `LEGACY_SURFACE_RETIRED` and Core stays alive.
- The installed core-host's child environment is `NODE_ENV=production`.
- `damar update check` reports disabled, and no update URL is baked in.
- Retention (`DAMAR_KEEP_SESSIONS=1`) prunes the recovered crash session.

Upgrade in place with Core running, uninstall keeping data, and `/PURGE` all pass under the junction.

History during this run:
- **smoke4:** the upgrade failed (setup exit 5), and so did the uninstall, both because of RedirectionGuard (fixed).
- **smoke5:** the retention check raced the deletion (fixed: retention now completes before READY is published).
- **smoke6:** the post-upgrade resume hit an intermittent `E_PERSIST_FAILED` (mitigated with one automatic recovery retry; root cause routed).
- **smoke7** and **smoke8:** pass.

## Test suite
Run from R on free ports: `node --test --test-concurrency=1 --test-reporter=tap` over the 74 `tests/*.test.cjs` files except `computer-use.test.cjs`. All fixed test ports were checked free first: 29600, 29623, 29624, 29631, 29641, 29642, 29643, 29699. Output is in `dist/test-run.tap`.

**Result: 376 tests, 373 pass, 2 fail, 1 skipped, 0 cancelled.** The presence-core port-conflict failures from run 01 are gone.

The 2 failures are settings-schema drift from other agents' in-progress `core-settings.cjs` work. They are not release changes; the tests need updating by their owners.
- `pandawa.* settings: allowlist and validation` (`tests/cognitive-pandawa-team.test.cjs:99`): the actual settings include a new `callTimeoutSec: 300`.
- `presence settings live in Core: defaults, Owner-only validated writes, requester read` (`tests/control-dashboard.test.cjs:128`): the actual settings include a new `displayName: ''`.

New `tests/release-launcher.test.cjs` passes 3/3 (rerun after the final launcher edits). The full suite ran before the last two launcher-only edits, the retry and the retention ordering, which the release test and smoke8 cover; core-host has not changed since that run.

`graphify update .` was run in R.

## Remaining risks
1. **Unsigned:** both the installer and `electron.exe` are unsigned until a certificate exists, and signtool and the Windows SDK are needed on the signing machine.
2. **CLI language:** the CLI still defaults to Indonesian (coordinator checking).
3. **Update hosting:** no update URL or key has been provisioned. The Owner must generate an Ed25519 key pair, keep the private key offline, and host the manifest over https.
4. **Remaining scan hits:** the 11 personal-path hits sit in the pinned `core-snapshot` and need a snapshot regeneration. The repo-URL placeholder needs `DAMAR_REPO_URL` at publish time.
5. **Rollback** across a session-format change is not guaranteed. The docs tell users to back up `%LOCALAPPDATA%\DAMAR` first.
6. **Canonical audit-ledger lock** relies on PID liveness, so PID reuse can block a resume (the launcher retries via recovery). This is routed to the canonical runtime owner.
7. **YOLOv9-derived ALPR detector weights:** their terms need Owner/legal confirmation before the ALPR feature is promoted.
8. **Untested:** the real HKCU PATH and Start-menu paths, the GUI shortcut clicks, and a live provider turn.
