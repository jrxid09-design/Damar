# Quickstart

This guide takes about five minutes. You need an account with any OpenAI-compatible provider, or a local server such as Ollama or LM Studio.

## 1. Start Core and open Control
Open **Start → DAMAR → DAMAR Control**, or run:
```
damar control
```
This starts DAMAR Core in the background if it is not already running, then opens `http://127.0.0.1:29623/control/` in your browser. The private access token is passed in the URL fragment, which browsers never send to a server. The page keeps the token in memory and removes it from the address bar.

The **Get started** card in Control lists the same three steps as this guide.

## 2. Connect a provider
1. Open **Providers** in Control.
2. Add a connection, or pick a preset (for example OpenAI, OpenRouter, Groq, Ollama or LM Studio). You can rename or remove connections later.
3. Enter the provider's OpenAI-compatible base URL (for example `https://<provider>/v1`, or `http://127.0.0.1:<port>/v1` for a local server) and, if the provider needs one, an API key.
   - Keys are write-only. Control can send a key to Core but never reads one back.
   - If you tick *Remember key*, Core stores the key encrypted with Windows DPAPI for your user account. Otherwise the key stays in Core memory only until Core stops.

## 3. Grant a model
Core never sends a prompt to a live model unless you have granted that model.
1. In **Providers**, open the **grant** (allow models) action on the connection.
2. Enter an approval reference (any note for your own records), a model id or `*` (all models of this provider), an expiry of 1 to 365 days and, optionally, limits on completions or tokens.
3. Confirm. The grant is listed on the connection, and you can revoke it there at any time.

## 4. Your first CLI turn
Open a terminal in a project folder (this folder becomes the agent's workspace) and run:
```
cd C:\path\to\your\project
damar
```
- The CLI starts in Indonesian. Type `language en` to switch to English; the choice is saved.
- Type `model` to pick a model of the active provider with the arrow keys, then press Enter and confirm.
- Type a request in plain words, for example `Explain this project` or `Run the tests and fix the failing one`.
- When DAMAR wants to write a file, edit a file, run a command or delegate work, it shows a permission card: `1` Allow once, `2` Allow always for this session (this exact request only), `3`/`n`/Esc Deny. Deny is the default.
- Esc stops the current turn. `exit` saves the session and prints the command to resume it, for example `damar resume 7f2b1282`.

Other useful commands: `help`, `status`, `settings`, `connect`, `usage`, `/diff`, `/undo`, `/sessions`, and `/` to open the command palette. Keys are listed in [KEYBINDINGS.md](KEYBINDINGS.md).

## 5. Presence (optional)
**Start → DAMAR → DAMAR Presence**, or `damar presence`, shows DAMAR's state at the top of your screen. When a turn waits for permission, the Notch shows the request and you can answer it there or in the CLI; the first answer wins. Voice input stays off until you enable it. Its *Dashboard* button opens the Control page without a credential, so use the **DAMAR Control** shortcut (or `damar control`) to get a signed-in dashboard. Its *CLI* button opens a new DAMAR CLI window.

## Stopping
`damar core stop` stops Core cleanly, and the next start resumes it. `damar shutdown` stops both Presence and Core.
