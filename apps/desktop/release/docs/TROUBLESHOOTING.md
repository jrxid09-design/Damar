# Troubleshooting

Start with:
```
damar core status
damar version
```
Core's output is in `%LOCALAPPDATA%\DAMAR\logs\core.log`.

| Symptom | What to do |
|---|---|
| `'damar' is not recognized` | Open a new terminal after installing. Check that `%LOCALAPPDATA%\Programs\DAMAR` is in your user PATH (reinstall with *Add the "damar" command to my PATH*), or run `%LOCALAPPDATA%\Programs\DAMAR\damar.cmd`. |
| `port 127.0.0.1:29623 is in use by another program` | Another program, or another copy of DAMAR started from a different folder, holds the port. Set a free port for your user, for example `setx DAMAR_CORE_PORT 29700`, then open a new terminal. Shortcuts pick up the change at your next sign-in. |
| `DAMAR Core did not become ready` | Read the last lines the message prints, and `core.log`. If the error is `NODE_OPTIONS_REFUSED` or `UNISOLATED_ENVIRONMENT_REFUSED`, start DAMAR from a terminal where `NODE_OPTIONS` and `DAMAR_TOKEN` are not set. |
| `R7R3_REPARSE_REFUSED` / `R7R3_WRITE_OUTSIDE_SCRATCH` in the log | Core refuses to write through a junction or symbolic link created inside `%LOCALAPPDATA%\DAMAR`. A redirected `%LOCALAPPDATA%` itself is supported. Remove any links you created inside the DAMAR data folder. |
| Core stopped unexpectedly | Run `damar` again. Core recovers into a new identity: your session history is kept, interrupted work is shown as `OUTCOME_UNKNOWN` and never re-run, and approvals are asked again. |
| `damar resume` waits with a countdown | After a crash, the previous window's session lease must expire first (up to 15 s). |
| `LIVE_MODEL_NOT_AUTHORIZED` / `LIVE_INFERENCE_NOT_AUTHORIZED` | Grant the model, or `*`, on the connection in Control → Providers. Then pick that model with `model` in the CLI. |
| `PROVIDER_NOT_CONNECTED` | Add or fix the connection in Control → Providers (base URL and key). |
| A turn ends `FAILED/TIMEOUT` | The provider did not answer in time. By default Core waits 600 s for response headers and 600 s between streamed chunks. |
| The CLI is in Indonesian | Type `language en`. |
| The CLI says `PYTHON_RENDERER_UNAVAILABLE` | The bundled Python in `%LOCALAPPDATA%\Programs\DAMAR\runtime\python` is missing or blocked, for example by antivirus. Reinstall DAMAR. |
| `INTERACTIVE_TTY_REQUIRED` | The CLI needs a real console window. Run it in Windows Terminal or the classic console, not with its output redirected. |
| Control shows an authorization error | Open it with the **DAMAR Control** shortcut or `damar control`. Its URL carries the private token, so a bookmarked `/control/` page has none. |
| Presence shows nothing from Core | Start it with the shortcut or `damar presence`, which binds it to the running Core. |
| SmartScreen blocks the installer | Unsigned builds are expected to trigger it. Check the SHA-256, then choose *More info* → *Run anyway*. |
| `damar update check` says the check is disabled | This build has no update URL or signing key. Check the release page instead and verify the SHA-256. |
| `UPDATE_SIGNATURE_INVALID` | The downloaded manifest does not match the signing key built into your copy. Do not install from it, and report it. |
| Disk use under `%LOCALAPPDATA%\DAMAR\sessions` | DAMAR keeps the newest 5 Core session folders (`DAMAR_KEEP_SESSIONS`). A crashed folder that has not been recovered is kept until the next start recovers it. |
| Uninstall left `%LOCALAPPDATA%\DAMAR` | That is intended (your data is kept). Delete the folder yourself, or uninstall with `/PURGE`. |

Report problems at https://github.com/REPLACE-ME/damar/issues. When reporting a problem, include the output of `damar version`, `damar core status` and the end of `core.log`. Remove any tokens before you share it.
