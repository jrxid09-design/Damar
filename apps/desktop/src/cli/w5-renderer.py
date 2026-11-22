"""Render the exact Owner W5 Tui class with a bounded service-only view model.

This adapter never constructs the legacy coding engine, provider or tool registry.
JSONL stdin/stdout is a private renderer protocol, not a service authority.
"""
import argparse
import math
import time
import random
import importlib.util
import io
import json
import math
import os
import re
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace


def legacy_console_host():
    """True only inside the classic conhost window (class ConsoleWindowClass), whose default fonts lack U+258F,
    the W5 caret, and draw it as a missing-glyph box. Windows Terminal / ConPTY report PseudoConsoleWindow."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        kernel, user = ctypes.windll.kernel32, ctypes.windll.user32
        kernel.GetConsoleWindow.restype = ctypes.c_void_p
        window = kernel.GetConsoleWindow()
        attached = False
        if not window:
            # Spawned with windowsHide: attached to a private windowless console (AttachConsole would fail with
            # ERROR_ACCESS_DENIED). Leave it, look at the CLI's console, then detach at once. stdio stays on the
            # existing pipes; nothing is read from or written to any console.
            kernel.FreeConsole()
            if kernel.AttachConsole(ctypes.c_uint32(0xFFFFFFFF).value):
                attached = True
                window = kernel.GetConsoleWindow()
        try:
            if not window:
                return False
            name = ctypes.create_unicode_buffer(64)
            user.GetClassNameW(ctypes.c_void_p(window), name, 64)
            return name.value == "ConsoleWindowClass"
        finally:
            if attached:
                kernel.FreeConsole()
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prototype", required=True)
    parser.add_argument("--profile", action="store_true")
    args = parser.parse_args()
    prototype = Path(args.prototype).resolve()
    legacy_caret = legacy_console_host()
    spec = importlib.util.spec_from_file_location("damar_owner_w5", prototype / "damar.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # The original Tui constructor loads personal prompt history. Product history is
    # deliberately session-scoped; never import the Owner's existing private home.
    module.load_prompt_history = lambda *args, **kwargs: []
    from rich.console import Console
    from rich.text import Text
    selection = None
    flame_shown = None   # displayed sidebar-flame progress, eased toward the to-do percentage across frames
    color_system = None if os.environ.get("NO_COLOR") or os.environ.get("TERM", "").lower() == "dumb" else "truecolor"
    html_themes = {
        "damar-ember": {"bg":"#0b0c10","panel":"#13151c","text":"#f2f4f8","muted":"#8b95b0","primary":"#eac071","secondary":"#7aa2f7","accent":"#bb9af7","border":"#32384d"},
        "damar-holo": {"bg":"#07090f","panel":"#0b0f19","text":"#eef4ff","muted":"#7e8fb3","primary":"#f5c451","secondary":"#38bdf8","accent":"#a855f7","border":"#283554"},
        "cyberpunk": {"bg":"#0a0c16","panel":"#0f1221","text":"#ebf5ff","muted":"#7d8db5","primary":"#00f5d4","secondary":"#00bbf9","accent":"#f15bb5","border":"#3b426b"},
        "tokyonight": {"bg":"#11121a","panel":"#16161e","text":"#d5def8","muted":"#7882b6","primary":"#7aa2f7","secondary":"#bb9af7","accent":"#ff9e64","border":"#3b4261"},
        "emerald": {"bg":"#08100d","panel":"#0d1713","text":"#ecfdf5","muted":"#78a890","primary":"#34d399","secondary":"#10b981","accent":"#a7f3d0","border":"#284d3b"},
    }

    for line in sys.stdin:
        try:
            state = json.loads(line)
            # Fill large maximized terminals (bounded): 512 x 200 cells.
            cols = max(20, min(512, int(state.get("cols", 120))))
            rows = max(8, min(200, int(state.get("rows", 40))))
            executed = set()
            def trace(frame, event, arg):
                if event == "call" and frame.f_code.co_filename == str(prototype / "damar.py"):
                    executed.add(frame.f_code.co_name)
            if args.profile:
                sys.setprofile(trace)
            theme = state.get("theme", "damar-ember")
            if theme == "damar-holo":
                module.THEME_PRESETS[theme] = {key:value for key,value in html_themes[theme].items() if key != "bg"}
            if theme not in module.THEME_PRESETS:
                raise ValueError("UNKNOWN_ORIGINAL_THEME")
            module.apply_theme_palette(theme)
            if theme in html_themes:
                colors = html_themes[theme]
                module.T_BG = colors["bg"]
                module.T_BORDER_ACTIVE = colors["primary"]
            console = Console(file=io.StringIO(), width=cols, height=rows,
                              force_terminal=True, color_system=color_system)
            usage = state.get('usage') or {}
            tokens_in, tokens_out = usage.get('inputTokens', 0), usage.get('outputTokens', 0)
            if not all(isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 for value in (tokens_in, tokens_out)):
                raise ValueError('INVALID_SESSION_USAGE')
            hud_state = state.get("hud") if isinstance(state.get("hud"), dict) else {}
            provider_state = hud_state.get("provider") if isinstance(hud_state.get("provider"), dict) else None
            # UI language for the DAMAR layer (default English). Status codes and W5 original strings are not translated.
            english = state.get("language") != "id"
            def L(id_text, en_text):
                return en_text if english else id_text
            model_label = ((provider_state["model"][:40] + ("" if provider_state.get("executable") is True else L(" (live: tidak diizinkan)", " (live: not authorized)"))) if provider_state and isinstance(provider_state.get("model"), str) else (usage.get("modelLabel")[:48] if isinstance(usage.get("modelLabel"), str) else L("UNAVAILABLE (tanpa inferensi)", "UNAVAILABLE (no inference)")))
            session = SimpleNamespace(model=model_label, todos=[],
                                      tokens_in=tokens_in, tokens_out=tokens_out, tokens_estimated=False,
                                      messages=[])
            cli = SimpleNamespace(console=console, config={"animate_banner": True},
                                  cwd=Path(state.get("cwd", str(Path.cwd()))), session=session,
                                  tools=SimpleNamespace(last_diff_stats={}, evidence=[], semantic_events=[]),
                                  auto_yes=False, permission_profile=module.PROFILE_ASK_EVERY_TIME)
            tui = module.Tui(cli)
            hud = state.get("hud") if isinstance(state.get("hud"), dict) else {}
            tui.hud_state = hud
            tui._git_branch = state.get("branch", "")
            tui.blocks = [{"kind": "workspace_header"}]
            tui.input_text = state.get("draft", "")[:8192]
            tui.cursor = min(len(tui.input_text), max(0, int(state.get("cursor", len(tui.input_text)))))
            tui.busy = bool(state.get("busy", False))
            tui.turn_active = tui.busy
            tui.phase = "working" if tui.busy else "idle"
            tui.anim_frame = max(0, int(state.get("animationFrame", 0)))
            tui.details = bool(state.get("details", False))
            tui.banner_mode = "static" if state.get("bannerMode") == "static" else "flame"
            tui.sidebar_enabled = state.get("sidebarEnabled", True) is True
            pick = state.get("pick")
            if pick:
                choices = [str(value)[:128] for value in pick.get("choices", [])][:32]
                if choices:
                    index = min(len(choices) - 1, max(0, int(pick.get("index", 0))))
                    start = max(0, index - 9)
                    is_theme = pick.get("kind") == "theme"
                    is_settings = pick.get("kind") == "settings"
                    # The hint names what Enter really does for this picker (only the Tab command picker inserts a draft).
                    hint = {"session": L("Atas/Bawah pilih, Enter buka sesi, ketik untuk mencari, Esc tutup", "Up/Down select, Enter opens the session, type to search, Esc closes"),
                            "provider": L("Atas/Bawah pilih, Enter pilih provider, Esc batal", "Up/Down select, Enter chooses the provider, Esc cancels"),
                            "model": L("Atas/Bawah pilih, Enter pilih model, Esc batal", "Up/Down select, Enter chooses the model, Esc cancels")}.get(pick.get("kind"))
                    tui.pick = {"title": str(pick.get("title"))[:60] if isinstance(pick.get("title"), str) else "Pilih Theme Warna Damar TUI" if is_theme else "DAMAR CLI Settings Control Center" if is_settings else "Commands", "hint": hint or ("Up/Down select, Enter applies, Esc closes" if is_theme or is_settings else "Up/Down select, Enter inserts draft, Esc closes"),
                                "choices": choices[start:start + 10], "index": index - start, "notes": []}
            search = state.get("search")
            if search:
                tui.modal_input = {"title": "Session history search", "value": str(search.get("query", ""))[:8192],
                                   "placeholder": "Read-command history only", "secret": False}
            approval = state.get("approval")
            if approval and approval.get("agent") is True:
                # Agent permission card (design: Approval required [CRITICAL / WORKSPACE], three numbered options, Deny default).
                card = approval.get("card") if isinstance(approval.get("card"), dict) else {}
                diff_lines = []
                for hunk in ((card.get("diff") or {}).get("hunks") or [])[:6]:
                    for line in (hunk.get("lines") or [])[:40]:
                        diff_lines.append(f"{str(line.get('t', ' '))[:1]} {str(line.get('n', ''))[:6]:>4} {str(line.get('text', ''))[:160]}")
                request = SimpleNamespace(denied_by_policy=False, action="Run", target=str(card.get("run", ""))[:160],
                                          summary=str(card.get("change", ""))[:160], scope=str(card.get("scope", ""))[:80],
                                          risk=str(card.get("risk", ""))[:80], reason="", tool=str(card.get("tool", ""))[:40],
                                          source="", details=diff_lines[:8])
                tui.approval = {"request": request, "options": [module.ALLOW_ONCE, module.ALLOW_SESSION, module.DENY],
                                "index": min(2, max(0, int(approval.get("index", 2))))}
                original_approval = tui._approval_lines
                def agent_approval(width, original_approval=original_approval):
                    rows = original_approval(width)
                    if not rows:
                        return rows
                    total = rows[0].cell_len
                    head = Text("╭", style=module.T_PRIMARY)
                    head.append("─ Approval required ", style=f"bold {module.T_WARNING}")
                    head.append("[CRITICAL / WORKSPACE] ", style=module.T_MUTED)
                    head.append("─" * max(0, total - 1 - head.cell_len), style=module.T_PRIMARY)
                    head.append("╮", style=module.T_PRIMARY)
                    rows[0] = head
                    options = [module.ALLOW_ONCE, module.ALLOW_SESSION, module.DENY]
                    selected = tui.approval["index"]
                    for position, row in enumerate(rows):
                        inner = row.plain[2:-2].strip()
                        for number, choice in enumerate(options):
                            if inner not in (choice, "› " + choice):
                                continue
                            chosen = number == selected
                            body = Text("› " if chosen else "  ", style=f"bold {module.T_PRIMARY}" if chosen else module.T_BORDER)
                            body.append(f"{number + 1}. {choice}", style=(f"bold {module.T_TEXT}" if choice == module.DENY else f"bold {module.T_SUCCESS}") if chosen else module.T_MUTED)
                            body.truncate(max(1, total - 4))
                            rebuilt = Text("│ ", style=module.T_PRIMARY)
                            rebuilt.append_text(body)
                            rebuilt.append(" " * max(0, total - 4 - body.cell_len))
                            rebuilt.append(" │", style=module.T_PRIMARY)
                            rows[position] = rebuilt
                    return rows
                tui._approval_lines = agent_approval
            elif approval:
                # The card must describe what is actually being approved; plan wording only for plan actions.
                action, target = str(approval["action"])[:40], str(approval["planId"])[:120]
                described = {
                    "subagent run": (L("Jalankan sub-agent " + target + " pada provider aktif", "Start sub-agent " + target + " on the active provider"),
                                     L("satu run Core Pandawa", "one Core Pandawa run"),
                                     L("Hanya provider offline fixture; provider live ditolak", "Offline fixture providers only; live providers are refused"), "Core Pandawa (agentHub)"),
                    "subagent cancel": (L("Batalkan run sub-agent " + target, "Cancel sub-agent run " + target), L("satu run Core Pandawa", "one Core Pandawa run"),
                                        L("Pembatalan dikonfirmasi lewat readback Core", "Cancellation is confirmed by Core readback"), "Core Pandawa (agentHub)"),
                    "provider use": (L("Ganti provider/model ke " + target, "Switch provider/model to " + target), L("pilihan provider Core dan profil privat", "Core provider selection and private profile"),
                                     L("Perubahan ini tidak menjalankan inferensi", "No inference is run by this change"), "Core provider registry"),
                    "model use": (L("Ganti model ke " + target, "Switch model to " + target), L("pilihan provider Core dan profil privat", "Core provider selection and private profile"),
                                  L("Perubahan ini tidak menjalankan inferensi", "No inference is run by this change"), "Core provider registry"),
                    "connect provider": (L("Hubungkan provider " + target + " (hanya metadata model)", "Connect provider " + target + " (model metadata only)"),
                                         L("konfigurasi provider", "provider configuration"),
                                         L("Inferensi live tidak diizinkan di build ini", "Live inference is not authorized in this build"), "Core provider registry"),
                }.get(action, (L("Aksi layanan sintetis terbatas", "Bounded synthetic service action"), L("plan versi ", "plan version ") + str(approval["version"]),
                               L("Tanpa inferensi atau eksekusi bebas", "No inference or arbitrary execution"), "DAMAR authenticated service"))
                request = SimpleNamespace(denied_by_policy=False, action=action, target=target, summary=described[0],
                                          scope=described[1], risk=L("Perlu peran Owner", "Owner role required"), reason=described[2],
                                          tool=described[3], source="USER_DIRECT", details=[])
                tui.approval = {"request": request, "options": [module.ALLOW_ONCE, module.DENY],
                                "index": int(approval.get("index", 1))}
            # Responsive rail: the design always keeps the Context/Live HUD rail; W5 hid it below 132 cols.
            # Installed before the transcript is built so response boxes are sized for the same main width the frame clips to.
            hud_position = state.get("hudPosition") if state.get("hudPosition") in ("left", "right", "bottom", "hidden") else "left"
            tui.sidebar_width = lambda: (module.SIDEBAR_WIDTH if hud_position in ("left", "right") and tui.sidebar_enabled and tui.console.width >= 110 else 0)
            # Agent transcript grammar (design): tool rows with badges, diff overlay box, run outcome, notices.
            success, info, error = "#73daca", "#2ac3de", "#f7768e"
            badge_colors = {"READ": module.T_MUTED, "GLOB": module.T_MUTED, "EDIT": module.T_PRIMARY, "CREATE": success,
                            "VERIFY": info, "TEST": success, "RUN": module.T_SECONDARY, "GREP": module.T_SECONDARY, "AGENT": module.T_SECONDARY}
            frame_no = int(state.get("animationFrame", 0))
            def agent_row(row):
                row.truncate(max(12, tui._text_width()), overflow="ellipsis")
                tui._append("tool", [row])
            def mix(fg, bg, alpha):
                a = [int(fg[i:i + 2], 16) for i in (1, 3, 5)]; b = [int(bg[i:i + 2], 16) for i in (1, 3, 5)]
                return "#" + "".join(f"{round(b[k] + (a[k] - b[k]) * alpha):02x}" for k in range(3))
            def glow_colour():
                # Design @keyframes damarGlow (1.8 s ease-in-out): border primary@45% <-> #f5a742@72% over the background.
                phase = (frame_no % 13) / 13.0
                k = 0.5 - 0.5 * math.cos(2 * math.pi * phase)
                return mix(mix("#f5a742", module.T_BG, 0.72), mix(module.T_PRIMARY, module.T_BG, 0.45), k)
            transcript = list(state.get("messages", [])[-200:])
            # While an agent turn runs, its glowing response box is visible from the start (not only while text streams).
            if state.get("agentBusy") is True and tui.busy and not (transcript and transcript[-1].get("kind") == "response" and transcript[-1].get("streaming") is True):
                transcript.append({"role": "assistant", "kind": "response", "streaming": True, "working": True, "text": L("Damar sedang bekerja…", "Damar is working…")})
            block_state = state.get("blockExpanded") if isinstance(state.get("blockExpanded"), dict) else {}
            for block_index, message in enumerate(transcript):
                text = str(message.get("text", ""))[:16384]
                kind = message.get("kind")
                block_open = block_state.get(str(block_index), True if kind == "response" else tui.details) is True
                block_control = ("[-]" if block_open else "[+]") + str(block_index) + " "
                if message.get("role") == "user":
                    tui.user(text)
                elif kind == "tool":
                    badge = str(message.get("badge", ""))[:8]
                    row = Text("  ")
                    row.append(f"[{badge}]".ljust(10), style=f"bold {badge_colors.get(badge, module.T_MUTED)}")
                    row.append(str(message.get("target", ""))[:300], style=module.T_TEXT)
                    agent_row(row)
                elif kind == "diff":
                    diff = message.get("diff") if isinstance(message.get("diff"), dict) else {}
                    lines = [line for hunk in (diff.get("hunks") or [])[:20] for line in (hunk.get("lines") or [])[:200] if isinstance(line, dict)]
                    changed = [line for line in lines if line.get("t") in ("+", "-")]
                    shown = lines if block_open else changed[:3]
                    hidden = 0 if block_open else max(0, len(changed) - len(shown))
                    width = max(20, tui._text_width() - 2)
                    inner = width - 4
                    border = module.T_BORDER
                    def framed(content):
                        content.truncate(inner, overflow="ellipsis")
                        row = Text("  │ ", style=border)
                        row.append_text(content)
                        row.append(" " * max(0, inner - content.cell_len))
                        row.append(" │", style=border)
                        return row
                    tui._append("tool", [Text("  ╭" + "─" * (width - 2) + "╮", style=border)])
                    counts = f"+{int(diff.get('added', 0))} -{int(diff.get('removed', 0))}"
                    title = Text(block_control + "diff · " + str(message.get("path", ""))[:120], style=module.T_MUTED)
                    title.truncate(max(4, inner - len(counts) - 1), overflow="ellipsis")
                    title.append(" " * max(1, inner - title.cell_len - len(counts)))
                    title.append(counts, style=module.T_MUTED)
                    tui._append("tool", [framed(title)])
                    tui._append("tool", [framed(Text("─" * inner, style=border))])
                    for line in shown:
                        mark = str(line.get("t", " "))[:1]
                        content = Text(f"{mark} {str(line.get('n', ''))[:6]:<5} ", style=module.T_MUTED)
                        body = str(line.get("text", ""))[:400]
                        if mark == "+":
                            content.append(" " + body + " ", style=f"{success} on #123326")
                        elif mark == "-":
                            content.append(" " + body + " ", style=f"{error} on #3a1a24")
                        else:
                            content.append(" " + body, style=module.T_MUTED)
                        tui._append("tool", [framed(content)])
                    if hidden:
                        tui._append("tool", [framed(Text(f"… {hidden} changed lines hidden · Ctrl+T", style=module.T_MUTED))])
                    tui._append("tool", [Text("  ╰" + "─" * (width - 2) + "╯", style=border)])
                elif kind == "outcome":
                    ok = message.get("ok") is True
                    agent_row(Text("    " + block_control + text[:200], style=success if ok else error))
                    output = [line for line in str(message.get("output", "")).splitlines() if line.strip()]
                    if output and (block_open or not ok):
                        rows_out = output if block_open else output[-6:]
                        if not block_open and len(output) > 6:
                            agent_row(Text(f"      … {len(output) - 6} more lines · Ctrl+T", style=module.T_MUTED))
                        for line in rows_out[-60:]:
                            agent_row(Text("      " + line[:300], style=module.T_MUTED if ok else error))
                elif kind == "pandawa":
                    # Design sub-agent block: orange while running, green when finished; Ctrl+T expands the output.
                    run_state = str(message.get("state", ""))
                    finished = run_state == "COMPLETED"
                    failed = run_state in ("FAILED", "CANCELLED", "OUTCOME_UNKNOWN")
                    border = success if finished else error if failed else "#ff9442"
                    width = max(20, tui._text_width() - 2)
                    inner = width - 4
                    def framed_box(content, border=border, inner=inner):
                        content.truncate(inner, overflow="ellipsis")
                        row = Text("  │ ", style=border)
                        row.append_text(content)
                        row.append(" " * max(0, inner - content.cell_len))
                        row.append(" │", style=border)
                        return row
                    started_at = message.get("startedAt") if isinstance(message.get("startedAt"), (int, float)) else None
                    ended_at = message.get("endedAt") if isinstance(message.get("endedAt"), (int, float)) else None
                    elapsed = int(max(0, ((ended_at or time.time() * 1000) - started_at) / 1000)) if started_at else None
                    clock = f" {elapsed // 60:02d}:{elapsed % 60:02d}" if elapsed is not None else ""
                    status = ("✓ finished" if finished else ("✗ " + run_state.lower().replace("_", " ")) if failed else "● running") + clock
                    worker = str(message.get("worker", "")).capitalize()
                    head = Text(block_control + "◆ [SUB-AGENT] " + worker + " · ", style=f"bold {border}")
                    head.append(str(message.get("task", ""))[:120], style=f"bold {border}")
                    head.truncate(max(4, inner - len(status) - 2), overflow="ellipsis")
                    head.append(" " * max(1, inner - head.cell_len - len(status)))
                    head.append(status, style=f"bold {border}")
                    tui._append("tool", [Text("  ╭" + "─" * (width - 2) + "╮", style=border)])
                    tui._append("tool", [framed_box(head)])
                    output_lines = [line for line in str(message.get("output") or "").splitlines() if line.strip()]
                    shown_out = output_lines if block_open else output_lines[:2]
                    for line in shown_out[:40]:
                        tui._append("tool", [framed_box(Text("  " + line[:300], style=module.T_TEXT))])
                    if not block_open and len(output_lines) > 2:
                        tui._append("tool", [framed_box(Text(f"  … {len(output_lines) - 2} more lines · Ctrl+T expand", style=module.T_MUTED))])
                    outcome = (L("sub-agent selesai · hasil diserahkan ke Damar", "sub-agent finished · result handed to Damar") if finished
                               else (L("sub-agent berhenti: ", "sub-agent stopped: ") + str(message.get("error") or run_state)) if failed
                               else L("menyusun temuan untuk Damar…", "preparing findings for Damar…"))
                    tui._append("tool", [framed_box(Text("  " + outcome, style=success if finished else error if failed else module.T_MUTED))])
                    tui._append("tool", [Text("  ╰" + "─" * (width - 2) + "╯", style=border)])
                elif kind == "reasoning":
                    # Reasoning is never drawn as the answer: one muted row stating that it exists and its size.
                    agent_row(Text("  ∴ " + text[:120], style=f"italic {module.T_MUTED}"))
                elif kind == "notice":
                    agent_row(Text("  " + text[:400], style=f"bold {error}" if text.startswith("!") else module.T_MUTED))
                else:
                    first = len(tui.lines)
                    # Wrap at the box body width ("│ " + body + " │"), so a row is never cut with an ellipsis.
                    full_width = tui._text_width
                    tui._text_width = lambda: max(12, full_width() - 4)
                    try:
                        tui.write(text)
                    finally:
                        tui._text_width = full_width
                    last = len(tui.lines)
                    if last > first:
                        width = max(12, min(tui.main_width() - 4, tui.console.width - 6))
                        body_width = max(8, width - 4)
                        active_response = tui.busy and message.get("streaming") is True
                        border_color = "#ff9442" if active_response and int(state.get("animationFrame", 0)) % 2 else module.T_PRIMARY
                        body_rows = []
                        if kind == "response":
                            # Response box: "Damar" head (Owner: no diamond) + "· streaming" / "· working", ember glow while the turn runs.
                            border_color = glow_colour() if active_response else module.T_PRIMARY
                            head = Text("Damar", style=f"bold {module.T_PRIMARY}")
                            if active_response:
                                head.append(L(" · bekerja", " · working") if message.get("working") else " · streaming", style=module.T_SECONDARY)
                            # Keep the brand heading first (Owner: plain "Damar") while retaining
                            # the per-block expand/collapse affordance and its mouse hitbox.
                            head.append(" " + block_control.strip(), style=module.T_MUTED)
                            row = Text("│ ", style=border_color)
                            row.append_text(head)
                            row.append(" " * max(0, body_width - head.cell_len))
                            row.append(" │", style=border_color)
                            row.stylize(f"on {module.T_PANEL}")
                            body_rows.append(("assistant", row))
                        source_rows = tui.lines[first:last]
                        if kind == "response" and not block_open and len(source_rows) > 6:
                            source_rows = [*source_rows[:5], ("assistant", Text(f"… {len(source_rows) - 5} more lines", style=module.T_MUTED))]
                        for _role, original in source_rows:
                            content = original.copy()
                            content.truncate(body_width, overflow="ellipsis")
                            row = Text("│ ", style=border_color)
                            row.append_text(content)
                            row.append(" " * max(0, body_width - content.cell_len))
                            row.append(" │", style=border_color)
                            row.stylize(f"on {module.T_PANEL}")
                            body_rows.append(("assistant", row))
                        top = Text("╭" + "─" * max(0, width - 2) + "╮", style=border_color)
                        bottom = Text("╰" + "─" * max(0, width - 2) + "╯", style=border_color)
                        tui.lines[first:last] = [("assistant", top), *body_rows, ("assistant", bottom)]
            # Apply requested view after rebuilding rows, otherwise append anchoring
            # changes the caller's explicit scroll offset during reconstruction.
            tui._view_len = len(tui.lines)
            scroll_limit = tui._scroll_limit()
            tui.scroll = min(scroll_limit, max(0, int(state.get("scroll", 0))))
            if selection is not None:
                tui.selection = selection
            # The Owner's left dock puts the rail IN FRONT of the main column, while the copied
            # prototype's selection geometry (and its stored cells) assume the main column first with
            # the rail appended after it. Translate each pointer once: a click on the front rail maps
            # to the prototype's appended-rail cells, a click in the main column drops the rail prefix.
            # Right/hidden/bottom keep the prototype coordinates untouched.
            def translate_pointer(event):
                pointer = SimpleNamespace(x=int(event.get('x', 0)), y=int(event.get('y', 0)))
                if hud_position == "left":
                    side_w = tui.sidebar_width()
                    if side_w and tui.sidebar_enabled:
                        x = pointer.x
                        pointer.x = x + tui.main_width() if 1 <= x <= side_w else max(0, x - side_w)
                return pointer
            for event in state.get('mouseEvents', [])[:128]:
                pointer = translate_pointer(event)
                if event.get('kind') == 'mouse_down':
                    tui._begin_selection(pointer)
                elif event.get('kind') == 'mouse_move':
                    tui._extend_selection(pointer)
                elif event.get('kind') == 'mouse_up':
                    tui._finish_selection()
            if state.get('clearSelection'):
                tui.selection.clear()
            if state.get('copySelection') and tui.selection.active():
                module.console_input.set_clipboard_text(tui.selection.text or tui._selection_text())
            selection = tui.selection
            tui._drag_scroll_tick()

            # ---- Owner Live HUD design deltas (damar_cli_live_hud_tui_preview.html) on top of the W5 frame ----
            messages_present = bool(state.get("messages"))
            intro = (not messages_present and not tui.busy and not tui.pick and not tui.approval
                     and not tui.modal_input and not tui.scroll)
            # Intro -> chat (design): the intro dissolves, a 1600 ms three-arm galaxy of 680 particles drifts over the body,
            # the content swaps to the chat at 28 % and the chat fades in.
            transition_ms = state.get("transitionMs") if isinstance(state.get("transitionMs"), (int, float)) and not isinstance(state.get("transitionMs"), bool) else None
            if transition_ms is not None and not (0 <= transition_ms < 1600):
                transition_ms = None
            dissolving = transition_ms is not None and transition_ms < 448
            if dissolving:
                intro = True
            def flame_art(animated):
                """The DAMAR flame as one block: (rows of equal width, width, colour of source row i)."""
                art = (module.BANNER_FRAMES[tui.anim_frame % len(module.BANNER_FRAMES)] if animated else module.BANNER).strip("\n").split("\n")
                nonblank = [a for a in art if a.strip()]
                indent = min((len(a) - len(a.lstrip()) for a in nonblank), default=0)
                art = [a[indent:] for a in art]
                art_w = max((len(a) for a in art), default=0)
                color_of = lambda i: module.FLAME_GRADIENT[(i + tui.anim_frame) % len(module.FLAME_GRADIENT)] if animated else module.T_PRIMARY
                return [a.ljust(art_w) for a in art], art_w, color_of
            def coverage(grid, art_w, keep):
                """`grid` shrunk to `keep` rows by area coverage: a cell is ink when >= 30 % of its source area is ink."""
                rows_n, f = len(grid), keep / len(grid)
                out_w = max(3, round(art_w * f)); rows = []
                for i in range(keep):
                    r0, r1 = i / f, (i + 1) / f; line = ""
                    for col in range(out_w):
                        c0, c1 = col / f, (col + 1) / f; area = ink = 0.0
                        for y in range(int(r0), min(rows_n, math.ceil(r1))):
                            wy = min(r1, y + 1) - max(r0, y)
                            for x in range(int(c0), min(art_w, math.ceil(c1))):
                                a = wy * (min(c1, x + 1) - max(c0, x)); area += a
                                ink += a if grid[y][x] != " " else 0.0
                        line += "." if area and ink / area >= 0.30 else " "
                    rows.append(line)
                return rows, out_w
            def scaled_flame(keep, animated=False):
                """The flame shrunk to `keep` rows (the design's CSS scale of the animated art). Each row's outer edges
                come from the steady silhouette, so the outline never wobbles; everything between them comes from the
                current animation frame, so the fire keeps burning inside (and the gradient keeps flowing). Shrinking
                frames alone moved edges by up to 3 cells per tick (glitch); the static silhouette alone only grew and
                shrank (no burning). Cached per size and frame."""
                cache = tui.__dict__.setdefault("_flame_scaled", {})
                key = (keep, tui.anim_frame % len(module.BANNER_FRAMES) if animated else None)
                if key not in cache:
                    grid, art_w, _ = flame_art(False)
                    steady, out_w = coverage(grid, art_w, keep)
                    if animated:
                        frame_grid, frame_w, _ = flame_art(True)
                        burning, _ = coverage(frame_grid, frame_w, keep)
                        rows = []
                        for edge_row, fire_row in zip(steady, burning):
                            ink = [i for i, ch in enumerate(edge_row) if ch != " "]
                            if not ink:
                                rows.append(edge_row); continue
                            left, right = ink[0], ink[-1]
                            rows.append("".join("." if i in (left, right) else (fire_row[i] if left < i < right else " ") for i in range(out_w)))
                        steady = rows
                    cache[key] = (steady, out_w)
                return cache[key]
            def section(title):
                head = Text("╭ ", style=module.T_BORDER)
                head.append(title, style=f"bold {module.T_PRIMARY}")
                head.append(" " + "─" * 12, style=module.T_BORDER)
                return head
            # Header gear: the Settings Control Center entry point (clickable; same as `settings`).
            original_header = tui._header_rows
            def header_rows(width):
                rows = original_header(width)
                # Owner decision: a plain "Setting" label (no icon, no brackets), aligned on the status row:
                # "workspace ask │ branch no git │ Setting".
                # The label is never dropped: a long workspace path is shortened from the left ("…tail") to make room.
                gear = Text("Setting", style=f"bold {module.T_PRIMARY}")
                full = original_header(10000)[1]          # same row with unlimited room: cwd + status
                at = full.plain.rfind("workspace  ")
                if at >= 0:
                    left, status = full[:at], full[at:]
                    left.rstrip(); status.rstrip()
                    sep = Text("  │  ", style=module.T_BORDER)
                    room = width - status.cell_len - sep.cell_len - gear.cell_len - 2
                    if room >= 8:
                        if left.cell_len > room:
                            left = Text("…" + left.plain[-(room - 1):], style=module.T_MUTED)
                        left.append(" " * (width - left.cell_len - status.cell_len - sep.cell_len - gear.cell_len))
                        left.append_text(status); left.append_text(sep); left.append_text(gear)
                        rows[1] = left
                    else:   # extremely narrow: the path gives way to the controls entirely
                        line = Text(" " * max(0, width - status.cell_len - sep.cell_len - gear.cell_len)); line.append_text(status); line.append_text(sep); line.append_text(gear)
                        rows[1] = line
                return rows
            tui._header_rows = header_rows
            catalogs = hud.get("catalogs") if isinstance(hud.get("catalogs"), dict) else {}
            def label(record, ready):
                if not isinstance(record, dict) or record.get("state") in (None, "NOT_QUERIED"):
                    return "not queried"
                if record.get("state") == "UNAVAILABLE":
                    return "UNAVAILABLE"
                return ready(record)
            mode_label = L("ask · persetujuan Owner per aksi", "ask · Owner approval per action")
            notice = state.get("notice").strip()[:300] if isinstance(state.get("notice"), str) else ""
            intro_notice = notice if intro else ""
            # Intro screen in the transcript area while nothing has been said yet.
            original_visible = tui._visible_transcript
            def particles(rows, height):
                if transition_ms is None:
                    return rows
                width = tui._text_width()
                header_n = 4 if len(rows) > 4 else 0
                body_h = max(1, height - header_n)
                vw, vh = 720.0, 400.0
                rng = random.Random(1600)
                theme_colors = html_themes.get(theme, html_themes["damar-ember"])
                palette_colors = [theme_colors["primary"], "#d4a857", "#c48b45", theme_colors["muted"], theme_colors["secondary"]]
                cx, cy = vw * 0.5, vh * 0.42
                frames = int(transition_ms / 16.67)
                t = min(1.0, transition_ms / 1600.0)
                def blend(color, alpha):
                    bg = theme_colors["bg"]
                    a = [int(color[i:i + 2], 16) for i in (1, 3, 5)]
                    b = [int(bg[i:i + 2], 16) for i in (1, 3, 5)]
                    return "#" + "".join(f"{round(b[k] + (a[k] - b[k]) * alpha):02x}" for k in range(3))
                cells = {}
                for index in range(680):
                    arm = index % 3
                    dist = rng.random() ** 0.75
                    angle = (arm * math.pi * 2) / 3 + dist * 4.0 + (rng.random() - 0.5) * 0.9
                    x = cx + (rng.random() - 0.5) * 70
                    y = cy + (rng.random() - 0.5) * 110
                    vx = math.cos(angle) * (0.4 + rng.random() * 1.4) + (rng.random() - 0.5) * 0.6
                    vy = math.sin(angle) * 0.6 * (0.4 + rng.random() * 1.2) + (rng.random() - 0.5) * 0.6
                    ang_vel = (0.012 + rng.random() * 0.018) * (1 - dist * 0.5)
                    phase = rng.random() * math.pi * 2
                    freq = 0.003 + rng.random() * 0.004
                    size = 0.8 + rng.random() * 1.7
                    color = palette_colors[int(rng.random() * len(palette_colors))]
                    fade_start = 0.12 + rng.random() * 0.58
                    fade_len = 0.22 + rng.random() * 0.28
                    max_alpha = 0.55 + rng.random() * 0.45
                    for step in range(frames):
                        angle += ang_vel
                        x += vx + math.cos(angle) * 0.45 + math.sin(phase + step * 16.67 * freq) * 0.35
                        y += vy + math.sin(angle) * 0.28
                        vx *= 0.992
                        vy *= 0.992
                    progress = min(1.0, max(0.0, (t - fade_start) / fade_len))
                    alpha = max_alpha * (1 - progress * progress * (3 - 2 * progress))
                    if alpha <= 0.05:
                        continue
                    col, row = int(x / vw * width), header_n + int(y / vh * body_h)
                    if 0 <= col < width and header_n <= row < height:
                        glyph = "•" if size > 1.9 and alpha > 0.6 else ("∙" if alpha > 0.35 else "·")
                        if (row, col) not in cells or cells[(row, col)][2] < alpha:
                            cells[(row, col)] = (glyph, blend(color, alpha), alpha)
                for (row, col), (glyph, color, _alpha) in cells.items():
                    base = rows[row]
                    if base.cell_len < width:
                        base.append(" " * (width - base.cell_len))
                    # A terminal cell holds one glyph: particles drift only through empty cells, text is never covered.
                    if col < len(base.plain) and base.plain[col] != " ":
                        continue
                    rows[row] = base[:col] + Text(glyph, style=color) + base[col + 1:]
                return rows
            def visible_transcript(height):
                rows = original_visible(height)
                if not intro:
                    if transition_ms is not None and transition_ms < 848:
                        for row in rows[4:]:
                            row.stylize("dim")   # chat fade-in right after the swap
                    return particles(rows, height)
                if dissolving:
                    rows = [rows[i] if i < 4 else Text("") for i in range(len(rows))]
                width = tui._text_width()
                animated = tui.banner_mode != "static"
                # Intro flame = the sidebar flame at full size: the same block (uniform-width rows, so centring moves the
                # whole silhouette, never single rows), the same frames, gradient and tick.
                grid, _art_w, color_of = flame_art(animated)
                body = [Text(""), Text("D A M A R", style=f"bold {module.T_PRIMARY}"), Text("Super AI Agent", style=f"bold {module.T_SECONDARY}"), Text("")]
                body.append(Text(f"model: {model_label}   ·   mode: {mode_label}", style=module.T_MUTED))
                body.append(Text(L("build pra-penerimaan · NOT REVIEW READY", "pre-acceptance build · NOT REVIEW READY"), style=module.T_MUTED))
                # Indonesian card labels are the approved design's own wording.
                cards = [("/connect", "Setup AI URL & Key", True), ("/plan", L("Susun To-Do Plan", "Build a to-do plan"), True),
                         ("/skills", L("belum tersedia", "not available yet"), False)]
                card_w = 22
                tops, cmds, descs, bots = Text(""), Text(""), Text(""), Text("")
                for position, (cmd, desc, available) in enumerate(cards):
                    gap = "  " if position else ""
                    border = module.T_BORDER
                    tops.append(gap + "╭" + "─" * (card_w - 2) + "╮", style=border)
                    cmds.append(gap + "│ ", style=border); cmds.append(cmd.ljust(card_w - 4), style=f"bold {module.T_PRIMARY if available else module.T_MUTED}"); cmds.append(" │", style=border)
                    descs.append(gap + "│ ", style=border); descs.append(desc.ljust(card_w - 4), style=module.T_MUTED); descs.append(" │", style=border)
                    bots.append(gap + "╰" + "─" * (card_w - 2) + "╯", style=border)
                card_rows = [Text(""), tops, cmds, descs, bots]
                # Startup / profile-restore notice lives in the intro, wrapped and never truncated.
                notice_rows = [Text(part, style=module.T_MUTED) for part in textwrap.wrap(intro_notice, max(20, width - 4))] if intro_notice else []
                if notice_rows:
                    notice_rows.insert(0, Text(""))
                header_n = 4 if len(rows) > 4 else 0
                space = height - header_n
                # The flame gets the rows left after the title, cards and notice. A window too short for the full art
                # shrinks the WHOLE flame (the sidebar's area-coverage scaling; it keeps burning);
                # it is never cropped. Below 6 rows the flame is left out rather than cut.
                fit = space - len(body) - len(card_rows) - len(notice_rows)
                if fit >= len(grid):
                    flame_rows = [Text(line, style=f"bold {color_of(index)}") for index, line in enumerate(grid)]
                elif fit >= 6:
                    flame_rows = [Text(line, style=f"bold {color_of(min(len(grid) - 1, index * len(grid) // fit))}") for index, line in enumerate(scaled_flame(fit, animated)[0])]
                else:
                    flame_rows = []
                block = flame_rows + body + card_rows + notice_rows
                if len(block) > space:
                    # Very short terminals: the title lines give way from the top; the notice and cards stay readable.
                    block = block[-space:] if space > 0 else []
                top = header_n + max(0, (space - len(block)) // 2)
                for offset, line in enumerate(block):
                    if top + offset >= height:
                        break
                    left = max(0, (width - line.cell_len) // 2)
                    centered = Text(" " * left)
                    centered.append_text(line)
                    if dissolving and transition_ms > 120:
                        centered.stylize("dim")   # intro dissolve (design: opacity 1 -> 0 over 350 ms)
                    if not (dissolving and transition_ms > 350):
                        rows[top + offset] = centered
                return particles(rows, height)
            tui._visible_transcript = visible_transcript

            # Design rail: progress-driven flame (hidden in the intro), Context, Capabilities, Plan x/N with the 14-cell bar,
            # Sub-Agent and Changes. Every value is live (session usage, Core catalogs, the agent's plan, real diffs and runs).
            plan_steps = [step for step in (state.get("plan") or []) if isinstance(step, dict) and isinstance(step.get("label"), str)][:12]
            interrupted = state.get("interrupted") is True
            messages_all = state.get("messages", [])[-200:]
            def live_sidebar(width, height):
                nonlocal flame_shown
                def kv_row(content):
                    line = Text("│ ", style=module.T_BORDER)
                    line.append_text(content)
                    line.truncate(width)
                    line.append(" " * max(0, width - line.cell_len))
                    line.stylize(f"on {module.T_PANEL}")
                    return line
                def kv(key, value, style=None):
                    content = Text(f"{key:<8} ", style=module.T_MUTED)
                    content.append(str(value)[:max(0, width - 12)], style=style or module.T_TEXT)
                    return kv_row(content)
                out = []
                done_n = sum(1 for step in plan_steps if step.get("state") == "done")
                total_n = len(plan_steps)
                pct = done_n / total_n if total_n else (0.25 if tui.busy else (0.5 if interrupted else 1.0))
                if not intro:
                    animated = tui.busy and tui.banner_mode != "static"
                    grid, art_w, color_of = flame_art(animated)
                    art = grid
                    # The WHOLE flame grows from small to large with the to-do percentage (design: scale 0.30 -> 1.0):
                    # rows = max(3, round(18 * (0.20 + 0.80 * pct))), columns scaled by the same factor, anchored at the base
                    # so the fire rises; the displayed size eases toward the target so each completed step visibly grows it.
                    flame_shown = pct if flame_shown is None else flame_shown + max(-0.12, min(0.12, pct - flame_shown))
                    keep = max(3, round(18 * (0.20 + 0.80 * flame_shown)))
                    factor = keep / len(art)
                    out_w = max(3, round(art_w * factor))
                    for _ in range(len(art) - keep):
                        out.append(kv_row(Text("")))
                    # Full size: the exact animation frame (identical to the intro). Smaller: the same frame scaled by area
                    # coverage, so it keeps burning (not the old any-glyph block sampling: blobs and a detached spark).
                    scaled_rows, out_w = (grid, art_w) if keep == len(art) else scaled_flame(keep, animated)
                    for index in range(keep):
                        source = min(len(art) - 1, int(index / factor))
                        scaled = scaled_rows[index].rstrip()
                        color = color_of(source)
                        pad = max(0, (width - 2 - out_w) // 2)
                        out.append(kv_row(Text(" " * pad + scaled, style=f"bold {color}")))
                    out.append(kv_row(Text("")))
                usage_state = state.get("usage") if isinstance(state.get("usage"), dict) else {}
                tokens_in, tokens_out = usage_state.get("inputTokens"), usage_state.get("outputTokens")
                tokens_ok = all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (tokens_in, tokens_out)) and usage_state.get("estimated") is False
                out.append(kv_row(section("Context")))
                out.append(kv("branch", tui._git_branch or "no git", module.T_MUTED))
                out.append(kv("model", model_label))
                out.append(kv("tokens", f"{module.compact_tokens(tokens_in)} in · {module.compact_tokens(tokens_out)} out" if tokens_ok else "—", module.T_MUTED))
                out.append(kv("mode", L("ask (setujui per aksi)", "ask (approve per action)"), module.T_MUTED))
                out.append(kv_row(Text("")))
                mcp = catalogs.get("mcp") if isinstance(catalogs.get("mcp"), dict) else {}
                plugins = catalogs.get("plugins") if isinstance(catalogs.get("plugins"), dict) else {}
                skills = catalogs.get("skills") if isinstance(catalogs.get("skills"), dict) else {}
                tools = catalogs.get("tools") if isinstance(catalogs.get("tools"), dict) else {}
                out.append(kv_row(section("Capabilities")))
                out.append(kv("skills", label(skills, lambda item: "read only"), module.T_SECONDARY))
                out.append(kv("plugins", label(plugins, lambda item: f"{item.get('plugins','?')} registered"), module.T_MUTED))
                out.append(kv("mcp", label(mcp, lambda item: f"{item.get('servers','?')} servers · {item.get('running','?')} running"), module.T_INFO))
                out.append(kv("tools", label(tools, lambda item: f"{item.get('tools','?')} · {item.get('shown','?')} shown" + (" +" if item.get("truncated") else "")), module.T_INFO))
                # Pandawa health (Core read): online count, per-agent state, or an explicit UNAVAILABLE.
                agents_state = hud.get("subagents") if isinstance(hud.get("subagents"), dict) else {}
                if agents_state.get("state") == "READ_ONLY":
                    out.append(kv_row(Text(f"Pandawa  {agents_state.get('online', '?')}/{agents_state.get('total', '?')} online", style=module.T_ACCENT)))
                    for agent in agents_state.get("agents", [])[:5]:
                        if isinstance(agent, dict) and isinstance(agent.get("label"), str):
                            out.append(kv_row(Text(f"  {agent['label'][:16]} · {str(agent.get('state', 'UNKNOWN'))[:12]}", style=module.T_MUTED)))
                elif agents_state.get("state") == "UNAVAILABLE":
                    out.append(kv_row(Text("Pandawa  UNAVAILABLE", style=module.T_MUTED)))
                if total_n and not intro:
                    out.append(kv_row(Text("")))
                    title = Text(f"Plan {done_n}/{total_n}", style=f"bold {module.T_PRIMARY}")
                    if tui.busy:
                        title.append(L(" · kerja berlanjut", " · work continues"), style=module.T_MUTED)
                    elif interrupted:
                        title.append(L(" · dihentikan", " · stopped"), style=error)
                    out.append(kv_row(title))
                    filled = round(pct * 14)
                    bar_color = error if interrupted else (success if done_n == total_n else module.T_PRIMARY)
                    bar = Text("▰" * filled, style=bar_color)
                    bar.append("▱" * (14 - filled), style=module.T_BORDER)
                    bar.append(f" {round(pct * 100)}%", style=module.T_MUTED)
                    out.append(kv_row(bar))
                    marks = {"done": ("✓", module.T_MUTED), "active": ("●", module.T_PRIMARY), "pending": ("○", module.T_TEXT), "stopped": ("✗", error)}
                    for step in plan_steps:
                        mark, mark_style = marks.get(step.get("state"), ("○", module.T_TEXT))
                        if step.get("state") == "active" and interrupted:
                            mark, mark_style = marks["stopped"]
                        row = Text(mark + " ", style=mark_style)
                        row.append(step["label"][:max(4, width - 6)], style=module.T_MUTED if step.get("state") == "done" else module.T_TEXT)
                        out.append(kv_row(row))
                last_run = next((m for m in reversed(messages_all) if m.get("kind") == "pandawa"), None)
                if last_run is None:
                    hud_runs = hud.get("subagentRuns") if isinstance(hud.get("subagentRuns"), list) else []
                    last_run = hud_runs[-1] if hud_runs and isinstance(hud_runs[-1], dict) else None
                # Parallel delegation: every agent of the latest delegation (up to 3), each with its live state.
                recent = [m for m in messages_all if m.get("kind") == "pandawa"][-3:]
                group = [m for m in recent if m.get("runId") and abs(int(m.get("startedAt") or 0) - int(recent[-1].get("startedAt") or 0)) < 5000] if recent else []
                if not group:
                    group = [r for r in (hud.get("subagentRuns") if isinstance(hud.get("subagentRuns"), list) else []) if isinstance(r, dict)][-4:]
                if len(group) > 1 and not intro:
                    out.append(kv_row(Text("")))
                    out.append(kv_row(Text("╭ Sub-Agents " + "─" * 7, style=f"bold {module.T_ACCENT}")))
                    for run in group:
                        rs = str(run.get("state", ""))
                        live = rs in ("ACCEPTED", "RUNNING")
                        label_state = L("berjalan", "running") if live else L("selesai", "finished") if rs == "COMPLETED" else rs.lower().replace("_", " ")
                        out.append(kv(str(run.get("worker", "?")).capitalize()[:10], label_state, "#ff9442" if live else success if rs == "COMPLETED" else error))
                    last_run = None
                if last_run and not intro:
                    run_state = str(last_run.get("state", ""))
                    finished = run_state == "COMPLETED"
                    running = run_state in ("ACCEPTED", "RUNNING")
                    out.append(kv_row(Text("")))
                    out.append(kv_row(Text("╭ Sub-Agent " + "─" * 8, style=f"bold {module.T_ACCENT}")))
                    out.append(kv("agent", str(last_run.get("worker", "?")).capitalize() + " (Pandawa)", module.T_ACCENT))
                    if last_run.get("task"):
                        out.append(kv("task", str(last_run.get("task"))[:40], module.T_MUTED))
                    out.append(kv("status", (L("berjalan", "running") if running else L("selesai", "finished") if finished else run_state.lower().replace("_", " ")),
                                  "#ff9442" if running else success if finished else error))
                files = {}
                for m in messages_all:
                    if m.get("kind") == "diff" and isinstance(m.get("diff"), dict):
                        added, removed = files.get(m.get("path"), (0, 0))
                        files[m.get("path")] = (added + int(m["diff"].get("added", 0)), removed + int(m["diff"].get("removed", 0)))
                if files and not intro:
                    out.append(kv_row(Text("")))
                    out.append(kv_row(section("Changes")))
                    total_a = sum(a for a, _ in files.values())
                    total_r = sum(r for _, r in files.values())
                    out.append(kv_row(Text(f"{len(files)} file{'s' if len(files) > 1 else ''}  +{total_a} -{total_r}", style=module.T_MUTED)))
                    for path_name, (a, r) in list(files.items())[-4:]:
                        out.append(kv_row(Text(f"  {str(path_name)[:22]}  +{a} -{r}", style=module.T_MUTED)))
                if len(out) > height:
                    # Short terminals: the flame yields first, the live sections stay.
                    context_row = next((i for i, row in enumerate(out) if "Context" in row.plain), 0)
                    out = out[min(context_row, len(out) - height):][:height]
                while len(out) < height:
                    out.append(kv_row(Text("")))
                return out
            tui._sidebar_lines = live_sidebar
            # Busy line (design): braille spinner, "Working" with a white glint sweeping every 13 ticks, MM:SS elapsed.
            original_input_box = tui._input_box
            palette = [item for item in (state.get("palette") or []) if isinstance(item, dict) and isinstance(item.get("cmd"), str)][:6]
            palette_index = min(len(palette) - 1, max(0, int(state.get("paletteIndex") or 0))) if palette else 0
            def input_box(width):
                rows = original_input_box(width)
                if tui.busy and rows:
                    spinner = module.SPINNER_FRAMES[tui.anim_frame % len(module.SPINNER_FRAMES)]
                    busy = Text(" " * module.CONTENT_PAD)
                    busy.append(spinner + " ", style=f"bold {module.T_PRIMARY}")
                    label_text = "Working"
                    head = tui.anim_frame % (len(label_text) + 6) if tui.banner_mode != "static" else -9
                    for index, char in enumerate(label_text):
                        distance = abs(index - head)
                        busy.append(char, style="bold #ffffff" if distance == 0 else "bold #ffe6b3" if distance == 1 else f"bold {module.T_PRIMARY}")
                    seconds = state.get("busySeconds")
                    if isinstance(seconds, int) and seconds >= 0:
                        busy.append(f"  {seconds // 60:02d}:{seconds % 60:02d}", style=module.T_MUTED)
                    rows[0] = module.clip_line(busy, width)
                if palette:
                    # Command palette above the composer (design: header, max 6 matches, first row marked and highlighted).
                    popup = [module.clip_line(Text(" " * module.CONTENT_PAD + "╭─ COMMAND PALETTE (Tab complete · Enter run)", style=f"bold {module.T_PRIMARY}"), width)]
                    for index, item in enumerate(palette):
                        chosen = index == palette_index
                        row = Text(" " * module.CONTENT_PAD + ("▸ " if chosen else "  "), style=f"bold {module.T_PRIMARY}")
                        row.append(item["cmd"][:16].ljust(16), style=f"bold {module.T_PRIMARY}" if item.get("available", True) else module.T_MUTED)
                        row.append(str(item.get("desc", ""))[:120], style=(module.T_TEXT if chosen else module.T_MUTED) if item.get("available", True) else f"italic {module.T_MUTED}")
                        row = module.clip_line(row, width)
                        if chosen:
                            row.stylize(f"on {mix(module.T_PRIMARY, module.T_BG, 0.18)}")   # design .slash-item.top tint
                        popup.append(row)
                    rows = popup + rows
                return rows
            tui._input_box = input_box
            # Footer: a truthful notice slot (startup/restore status) and, when the rail is hidden, a compact HUD line.
            # During the intro the notice is drawn inside the intro block and the footer keeps the original key hints.
            if notice and not intro:
                # Notice first so it is never the part cut off; the key hints follow it.
                hints = "Esc interrupt   Ctrl+T details" if tui.busy else "Enter send   Shift+Enter newline   / commands"
                tui.status_note = Text(notice + "   ·   " + hints, style=module.T_MUTED)
                tui.status_note_until = float("inf")
            # W5 key-hint row in Indonesian (key names unchanged).
            hint_text = {"Enter send   Shift+Enter newline   / commands": "Enter kirim   Shift+Enter baris baru   / perintah",
                         "Esc interrupt   Ctrl+T details": "Esc hentikan   Ctrl+T detail",
                         "PgDn latest   Ctrl+T details": "PgDn terbaru   Ctrl+T detail",
                         "Esc tutup BTW   Ctrl+T details": "Esc tutup BTW   Ctrl+T detail"}
            original_status = tui._status_lines
            def status_lines(width):
                rows = original_status(width)
                if not english and rows:
                    plain = rows[0].plain
                    for en_text, id_text in hint_text.items():
                        if en_text in plain:
                            rows[0] = module.clip_line(Text(plain.replace(en_text, id_text), style=module.T_MUTED), width)
                            break
                if tui.sidebar_width() == 0 and hud_position not in ("hidden", "bottom") and rows:
                    rows[0] = module.clip_line(rows[0], max(10, width - 16))
                    view_state = hud.get("viewState") if isinstance(hud.get("viewState"), str) else "INTRO"
                    rows[0].append(f"  ·  HUD {view_state[:12]}", style=f"bold {module.T_SECONDARY}")
                    rows[0] = module.clip_line(rows[0], width)
                return rows
            tui._status_lines = status_lines
            # Bottom is a horizontal dock, not the vertical sidebar moved to the bottom edge.
            # Build the same live sections, split them into independently sized columns, then
            # compose one row from each column. Keeping the flame renderer shared preserves its
            # progress scaling, gradient and animation frames across all dock positions.
            def bottom_hud(width, height):
                gap = 1 if width >= 56 else 0
                col_w = max(8, (width - 2 - gap * 5) // 6)
                source = live_sidebar(col_w, min(200, max(height, 48)))
                groups = {name: [] for name in ("flame", "context", "capabilities", "plan", "pandawa", "changes")}
                active = "flame"
                for row in source:
                    label = row.plain.strip(" │")
                    if "Context" in label and (label.startswith("Context") or label.startswith("╭ Context")):
                        active = "context"
                    elif "Capabilities" in label and (label.startswith("Capabilities") or label.startswith("╭ Capabilities")):
                        active = "capabilities"
                    elif label.startswith("Plan "):
                        active = "plan"
                    elif label.startswith("╭ Sub-Agent") or label.startswith("╭ Sub-Agents"):
                        active = "pandawa"
                    elif "Changes" in label and (label.startswith("Changes") or label.startswith("╭ Changes")):
                        active = "changes"
                    elif label.startswith("Pandawa "):
                        active = "pandawa"
                    if label:
                        groups[active].append(row)
                # The rightmost columns stay explicit even when there is no current plan, run,
                # or diff. This avoids a shifting layout as live data arrives.
                if not groups["plan"]:
                    groups["plan"] = [Text("│ Plan", style=f"bold {module.T_PRIMARY}"), Text("│ No active plan", style=module.T_MUTED)]
                if not groups["pandawa"]:
                    groups["pandawa"] = [Text("│ Pandawa", style=f"bold {module.T_ACCENT}"), Text("│ No active run", style=module.T_MUTED)]
                if not groups["changes"]:
                    groups["changes"] = [Text("│ Changes", style=f"bold {module.T_PRIMARY}"), Text("│ No file changes", style=module.T_MUTED)]
                names = ("flame", "context", "capabilities", "plan", "pandawa", "changes")
                cols = len(names)
                col_w = max(1, (width - 4 - gap * (cols - 1)) // cols)
                panel_rows = []
                for name in names:
                    content = groups[name]
                    if name == "flame":
                        # Scale the whole silhouette to the available dock height/column width; never crop its tip or base.
                        art, art_w, color_of = flame_art(tui.busy and tui.banner_mode != "static")
                        keep = min(len(content), height, max(3, round(len(art) * max(0.15, (col_w - 2) / max(1, art_w)))))
                        if keep < len(content):
                            scaled, out_w = scaled_flame(keep, tui.busy and tui.banner_mode != "static")
                            content = []
                            for index, art_row in enumerate(scaled):
                                source = min(len(art) - 1, int(index * len(art) / keep))
                                pad = max(0, (col_w - 2 - out_w) // 2)
                                content.append(Text("│ " + " " * pad + art_row.rstrip(), style=f"bold {color_of(source)}"))
                        else:
                            content = content[:height]
                    else:
                        content = content[:height]
                    panel_rows.append(content)
                used_h = min(height, max((len(panel) for panel in panel_rows), default=1))
                result = []
                for y in range(used_h):
                    line = Text("│ ", style=module.T_BORDER)
                    for ci, panel in enumerate(panel_rows):
                        if y < len(panel):
                            item = panel[y]
                            plain = item.plain
                            # Remove the vertical rail from the source column before adding the
                            # shared horizontal dock frame. Text slicing retains each span's color.
                            body = item[2:] if plain.startswith(("│ ", "││")) else item
                            body.truncate(col_w, overflow="ellipsis")
                            used = body.cell_len
                            line.append_text(body)
                        else:
                            used = 0
                        line.append(" " * max(0, col_w - used))
                        if ci + 1 < len(panel_rows):
                            line.append(" ", style=module.T_BORDER)
                    line.append(" " * max(0, width - line.cell_len - 2))
                    line.append(" │", style=module.T_BORDER)
                    line.truncate(width)
                    result.append(line)
                return result

            original_content = tui.frame_content
            def positioned_content():
                if hud_position == "right" or hud_position == "hidden" or not tui.sidebar_enabled:
                    return original_content()
                if hud_position == "left":
                    rows = original_content()
                    side_w = tui.sidebar_width()
                    if not side_w:
                        return rows
                    out = []
                    for index, row in enumerate(rows):
                        side_chars = side_w
                        main = row[:len(row.plain) - side_chars]
                        merged = row[len(row.plain) - side_chars:].copy()
                        merged.append_text(main)
                        out.append(merged)
                    return out
                # Reserve body rows for the horizontal HUD, with composer and keyboard hints above it.
                width = tui.main_width()
                box = tui._input_box(width); card = tui._approval_lines(width); status = tui._status_lines(width)
                hud_h = min(max(4, tui.console.height - len(box) - len(card) - len(status) - 2 - 3),
                            max(8, min(22, tui.console.height // 2)))
                transcript_h = max(1, tui.console.height - len(box) - len(card) - len(status) - 2 - hud_h)
                transcript = tui._visible_transcript(transcript_h)
                rows = []
                for source in transcript:
                    row = tui._content_pad(); row.append_text(module.clip_line(source, width - 2 * module.CONTENT_PAD)); rows.append(row)
                for source in card:
                    row = tui._content_pad(); row.append_text(module.clip_line(source, width - 2 * module.CONTENT_PAD)); rows.append(row)
                rows.extend(box); rows.extend(status)
                rows.extend(bottom_hud(width, hud_h))
                return rows

            tui.frame_content = positioned_content
            # Settings Control Center (Owner HTML prototype): a centered panel with six cards in a grid (3 / 2 / 1 columns by
            # width) holding real controls - dropdowns, text and masked key inputs, toggles and buttons - drawn from the
            # CLI's form view (settings-center.cjs). Every control reports an exact click hitbox (field, dropdown option).
            # When the panel is taller than the terminal, the body scrolls so the focused control stays visible.
            hitboxes = []
            settings_view = state.get("settings") if isinstance(state.get("settings"), dict) else None
            original_frame = tui.frame
            def settings_frame():
                view = settings_view
                rows = tui.frame_content()
                inner_w = rows[0].cell_len if rows else tui.console.width - 2
                modal_w = min(inner_w - 2, 172)
                compact = view.get("compact") is True
                card_layout = view.get("cardLayout") is True
                if compact and not card_layout:
                    modal_w = min(modal_w, 100)
                n_cols = 3 if modal_w >= 126 else 2 if modal_w >= 80 else 1
                if compact and not card_layout:
                    n_cols = 1
                col_w = (modal_w - 4 - 2 * (n_cols - 1)) // n_cols
                cw = col_w - 4                     # content width inside a card: "│ " + content + " │"
                if cw < 18:
                    return None
                fields = [f for f in view.get("fields", []) if isinstance(f, dict)][:48]
                titles = [str(t)[:60] for t in (view.get("cards") or [])][:6]
                tint = mix(module.T_PRIMARY, module.T_BG, 0.18)
                def fit(text, width):
                    text = str(text)
                    return text if len(text) <= width else text[:max(0, width - 1)] + "…"
                def card_lines(ci):
                    """[(Text of width cw, hit or None)] for one card; hit = (field_id, option_index or None)."""
                    out = []
                    for f in (x for x in fields if x.get("card") == ci):
                        fid, kind = str(f.get("id"))[:32], f.get("kind")
                        if compact and not card_layout and fid in ("save", "apply", "cancel"):
                            continue
                        focused, disabled = f.get("focused") is True, f.get("disabled") is True
                        label = str(f.get("label") or "")[:60]
                        if compact:
                            label = {
                                "revokeKey": L("Cabut API key", "Revoke API key"),
                                "model": "Model", "extraDir": L("Direktori tambahan", "Extra directories"),
                                "act-agents": "Pandawa", "act-context": L("Konteks", "Context"),
                                "act-review": L("Tinjau perubahan", "Review changes"),
                                "act-usage": L("Pemakaian token", "Token usage"),
                                "act-clear": L("Bersihkan layar", "Clear screen"),
                                "act-test": L("Tes koneksi", "Test connection"),
                                "act-doctor": "System Doctor",
                                "save": L("Simpan", "Save"),
                                "apply": L("Terapkan", "Apply"),
                                "cancel": L("Batal", "Cancel"),
                            }.get(fid, label)
                        value = "" if f.get("value") is None else str(f.get("value"))[:160]
                        mark = "› " if focused else "  "
                        label_style = f"bold {module.T_PRIMARY}" if focused else (module.T_MUTED if disabled else module.T_TEXT)
                        if kind == "toggle":
                            on = f.get("value") is True
                            sw = Text(" ON " if on else " OFF ", style=(f"bold {module.T_BG} on {module.T_PRIMARY}" if on else f"bold {module.T_MUTED} on {module.T_BG}"))
                            line = Text(mark + fit(label, cw - 9), style=label_style)
                            line.append(" " * max(1, cw - line.cell_len - sw.cell_len)); line.append_text(sw)
                            if focused:
                                line.stylize(f"on {tint}", 0, line.cell_len - sw.cell_len)
                            out.append((line, (fid, None)))
                        elif kind == "button":
                            primary = f.get("primary") is True
                            style = f"bold {module.T_BG} on {module.T_PRIMARY}" if primary else (f"bold {module.T_PRIMARY} on {tint}" if focused else f"{module.T_TEXT} on {module.T_BG}")
                            if disabled:
                                style = f"{module.T_MUTED} on {module.T_PANEL}"
                            line = Text(mark, style=f"bold {module.T_PRIMARY}")
                            line.append(" " + fit(label, cw - 6).center(cw - 4) + " ", style=style)
                            out.append((line, (fid, None)))
                        elif kind == "info":
                            line = Text(mark + fit(label, max(8, cw // 2 - 2)), style=module.T_MUTED)
                            line.append("  ")
                            line.append(fit(value, max(4, cw - line.cell_len)), style=f"bold {module.T_WARNING}" if value == "UNAVAILABLE" else module.T_TEXT)
                            out.append((line, None))
                        else:   # select, text, secret
                            out.append((Text(mark + fit(label, cw - 2), style=label_style), (fid, None)))
                            shown = value
                            placeholder = not shown and isinstance(f.get("placeholder"), str)
                            if placeholder:
                                shown = str(f.get("placeholder"))[:80]
                            caret = "▏" if focused and kind in ("text", "secret") else ""
                            arrow = " ▾" if kind == "select" else ""
                            inner = cw - 6 - len(arrow)
                            body_text = (fit(shown, inner - len(caret)) + caret).ljust(inner)
                            edge = module.T_BORDER_ACTIVE if focused else module.T_BORDER
                            box = Text("  [ ", style=edge)
                            box_style = module.T_MUTED if disabled or placeholder else (f"bold {module.T_TEXT}" if focused else module.T_TEXT)
                            box.append(body_text, style=box_style + (" italic" if placeholder else ""))
                            box.append(arrow, style=module.T_MUTED if disabled else module.T_PRIMARY)
                            box.append(" ]", style=edge)
                            if focused:
                                box.stylize(f"on {tint}", 2)
                            out.append((box, (fid, None)))
                            if f.get("open") is True and isinstance(f.get("options"), list):
                                chosen = f.get("openIndex") if isinstance(f.get("openIndex"), int) else 0
                                option_start = f.get("optionStart") if isinstance(f.get("optionStart"), int) else 0
                                visible_options = f["options"][option_start:option_start + 8]
                                if option_start:
                                    out.append((Text("    ↑ earlier options", style=module.T_MUTED), None))
                                for local_index, opt in enumerate(visible_options):
                                    oi = option_start + local_index
                                    if not isinstance(opt, dict):
                                        continue
                                    od = opt.get("disabled") is True
                                    row = Text(("    ▸ " if oi == chosen else "      ") + fit(opt.get("label", ""), cw - 6),
                                               style=f"italic {module.T_MUTED}" if od else (f"bold {module.T_PRIMARY}" if oi == chosen else module.T_TEXT))
                                    if oi == chosen:
                                        row.stylize(f"on {tint}")
                                    out.append((row, (fid, oi)))
                                if option_start + len(visible_options) < len(f["options"]):
                                    out.append((Text("    ↓ more options", style=module.T_MUTED), None))
                        for extra, is_error in ((None if compact else f.get("reason"), False), (f.get("error"), True)):
                            if isinstance(extra, str) and extra:
                                prefix = "    ✗ " if is_error else "    "
                                for part in textwrap.wrap(extra[:200], max(8, cw - len(prefix)))[:2]:
                                    out.append((Text(prefix + part, style=f"bold {module.T_ERROR}" if is_error else f"italic {module.T_MUTED}"), None))
                    return out
                cards = [card_lines(ci) for ci in range(6)]
                # Grid body: each band holds n_cols cards of equal height.
                body = []   # [(Text, [(x0, x1, hit)])] with x relative to the panel content start
                navigation, footer = [], []
                if compact:
                    section = max(0, min(5, int(view.get("section") or 0)))
                    nav, spans = Text(""), []
                    for si, name in enumerate(view.get("sections") or []):
                        label = f"{si + 1} {name}  "
                        if nav.cell_len + len(label) > modal_w - 4 and nav.cell_len:
                            body.append((nav, spans)); nav, spans = Text(""), []
                        x = nav.cell_len
                        nav.append(label, style=f"bold {module.T_PRIMARY}" if si == section else module.T_MUTED)
                        spans.append((x, nav.cell_len - 1, (f"@section{si}", None)))
                    body.append((nav, spans))
                    body.append((Text(""), []))
                    if card_layout:
                        navigation = body[:]
                        body = []
                for band in ([section] if compact and not card_layout else range(0, 6, n_cols)):
                    members = list(range(band, min(6, band + n_cols)))
                    height = max(len(cards[ci]) for ci in members) + 2
                    for line_no in range(height):
                        content, spans, x = Text(""), [], 0
                        for slot, ci in enumerate(members):
                            if slot:
                                content.append("  "); x += 2
                            title = titles[ci] if ci < len(titles) else ""
                            card_focus = any(f.get("focused") is True and f.get("card") == ci for f in fields)
                            edge = module.T_BORDER_ACTIVE if card_focus else module.T_BORDER
                            if line_no == 0:
                                head = Text("╭─ ", style=edge); head.append(fit(title, col_w - 6), style=f"bold {module.T_PRIMARY}")
                                head.append(" " + "─" * max(0, col_w - head.cell_len - 2) + "╮", style=edge)
                                content.append_text(head)
                            elif line_no == height - 1:
                                content.append("╰" + "─" * (col_w - 2) + "╯", style=edge)
                            else:
                                item = cards[ci][line_no - 1] if line_no - 1 < len(cards[ci]) else (Text(""), None)
                                cell = item[0].copy(); cell.truncate(cw); cell.append(" " * max(0, cw - cell.cell_len))
                                part = Text("", style=f"on {module.T_PANEL}"); part.append("│ ", style=edge); part.append_text(cell); part.append(" │", style=edge)
                                content.append_text(part)
                                if item[1] is not None:
                                    spans.append((x + 2, x + 2 + cw - 1, item[1]))
                            x += col_w
                        body.append((content, spans))
                if compact and not card_layout:
                    footer_start = len(body)
                    body.append((Text(""), []))
                    actions, spans = Text(""), []
                    for fid, label in (("save", L("Simpan", "Save")), ("apply", L("Terapkan", "Apply")), ("cancel", L("Batal", "Cancel"))):
                        x = actions.cell_len
                        focused = any(f.get("id") == fid and f.get("focused") for f in fields)
                        actions.append(f"[ {label} ]  ", style=f"bold {module.T_PRIMARY}" if focused else module.T_TEXT)
                        spans.append((x, actions.cell_len - 3, (fid, None)))
                    body.append((actions, spans))
                    if view.get("help"):
                        for part in textwrap.wrap(str(view["help"]), modal_w - 4):
                            body.append((Text(part, style=module.T_MUTED), []))
                    if card_layout:
                        footer = body[footer_start:]
                        body = body[:footer_start]
                # Scroll the body so the focused control is visible when the panel is taller than the terminal.
                if card_layout and view.get("help"):
                    footer = [(Text(part, style=module.T_MUTED), []) for part in textwrap.wrap(str(view["help"]), modal_w - 4)]
                room = len(rows) - 2 - 6 - len(navigation) - len(footer)
                if room < 8:
                    return None
                focus_line = next((i for i, (_, spans) in enumerate(body) for _, _, hit in spans
                                   if any(f.get("focused") is True and f.get("id") == hit[0] for f in fields)), 0)
                start = 0 if len(body) <= room else max(0, min(len(body) - room, focus_line - room // 2))
                shown = body[start:start + room]
                needed = len(shown) + 6 + len(navigation) + len(footer)
                top = max(1, (len(rows) - needed) // 2)
                left_x = max(0, (inner_w - modal_w) // 2)
                border = module.T_PRIMARY
                def boxed(content):
                    line = Text("", style=f"on {module.T_BG}"); line.append("│ ", style=border); line.append_text(content); line.truncate(modal_w - 2)
                    line.append(" " * max(0, modal_w - 2 - line.cell_len)); line.append(" │", style=border)
                    return line
                title = Text(str(view.get("title") or "")[:60], style=f"bold {module.T_PRIMARY}")
                if view.get("dirty") is True:
                    title.append(L("   ● perubahan belum diterapkan", "   ● unapplied changes"), style=f"bold {module.T_WARNING}")
                if len(body) > room:
                    title.append(L(f"   baris {start + 1}-{start + len(shown)} dari {len(body)}", f"   rows {start + 1}-{start + len(shown)} of {len(body)}"), style=module.T_MUTED)
                hint = Text(fit(view.get("hint") or "", modal_w - 6), style=module.T_MUTED)
                status_text = view.get("status") if isinstance(view.get("status"), str) else ""
                status = Text(fit(("… " if view.get("busy") is True else "") + status_text, modal_w - 6),
                              style=f"bold {module.T_SECONDARY}" if status_text else module.T_MUTED)
                modal = [(Text("╭" + "─" * (modal_w - 2) + "╮", style=border), []), (boxed(title), []), (boxed(hint), []),
                         *[(boxed(content), spans) for content, spans in navigation + shown + footer], (boxed(status), []), (Text("╰" + "─" * (modal_w - 2) + "╯", style=border), [])]
                for offset, (line, spans) in enumerate(modal):
                    row_index = top + offset
                    if row_index >= len(rows):
                        break
                    base = rows[row_index]
                    if base.cell_len < inner_w:
                        base.append(" " * (inner_w - base.cell_len))
                    rows[row_index] = base[:left_x] + line + base[left_x + modal_w:]
                    for x0, x1, hit in spans:
                        # frame coordinates: +1 row / +1 col for the outer frame border, +2 cols for the panel's "│ ".
                        box = {"y": row_index + 1, "x0": left_x + 1 + 2 + x0, "x1": left_x + 1 + 2 + x1, "field": hit[0]}
                        if hit[1] is not None:
                            box["option"] = hit[1]
                        hitboxes.append(box)
                return Text("\n").join(tui._framed(rows))
            if settings_view:
                tui.pick = None
                def frame_with_settings():
                    framed = settings_frame()
                    if framed is None:
                        hitboxes.clear()
                        return original_frame()
                    return framed
                tui.frame = frame_with_settings

            output = io.StringIO()
            capture = Console(file=output, width=cols, height=rows,
                              force_terminal=True, color_system=color_system)
            capture.print(tui.frame(), end="")
            rendered = output.getvalue()
            if not settings_view:
                for row_index, rendered_row in enumerate(rendered.splitlines()):
                    plain_row = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", rendered_row)
                    for match in re.finditer(r"\[[-+]\](\d+)\b", plain_row):
                        if int(match.group(1)) < len(transcript):
                            hitboxes.append({"y": row_index, "x0": match.start(), "x1": match.end() - 1,
                                             "block": int(match.group(1))})
            if legacy_caret:
                # Same single cells, glyphs the classic console fonts do have (Consolas lacks U+258F and U+25C9).
                rendered = rendered.replace("▏", "│").replace("◉", "●").replace("▰", "■").replace("▱", "□")
            sys.setprofile(None)
            sel = getattr(tui, "selection", None)
            selection_info = None
            if sel is not None and sel.active():
                try:
                    (first_row, start_cell), (last_row, end_cell) = sel.ordered()
                    selection_info = {"firstRow": first_row, "startCell": start_cell, "lastRow": last_row,
                                      "endCell": end_cell, "region": getattr(sel, "region", None),
                                      "textLen": len(sel.text) if getattr(sel, "text", None) else None,
                                      "dragging": bool(getattr(sel, "dragging", False))}
                except Exception:
                    selection_info = None
            print(json.dumps({"ok": True, "frame": rendered,
                              "renderer": "Owner W5 Tui.frame, exact copied source, with Owner Live HUD design deltas", "introActive": intro, "hitboxes": hitboxes,
                               "cols": cols, "rows": rows, "theme": theme,
                               "scroll": tui.scroll, "scrollLimit": scroll_limit,
                               "selectionActive": tui.selection.active(),
                               "selectionInfo": selection_info,
                              "executedOriginalFunctions": sorted(executed),
                              "personalHistoryImported": False}), flush=True)
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            sys.setprofile(None)
            print(json.dumps({"ok": False, "code": "W5_RENDER_FAILED",
                              "errorType": type(error).__name__}), flush=True)


if __name__ == "__main__":
    main()
