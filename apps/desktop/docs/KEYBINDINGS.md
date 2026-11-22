# Keybindings (W5 native CLI)

| Key | Action |
|---|---|
| Enter | Submit draft (in a picker/modal: confirm that modal only) |
| Shift+Enter / Ctrl+J | Newline in draft |
| Esc | Interrupt foreground work (cooperative cancel); dismiss modal or search; idle: clear editor. In the Owner modal: **Deny** |
| Esc, release, Esc again within 700 ms | Escalate only the CLI-owned diagnostic worker. A held key or autorepeat never escalates. |
| Ctrl+C | Interrupt foreground work, or clear input |
| Ctrl+D | Exit on an empty editor, otherwise delete at cursor |
| Up/Down | Scroll transcript |
| Ctrl+Up/Down | Session-only history of allowlisted read commands |
| Ctrl+Home/End | Transcript oldest/latest |
| Tab | Command picker. Selection inserts a draft and never executes. |
| `/sessions` picker | Up/Down, wheel or click to choose; typing filters; Backspace edits the filter; Enter opens the session; Esc closes |
| Ctrl+R | Reverse search: Enter accepts the draft without executing; Esc restores |
| Ctrl+L | Clear visible display |
| Ctrl+Left/Right, Home/End | Word / line navigation |
| Ctrl+V, right-click, bracketed paste | Paste as draft only (max 8192 bytes) |
| Mouse drag | Select transcript text; release copies to clipboard |
| Mouse wheel | Scroll transcript; inside a menu, move the highlight |
| Mouse click on a menu row | Select and activate it (same as Enter). Not active in the Owner approval modal. |
| Esc while work runs and the transcript is scrolled up | Jumps to the newest lines, so the interrupt acknowledgement is visible |