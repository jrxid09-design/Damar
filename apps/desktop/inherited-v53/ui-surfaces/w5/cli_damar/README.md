# DAMAR CLI

Agentic coding assistant for the Damar ecosystem, shaped after the architecture
observed in Claude Code mods (REA analysis, evidence
`ev_4081a4c699fa6abc12116047c9da3e096bd71063be9179db416d489b1c94e733`).

This is an original implementation. Nothing from Anthropic is copied; only the
observed behavioural architecture is reproduced. Runtime: Python 3.9+ and `rich`.

```
python damar.py                 # TUI (opencode-style screen)
python damar.py --plain         # line output (old style)
python damar.py -p "..."        # one-shot prompt
python damar.py -c              # resume the most recent session
python damar.py --resume <id>   # resume a session by the id printed on exit
python damar.py --self-test     # runnable checks for the non-trivial logic
```

Leaving the TUI (Ctrl+C on an empty prompt, or `/exit`) prints the session id and
the exact command that resumes it:

```
  Session  20261018-083046-971402fc
  Resume   python damar.py --resume 20261018-083046-971402fc
```

## Files

```
damar.py          engine: provider, hooks, tools, agent loop, UI, commands, self-test
console_input.py  Windows console input: key events, mouse wheel, resize (ReadConsoleInputW)
mcp_client.py     MCP stdio client: spawn server, handshake, tools/list, tools/call
checkpoints.py    fail-closed per-session file snapshots + real undo/redo
secretstore.py    OS-protected credential store (DPAPI) + log/session redaction
```

Each file is standalone: edit one without touching the others.

## UI

The interactive UI mirrors opencode's session view:

- a rounded frame around the whole screen, closed by a header bar: `DAMAR │ Super
  AI Agent` on the left, `workspace <mode> │ branch <branch>` on the right, the
  real working directory, then a rule. The header is pinned chrome: it is redrawn
  every frame from live state, so mode and branch stay truthful and no answer —
  however long — can scroll it off the top. The transcript scrolls under it, and
  `↑ n earlier lines` marks the hidden rows below the rule
- main pane on the left: the conversation (user, assistant markdown, tool calls);
  prompts are marked `● ›` and written in the theme's gold, so the owner's own
  words never share Damar's colour, and the `● / ○ / │` spine marks requests and
  answers
- a session with no work yet shows only the header bar above the composer: the
  startup screen carries no art and nothing repaints while it sits idle
- fixed 36-column sidebar on the right with the raised `#141414` background:
  a rail that runs the full height of the frame from the top border to the bottom
  border, with the flame mark, the live context, the To-Do panel and the change
  summary — the mark shrinks or steps aside before a plan step would be clipped,
  and the rail names what did not fit (`… n more`) instead of dropping it
  — the Context block names the session's token consumption right under the model
  line (`tokens  12.3k in · 3.1k out`): the provider's own billed counts for the
  calls this session made when the lane reports them, and the app's own estimate
  marked `~` when a lane stays silent. A fresh session reads `tokens  —`, never a
  number the app cannot know
  — the flame mark animates only while Damar is working; at rest it sits still in
  the theme's gold, and `/banner static` keeps it still while working too
- status row (model, activity while the model is busy, scroll indicator, short
  confirmations such as the copy one) and a framed, multi-line composer at the
  bottom — while Damar works, the activity
  label (`Working`, `Planning`, a tool name) carries a specular band that sweeps
  across the word, each cell fading from the theme's gold toward white around the
  moving head; only colours move, never the text, so the row cannot shift
  mid-animation, and `/banner static` stills the band with the flame
- the tab/window icon is DAMAR's own flame — `damaricon-clean.png`, set as the
  `icon` of the `DAMAR` Windows Terminal profile; a terminal cannot take a bitmap
  from an application, so the app only carries the state next to it, in the title
  text (OSC 0): the bare wordmark `DAMAR` at rest and while Damar works — the tab
  ring is the working signal, so the title never twinkles — and after a finished
  turn the check `✓` flips with the bare wordmark once a second until the owner
  touches a key or the mouse again. No emoji, no pictographs: the title uses text
  glyphs only, and a terminal that ignores OSC keeps its own title
- the terminal is asked to draw the rest of the tab chrome it owns: while Damar
  works the app reports an indeterminate progress state (OSC 9;4), which Windows
  Terminal renders as a progress ring in the tab header — over the icon, with the
  taskbar button marked busy — and when the turn lands the ring is cleared (the
  flame is back) and a desktop notification (OSC 9) toasts the done message;
  quitting while busy clears the ring too, so a dead app never leaves a spinner in
  the tab. The ring's colour is Windows Terminal's own — the `ProgressRing` in its
  tab header has no `Foreground`, so it inherits the WinUI default, the system
  accent colour — and neither the app nor the profile can set it

Colors come from the `damar-ember` default theme: background `#0b0c10`, panel
`#13151c`, text `#f2f4f8`, muted `#8b95b0`, gold `#eac071`, border `#32384d`;
`/theme` switches the preset. The frame that wraps the whole session — corners,
rails and rules — is drawn in the theme's gold.

The sidebar is frozen: it only ever shows the true To-Do state
(`PENDING / IN_PROGRESS / COMPLETED / VERIFIED / FAILED / BLOCKED`), and a step
is never marked complete just because a phase ended or the model said so.

Text margins are one pad on both sides. A transcript row pays for its own indent
before it wraps — the body's two cells, the owner's six-cell `●  ›` mark — so a
row that fills its budget stops the same two cells short of the rail as the
header rule and the composer do, and a long prompt is never cut by the text area.
A code block's band belongs to its code: rich fills every code row to the render
width with the theme background, which drew a block from one edge of the
transcript to the other while an answer streamed, so the padding is dropped and
the band ends with each line's last glyph. The same rule is checked frame-wide:
no band — diff tint, code theme, selection highlight — may start on the frame's
own pad or run past its row's last glyph, and none may cross into the rail.

Controls

| key             | does                                            |
|-----------------|--------------------------------------------------|
| enter           | send prompt (or run `/command`)                  |
| backspace / del | edit the prompt at the cursor                    |
| ← / →           | move the cursor (ctrl+← / ctrl+→ jump words)     |
| home / end      | jump to start / end of the prompt                |
| ↑ / ↓           | scroll the transcript (the wheel's step; ctrl+↑ / ctrl+↓ walk the prompt history) |
| pgup / pgdn     | scroll the transcript a page (laptops that send these as Fn+↑ / Fn+↓ still page) |
| ctrl+t          | expand / collapse details and inline diffs       |
| mouse wheel     | scroll the transcript (3 lines per notch)        |
| esc             | clear a text selection; else interrupt the model while it works; else clear the prompt; on empty, jump to the bottom |
| ctrl+c          | copy a selection when one exists; on idle clears the prompt, twice = quit (it never interrupts: esc does) |
| drag in transcript | select transcript text (bounded to the content column; dragging past the body keeps scrolling into the rows that already existed; releasing copies to the clipboard) |
| drag in the rail | select the sidebar's own text (bounded to the rail column, never the transcript; releasing copies to the clipboard) |
| shift+↑ / shift+↓ | extend a whole-row selection without a mouse  |
| ↑ ↓ / j k, enter, 1-3, a / s / n | answer the tool-approval card (`s` takes the scoped or "always this session" option; cursor starts on Deny, so a bare Enter never approves) |

The TUI owns the console input buffer (`console_input.py`): processed input is
off, so ctrl+c arrives as a key event the TUI handles; the wheel arrives as
mouse events. Ctrl+Break still raises `KeyboardInterrupt` as a hard escape.
The TUI needs a real Windows console at least 86x20 and falls back to plain
line output when: stdout is piped, `--plain` is passed, `DAMAR_UI=plain`,
`"ui": "plain"` in the config, or the terminal is too small.

Selecting text happens inside one pane at a time. A drag in the transcript
highlights and copies transcript rows only, so the rail, the composer chrome,
the pinned header and right-hand padding can never appear in a transcript
block. A drag in the rail itself (when it is shown) highlights and copies the
rail's own text the same way — the `│ ` edge, the gold border and the composer
stay chrome, and a rail block can never reach into the transcript. Rows are
absolute, not screen rows: a transcript block keeps its content while the view
scrolls and copies whole even after it no longer fits on screen; the rail is a
live panel, so a rail block copies the pane as it reads right now. A drag starts
a selection only when it starts on one of the two panes — a press on the chrome
does nothing — and the highlight ends on the last real glyph of each row, so
trailing padding never looks selected. Dragging past the top or bottom of the
body keeps pulling
the transcript — a row at once, then a row per tick (about 7/s),
speeding up while the pull is held; mouse reports are not a scroll rate, so a
touchpad and a mouse pull at the same speed — so one gesture can block a whole
answer. A pull reaches only the rows that existed when the block started: rows
the model writes afterwards are the task running, never pull room, so a held
block ends in the same place whether the answer is streaming or long finished,
and neither a resting hand nor a busy transcript can walk it to the end of the
answer. Releasing the
button copies the block straight to the clipboard while the footer says how many
lines and characters went. While the owner is scrolled away from the newest line
— or holding a block — rows that stream in below extend the scroll offset with
the transcript, so the window stays on the rows being read instead of sliding
back to the bottom; the rail's Plan block keeps every step, wraps long labels
and marks them ✓ done, ● running, ○ pending. A job's plan is defined once —
the planning call, or the model's first `todowrite` list — and from then on the
steps are frozen and only their marks move: a checklist restated mid-answer or
a later checkpoint cannot add, reword, drop or reorder a step, so the count
stays trustworthy while the task runs. A plan is drawn only for real
workspace work: a greeting, a poem, or a story is chat, so it gets no plan
rather than a plan whose steps could never be honest evidence.
Ctrl+C re-copies that same snapshot and never interrupts; **esc** is the
interrupt key while Damar works. Wheel scrolling clears a selection and scrolls
normally. While a turn runs, the busy ticker — not the token stream — is what
reads the keyboard and the mouse, so the composer, the wheel and a drag stay
live through a long tool call or a thinking pause instead of going dead until
the next token; an interrupt read there is honoured at the turn's next boundary
(mid-stream it still stops at once).
Where a console host does not forward drag records (`mouse_move`), `shift+↑ /
shift+↓` then `ctrl+c` is the verified copy path. `/copy on` hands the mouse to
the terminal's own (Quick Edit) selection; while it is on the sidebar is hidden,
so even a whole-screen line block cannot pick it up. `/copy off` brings the rail
back.

The app owns the console mode while it runs, and every read takes it back: a
tool's child process can leave its own mode behind — `cmd.exe` (what a `bash`
call spawns on Windows) returns the console to line/echo input with
`ENABLE_MOUSE_INPUT` cleared — and with the mouse no longer ours the owner's drag
is handled by the terminal instead, whose selection paints whole rows out to the
buffer's right edge. That was the "blok ... ujung ke ujung" that only appeared
once a run started doing Search/Run/Read. One `GetConsoleMode` per read, and a
`SetConsoleMode` only when the mode really drifted, keeps a drag a DAMAR block.

Width is measured in terminal cells (`rich.cells`), never `len()`: emoji, CJK,
combining marks, multiline input and long paths/commands all wrap and clip
inside the composer border.

## Authority and permissions

One pipeline decides every consequential call, and it runs in this order:

1. operation classification (`classify_operation`) — destructive shell,
   package install, credential access, network, read, workspace mutation
2. critical classes (destructive / install / secret) → confirm, under **every**
   profile — a profile can never weaken this step
3. a read-only operation → allow; `NETWORK_PRIVATE` → confirm (the fetch policy
   blocks it regardless)
4. Read Only profile → block
5. `USER_DIRECT` provenance + an ordinary class → allow (`!command`)
6. profile autonomy (Workspace Auto: workspace scope; Full Access: everything
   except external filesystem paths and external MCP servers)
7. a real, matching, workspace-scoped grant

Profiles: `ASK_EVERY_TIME`, `WORKSPACE_AUTO` (default for a session), `FULL_ACCESS`
(explicit, warned), `READ_ONLY`. `/vibe [on|off]` is an alias for
`WORKSPACE_AUTO` — it cannot escalate to Full Access, and destructive `bash`
still asks.

Every tool execution records its true origin at the request site — `USER_DIRECT`,
`MODEL_TOOL`, `SUBAGENT_TOOL`, `MCP_TOOL`, `PLUGIN_TOOL` — never inferred from
transcript text. `!command` counts as owner intent but destructive, credential,
package-install and external-scope operations remain governed. Legacy global
tool allow-lists from older configs are preserved for audit under
`permissions.legacy_allow_deprecated` and re-require a scoped authorization.

## Approval

Consequential tool calls raise a readable card in the main content column above
the composer — never a raw tool-JSON question. The card is drawn as its own
bordered box, the way `/permission` draws one: it never reads as another
paragraph of the answer it interrupts, and the rail stays live beside it. It
shows the action and target, the change, the scope, the risk and reason when a
boundary is involved, the tool and the execution origin (a hook's declared
provenance is shown too), and never a credential value:

    ╭─ Approval required ────────────────────╮
    │ Edit      kalkulator/engine.py         │
    │ Change    2 line(s) replaced, 5 written│
    │ Scope     Current workspace            │
    │ Tool      edit                         │
    │                                        │
    │   Allow once                           │
    │   Allow for this workspace             │
    │ › Deny                                 │
    │ ↑/↓ choose   Enter confirm   Esc deny  │
    ╰────────────────────────────────────────╯

`Allow once` authorizes that single call and records nothing reusable.
`Allow for this workspace` creates a real session-scoped grant that suppresses
matching re-asks inside the workspace. Boundary crossings add
`Allow external files for this session` and ask again on expansion. Cards that
can carry no reusable grant (critical classes, external MCP tools) offer
`Allow always this session` instead: it remembers the exact request it was
shown — same tool, same operation class, same target — for this run of the app
only, is never written to config or the session file, and is gone at the next
start. The cursor starts on `Deny`, so a bare Enter never approves; `Esc`
denies; `1..n` select directly; `s` picks the scoped or session option.

A card also plays one notification sound, so an approval cannot sit unanswered
behind another window: it is the owner's own Windows scheme sound
(`SystemNotification`, falling back to the asterisk sound), so a muted or "No
Sound" scheme stays muted, and a machine without a sound backend is simply
silent. Only a real terminal gets it — piped runs and the self-test never beep.

## Secrets

Provider credentials are stored in the OS-protected backend
(`~/.damar/secrets/<name>.bin`, DPAPI-sealed to the current Windows user).
Config holds only `secret_ref` ("damar:<name>") or `api_key_env`; there is no
plaintext `api_key` fallback — with no backend the CLI is ENV_ONLY and says so.

```
/secrets            # backend status + which config paths are still plaintext
/secrets migrate    # store -> verify retrieval -> set secret_ref -> drop plaintext
```

Migration is explicit and safe: if the protected write cannot be verified, the
plaintext is kept and the report says so. Registered secrets are redacted from
the transcript, session files, exports, diagnostics and the event log, and
`mask_secret` reports only "configured" / "not configured" — never fragments of
the value. Startup carries no plaintext-credential warning; `/secrets` is where
the plaintext paths and the migration are reported.

## To-Do state and evidence

To-Do items carry an explicit state, and the state only advances on real
evidence: a successful `write`/`edit` completes the active step; a passing test
verifies the verification step; a failing tool marks the active step failed; the
summary step completes when the summary is produced. Old sessions with boolean
To-Dos still load.

A finished plan is never drawn as a finished task: while the turn is still
running — the model call itself or the tool runs in between — the plan header
reads `Plan n/n · work continues`, so a full row of ticks cannot be read as
"done" while Damar is still working.

Tool evidence is typed (`CREATED / EDITED / SYNTAX_CHECKED / TESTED / BUILT /
LINTED / TYPECHECKED / INSPECTED / FAILED / NOT_VERIFIED`). A file that merely
exists is `CREATED`, never verified: the final summary derives "verified" notes
only from verifying evidence and reports completed-but-unverified work as
"not verified".

Tools also emit presentation-neutral semantic events (Read, Search, Create,
Edit, Run, Test, Verify, Fetch, Task, Skill, MCP). The transcript consumes them:
an `Edit`/`Create` renders a bounded inline diff built from the text the tool
really replaced — red removals, green additions, muted context, real line
numbers on the correct side, `+n -m` counts, and a `cd` prefix moved to muted
cwd metadata. Every added and removed line carries its own tinted band (green
for `+`, red for `-`) across the code — never the gutter — and a line too long
for the text area wraps instead of being cut, so a snippet never draws a flat
slab from the frame's left edge to its right one, is never mistaken for a plain
reply or for a command run, and never hides the tail of the change. The diff passes through the secret-redaction layer,
and Ctrl+T expands it (a large change shows its first hunk plus the hidden line
count). A command row, a cwd row and an output headline wrap the same way — a
long `node -e "…"` or a long first line of output continues on the next row
instead of being cut at the text area's width, so the rows the owner copies into
a report never end on one flat column. The same holds for the plain rows that
appear once a run is under way — a fallback notice, a turn-limit line, a blocked
path, a tool error, a summary item: they wrap onto the next row (keeping their
indent) rather than being cut, because those are exactly the rows raised while
Damar works. A result line is green only when the
recorded evidence is a verifying
check (`TESTED / BUILT / LINTED / TYPECHECKED / SYNTAX_CHECKED`) that passed; a
failure is red with its first useful error lines. Model prose never colours a
line.

## Context budget

History is folded by a token budget derived from the model's known context
window (a conservative estimate when unknown), not by a message count. An
assistant `tool_call` is never separated from its `tool` result. `/compact`
folds older turns into a structured context block — it never inserts a fake
"earlier conversation trimmed" user message.

## Checkpoints, /undo and /redo

Before every `write`/`edit` the previous file state is snapshotted to
`~/.damar/checkpoints/<session-id>/index.jsonl` (base64, so binaries survive).
Snapshots are fail-closed: if the pre-snapshot cannot be taken (unreadable file,
over the 1 MiB per-file limit, over the 32 MiB session quota, or outside the
bound workspace) the mutation is refused instead of applied irreversibly. Each
record binds workspace, canonical path, op id, tool, before/after hashes and
content, and a timestamp; restore re-validates all of it and refuses traversal,
symlink escape, workspace mismatch and malformed records.

`/checkpoints` lists them newest-first. `/undo` restores the files *and* the
conversation and To-Do state; `/redo` really replays the filesystem forward.
Nothing prints "success" unless the replay succeeded. A new mutation after an
undo invalidates the redo history.

## Config — `~/.damar/config.json`

```json
{
  "model": "river/deepseek-ai/DeepSeek-V4.1-Flash",
  "model_fallbacks": ["dahal/deepseek-ai/DeepSeek-V4-Flash-0731",
                      "omop/deepseek-v4.1-flash"],
  "max_turns": 100,
  "base_url": "http://127.0.0.1:20128/v1",
  "api_key_env": "NINEROUTER_API_KEY",
  "secret_ref": "damar:default",
  "stream": true,
  "telemetry": "local",
  "ui": "tui",
  "permission_profile": "WORKSPACE_AUTO",
  "providers": {
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY",
      "models": ["gpt-5", "gpt-4.1"]
    },
    "local": {
      "base_url": "http://127.0.0.1:11434/v1",
      "models": ["qwen3-coder"]
    }
  },
  "mcpServers": {
    "files": { "command": "npx",
               "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
               "env": {} }
  }
}
```

There is deliberately no `api_key` key: a key is a `secret_ref`, an
`api_key_env`, or the OS store. Key precedence: `DAMAR_API_KEY` → env named by
`api_key_env` → `secret_ref`. `telemetry: "local"` writes `~/.damar/events.jsonl`
only; nothing leaves the machine.

A spent quota or a 429 no longer ends the turn: the provider steps down the
`model_fallbacks` chain (absent = the built-in cross-lane defaults, `[]` = chain
off) and the model that answered leads from then on for that session — one muted
line in the transcript says which. A substitute lane has a short leash (12 s to
start answering): a lane that hangs is dropped for the session, so no turn pays
that wait twice and a hang never reads as "the model got slow". The model named
in the config keeps the last word in the chain. A deterministic refusal (bad
payload, bad key) is surfaced at once instead of burning the chain. `/status`
lists the active chain.

One prompt may run up to 100 model↔tool roundtrips (`max_turns` raises or lowers
it). That lid is a runaway guard, not a task budget: a real redesign needs
dozens of roundtrips and must not be cut off mid-file. When the lid does close,
the transcript says how many roundtrips were spent and that the next message
continues the same task.

## Soul — `~/.damar/soul.md`

DAMAR has a persona, and it lives in `~/.damar/soul.md`. The file is minted on
first use from the built-in default, so there is always one to edit, and it is
read fresh on every turn: an edit lands on the next request, no restart. In the
system prompt it sits directly after the canonical policy and is labelled
trusted — it is DAMAR's own character, never project content, so a repository
that ships its own `soul.md` cannot rewrite who DAMAR is. `/soul` prints the
persona and its path.

## Commands

Run `/help` for the full list. The main ones:

`/connect` `/provider` `/apikey` `/secrets` `/baseurl` `/test` `/model` `/models`
`/permission` `/permissions` `/vibe` `/trust` `/plan` `/todo` `/status` `/doctor`
`/sessions` `/resume` `/continue` `/history` `/new` `/clear` `/compact`
`/summarize` `/tools` `/skills` `/soul` `/hooks` `/plugins` `/diff` `/undo` `/redo`
`/rewind [n]` `/checkpoints` `/mcp` `/themes` `/details` `/expand` `/editor`
`/export` `/init` `/share` `/unshare` `/sidebar` `/banner` `/thinking` `/btw`
`/copy` `/exit` (plugins can add more — a plugin that registers a command hook
can add its own `/command`). Prefix a prompt with `!` to run a shell command
through the normal authority pipeline with `USER_DIRECT` provenance.

## `/btw` — a side answer that never joins the task

While a task is running, `/btw <question>` opens a popup over the transcript and
answers it on a separate read-only lane: no tools, no session messages, no plan
rows, no transcript line. The running turn is never interrupted and never sees
the question, so a side answer about the work cannot change the work.

The lane still *knows* the work it answers beside: the running task, the plan
with each step's mark and the step it is on, what the turn is doing right now
(the phase and the tool it is running), the answer being written at that moment,
and the tail of the transcript. A question like `/btw lagi apa?` therefore comes
back about the task in flight — never as if the window had just opened — while
the task, its plan and the session stay exactly as they were.

The popup scrolls with the wheel or `↑`/`↓`; `Esc` or a mouse click closes it,
and while it is open `Esc` belongs to the popup — closing a side answer can
never interrupt the task, so a second `Esc` is the interrupt. If the answer is
still on its way when the popup closes, it is dropped rather than kept. In plain
(non-TUI) mode the question and the answer are printed as ordinary lines.

## Tools

`bash` `read` `write` `edit` `glob` `grep` `web_fetch` `task` `todowrite`
`use_skill` `background_status`.

`read`, `glob`, `grep`, `task`, `todowrite`, `use_skill` and
`background_status` run without asking; `bash`, `write`, `edit` and `web_fetch`
go through the authority pipeline. `web_fetch` hard-blocks loopback, private,
link-local and unsupported schemes before any request.

- `task` delegates a self-contained task to a sub-agent (own message list, same
  tools minus `task`, up to 20 roundtrips) and returns its report. The
  sub-agent's calls are shown indented and carry `SUBAGENT_TOOL` provenance.
- MCP tools appear as `mcp__<server>__<tool>` and always ask (not in
  `SAFE_TOOLS`), carrying `MCP_TOOL` provenance.

## MCP servers

`mcpServers` entries are spawned over stdio at startup with a sanitized
environment (the CLI/provider env is not leaked); each server gets the
`initialize` handshake followed by `tools/list`, and its tools are merged into
the model's tool list. Replies are routed by request id, so out-of-order
responses land on the right caller. Malformed JSON lines are skipped; a server
that times out, exits or dies with a request pending surfaces a truthful error
instead of hanging. Failures show up as notices ("mcp files: unavailable …")
instead of breaking the run. `/mcp` lists servers, status and tools.

## Plugins

A plugin is a folder with `plugin.json` + `hooks/hooks.json` listing modules.
A module exposes `register(on, options)` and subscribes with handlers shaped
`(ctx, event, next)`; `next(event)` continues the chain and the engine's builtin
behaviour sits at the bottom. Nothing is bundled: this is the layout a plugin
takes when you drop one into a search root.

```
plugins/hello-damar/
  plugin.json
  hooks/hooks.json        { "modules": ["./mods.py"] }
  hooks/mods.py           register(on, options)
```

Roots searched: `<cwd>/plugins`, `<cli folder>/plugins`, `~/.damar/plugins`.
Events: `session.start`, `prompt.submit`, `tool.before`, `tool.after`,
`message.complete`, `command.register`, `command.run`, `session.end`. A hook may
declare its own provenance (`PLUGIN_TOOL`) but can never claim `USER_DIRECT`.

## State

- sessions: `~/.damar/sessions/*.json` (`-c` resumes the latest)
- checkpoints: `~/.damar/checkpoints/<session-id>/index.jsonl`
- secrets: `~/.damar/secrets/*.bin` (DPAPI-sealed)
- event log: `~/.damar/events.jsonl`
- project instructions: `DAMAR.md` or `AGENTS.md` in the cwd (see `/init`)

Repository instruction files are injected into the project-context layer clearly
marked as untrusted, and they can never change code-side authority: an
instruction to write outside the workspace or reach a private address still
meets the same classification and confirmation as any model-initiated call.

## Git

Both a real `.git` directory and a worktree/submodule `.git` *file* with a
`gitdir:` pointer are recognized for branch display. Verified against a real
`git worktree add` on git 2.55: the resolved git dir matches
`git rev-parse --absolute-git-dir`.

## Still not there

- MCP over HTTP/SSE (stdio only) and MCP resources/prompts (tools only)
- the TUI input layer is Windows-only (`console_input.py` raises
  `NotImplementedError` elsewhere and the CLI falls back to plain output)
- no private-network auto-access and no connected-mode flag (`DAMAR_CONNECTED`)
  — private targets stay blocked/confirmed by design
- a running `bash` tool finishes before an interrupt (esc) is honoured
