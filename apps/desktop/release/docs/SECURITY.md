# Security

## What runs, and with which rights
Everything runs as **your Windows user**. Nothing is installed as a service and nothing needs administrator rights.

| Process | Runs as | Purpose |
|---|---|---|
| `node.exe release\damar.cjs __core-run` | you, hidden | Supervisor that starts and stops Core |
| `node.exe src\core-host\core-host.cjs` (parent and child) | you, hidden | DAMAR Core, listening on `127.0.0.1:<port>` only (default 29623) |
| `node.exe src\cli\w5-main.cjs` + `python.exe w5-renderer.py` | you, in your terminal | DAMAR CLI |
| `electron.exe src\presence` | you | DAMAR Presence: reads Core state and can answer a pending permission request with your Owner credential |
| Agent commands and the file writer | you, inside a **no-capability AppContainer** and a Job Object | Approved workspace commands and writes |
| `python.exe desktop-broker.py` | you | Computer-use helper (only after you approve a target) |

Core sets its child processes' `USERPROFILE`, `TEMP` and similar variables to a private folder inside its session directory, so the canonical runtime cannot write into your real profile.

## Network exposure
- Core binds only to `127.0.0.1`. Requests whose `Host` or `Origin` is not that exact loopback origin are refused, and so are cross-site browser requests (DNS-rebinding guard).
- Every API route requires a bearer token. The tokens are random per Core session and stored in the session directory (see *Data locations*). The CLI and Control read them from there. The Control page receives its token in the URL fragment, which browsers never send to a server.
- Presence reads state with the least-privileged token and a fixed list of routes. It uses the Owner credential only to answer the permission request currently shown in the Notch.
- Agent commands and the file writer have **no network access**, loopback included.
- Core itself may reach the network: the provider endpoints you connect, and, after your consent, the Mata Dewa public feeds. Set the environment variable `DAMAR_EGRESS=loopback` before starting Core to confine it to `127.0.0.1`.

## Permission prompts
- **Reads** of files inside the workspace (the folder you started `damar` from) need no prompt.
- **Writes, edits, commands, memory changes and sub-agent delegation** each show a permission card in the CLI window that owns the turn: Allow once, Allow always for this session (that exact request only), or Deny. Deny is the default and Esc denies.
- **Computer use** (screen capture, input, browser automation) asks for each exact target: a window title and process, a screen, or a URL origin. `computer_use_stop` is an emergency stop that lasts until Core restarts.
- **Protected locations are always refused**, whatever you approve: the DAMAR install folder and its parent, Core's data folder (`%LOCALAPPDATA%\DAMAR`), `C:\Windows`, `Program Files`, and any `.damar` folder.
- Permission requests can be answered in the CLI window that owns the turn, or in the Presence Notch. Core accepts the first answer. Control has no approval queue of its own.
- **Settings → Safety policy** can be `ask` (the default), `workspace-auto` (workspace writes, edits and allowlisted commands run without a card; memory changes and delegation still ask), `full-access` (no cards; containment and protected paths still apply) or `read-only`.

## Live model access
A provider call happens only for a model covered by a **model grant** that you created in Control (Providers, on the connection). A grant names a model or `*`, expires after 1 to 365 days, and can limit completions and tokens. Grants are HMAC-signed by Core. A rollback witness kept in `%LOCALAPPDATA%\DAMAR\authority` lets Core detect a grant file that was restored from an older copy.

> v1 uses this per-user witness. It protects against accidental or stale state, not against other software running as your user, which could change your files anyway. A Windows service with stronger isolation is planned and is not included in v1.

## Data locations
| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\Programs\DAMAR` | Program files (replaced on upgrade; DAMAR never writes here at run time) |
| `%LOCALAPPDATA%\DAMAR\sessions\core-*` | Core session directories: access tokens (`credentials.json`, `console-credentials.json`), session history, agent turn journals, receipts, checkpoints and project memory |
| `%LOCALAPPDATA%\DAMAR\profile` | CLI preferences (theme, language, last provider/model, never credentials) and Core settings (`core-settings.json`) |
| `%LOCALAPPDATA%\DAMAR\provider-keys` | API keys you chose to remember, encrypted with Windows DPAPI for your user (`*.dpapi`), and the live-inference usage ledger |
| `%LOCALAPPDATA%\DAMAR\authority` | Model-grant rollback witness |
| `%LOCALAPPDATA%\DAMAR\alpr` | Optional Mata Dewa ALPR engine (a Python virtual environment and models), present only if you installed it from Control |
| `%LOCALAPPDATA%\DAMAR\logs\core.log` | Core output |
| `%LOCALAPPDATA%\DAMAR\run`, `state`, `damar-sandbox-registry.jsonl` | Running-Core state, the record of recovered session folders, and the sandbox grant registry |

If `%LOCALAPPDATA%` is redirected or reached through a junction, DAMAR resolves it to its real location once at start-up. Inside that folder, Core still refuses to write through junctions or symbolic links. These files are protected only by your user account's NTFS permissions. Treat the session directories as secrets: anyone who can read `credentials.json` can drive your Core while it runs.

## How to revoke access
| To revoke | Do this |
|---|---|
| A model grant | Control → Providers → revoke the grant on the connection |
| A remembered API key | remove the connection or its key in Control → Providers, or delete `%LOCALAPPDATA%\DAMAR\provider-keys\<provider>.dpapi` while Core is stopped. Also revoke the key with your provider. |
| "Allow always" approvals | They last only for the current CLI session. Exit the session, or restart Core. |
| Automatic approval | Settings → Safety policy → `ask` or `read-only` |
| Everything Core can do right now | `damar core stop` |
| All access tokens | Stop Core (`damar core stop`), delete `%LOCALAPPDATA%\DAMAR\sessions` and `%LOCALAPPDATA%\DAMAR\state`, then start Core. It creates a new session with new tokens, but your saved CLI sessions are lost. After a crash, Core also recovers into a new identity with rotated tokens. |
| Sandbox folder grants | Core revokes its AppContainer folder grants on a clean stop and sweeps those of a crashed Core on the next start |
| All DAMAR data | Uninstall and answer **Yes** to "Also remove your DAMAR data?" |

## Reporting a vulnerability
Report security issues privately through the project's GitHub repository: https://github.com/jrxid09-design/Damar/security/advisories/new. Use that private advisory form instead of a public issue. Include the DAMAR version (`damar version`) and, if you can, steps to reproduce.
