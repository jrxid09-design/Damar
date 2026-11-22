# Installing DAMAR

## Requirements
- Windows 10 version 1809 or later, or Windows 11, on x64.
- A normal user account. No administrator rights are needed.
- About 800 MB of disk space.
- Nothing else. Node.js, Python 3.12 and the Electron runtime are bundled.

## Installer (recommended)
1. Run `DAMAR-Setup-<version>.exe`.
   - **Unsigned builds** are named `DAMAR-Setup-<version>-UNSIGNED.exe`. Windows SmartScreen will warn about them ("Windows protected your PC" → *More info* → *Run anyway*). Before running one, check its SHA-256 against the published `SHA256SUMS.txt`:
     ```powershell
     Get-FileHash .\DAMAR-Setup-<version>-UNSIGNED.exe -Algorithm SHA256
     ```
2. Choose the options:
   - **Add the "damar" command to my PATH** (on by default).
   - **Start DAMAR Presence when I sign in** (off by default).
3. DAMAR is installed for the current user only, to `%LOCALAPPDATA%\Programs\DAMAR`.

The Start menu gets a **DAMAR** folder containing:

| Shortcut | What it does |
|---|---|
| DAMAR CLI | Starts Core if it is not running, then opens the CLI with your user folder as the workspace |
| DAMAR Control | Starts Core if needed and opens the dashboard in your default browser |
| DAMAR Presence | Starts Core if needed and starts the Presence app |
| DAMAR Documentation | Opens this documentation folder |

Open a **new** terminal after installing so it picks up the PATH change.

### Silent install
```
DAMAR-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /TASKS="addpath"
```
Add `autostart` to `/TASKS` to start Presence at sign-in.

## Upgrading
Run the newer installer. It stops a running Presence and Core, replaces the program files in place and keeps your data. Saved sessions resume after an upgrade.

## Checking for updates
```
damar update check
```
This downloads the release manifest from the update URL built into your copy, verifies its Ed25519 signature against the public key built into the same copy, and tells you whether a newer version exists. It also prints the installer's download URL and SHA-256. Nothing is downloaded or installed automatically. If your build has no update URL configured, the command says the check is disabled.

## Rolling back
To return to an earlier version, run that version's installer. It replaces the program files in place and keeps `%LOCALAPPDATA%\DAMAR`. This works offline if you kept the installer.
- Before an upgrade, back up your data if you want to be able to roll back safely: stop DAMAR (`damar shutdown`), then copy `%LOCALAPPDATA%\DAMAR` somewhere else.
- A newer Core may write session data that an older version does not understand. If the older version does not start after a rollback, stop it, restore your backup of `%LOCALAPPDATA%\DAMAR`, and start again.

## Disk use and old sessions
Each Core start after a crash, and each fresh start, creates a new folder under `%LOCALAPPDATA%\DAMAR\sessions`. After Core becomes ready, DAMAR keeps the newest 5 of these folders and deletes older ones that either stopped cleanly or have already been recovered. It never deletes the active folder, or a crashed folder that has not been recovered yet. To keep a different number, set the environment variable `DAMAR_KEEP_SESSIONS` (1 to 1000) for your user. Your CLI session history always moves forward into the newest folder.

## Portable zip
`DAMAR-<version>-portable-win-x64.zip` contains the same files as the installer. Extract it anywhere you can write, then run `damar.cmd` from that folder. The portable copy creates no shortcuts, no PATH entry and no uninstaller, but it uses the same data folder (`%LOCALAPPDATA%\DAMAR`).

## Uninstalling
Use **Settings → Apps → Installed apps → DAMAR → Uninstall**. The uninstaller:
- stops Presence and Core,
- removes the program folder, the shortcuts, the PATH entry and the sign-in entry,
- asks whether to remove your data in `%LOCALAPPDATA%\DAMAR`. The default answer, **No**, keeps it for a later reinstall.

For a silent uninstall, run `unins000.exe /VERYSILENT` from the install folder. Your data is kept unless you add `/PURGE`.

## Verifying an installation
`MANIFEST.json` in the install folder lists the SHA-256 of every installed file. The commands to compare it with the files on disk are in `REPRODUCIBILITY.md`, which is published next to the release artifacts.
