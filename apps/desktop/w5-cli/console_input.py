"""Windows console input for the DAMAR TUI: key events, mouse wheel, resize, clipboard.

The TUI takes over the console input buffer:

  * ENABLE_PROCESSED_INPUT off, so Ctrl+C arrives as a normal key event that
    the TUI handles itself (and Ctrl+Break still raises KeyboardInterrupt from
    the OS, which is why the TUI also guards KeyboardInterrupt).
  * ENABLE_MOUSE_INPUT on, so the wheel scrolls the transcript and left-button
    drags drive DAMAR-owned transcript text selection.
  * quick-edit off, so mouse events are not eaten by text selection.

`decode()` is a pure INPUT_RECORD -> Event function and is covered by
--self-test. `ConsoleInput.enable()` raises NotImplementedError outside
Windows; the caller falls back to plain output.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

NEW_LINE = 2

WHEEL_DELTA = 120

# A terminal without bracketed paste hands DAMAR one key record per pasted
# character.  No hand types this many cells inside a single drain, so a longer
# run is a paste and is folded into one event.
PASTE_BURST_CHARS = 8

STD_INPUT_HANDLE = -10

ENABLE_PROCESSED_INPUT = 0x0001
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_WINDOW_INPUT = 0x0008
ENABLE_MOUSE_INPUT = 0x0010
ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS = 0x0080
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200

KEY_EVENT = 0x0001
MOUSE_EVENT = 0x0002
WINDOW_BUFFER_SIZE_EVENT = 0x0004

MOUSE_WHEELED = 0x0004
MOUSE_HWHEELED = 0x0008
MOUSE_MOVED = 0x0001
DOUBLE_CLICK = 0x0002
FROM_LEFT_1ST_BUTTON_PRESSED = 0x0001
RIGHTMOST_BUTTON_PRESSED = 0x0002

LEFT_CTRL_PRESSED = 0x0008
RIGHT_CTRL_PRESSED = 0x0004
SHIFT_PRESSED = 0x0010

WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
CF_UNICODETEXT = 13

VK_SPECIALS = {
    0x08: "<backspace>", 0x09: "<tab>", 0x0D: "<enter>", 0x1B: "<esc>",
    0x21: "<pgup>", 0x22: "<pgdn>", 0x23: "<end>", 0x24: "<home>",
    0x25: "<left>", 0x26: "<up>", 0x27: "<right>", 0x28: "<down>",
    0x2E: "<del>",
}

INPUT_RECORD_SIZE = 20

if os.name == "nt":  # pragma: no cover - structure definitions only
    import ctypes

    class COORD(ctypes.Structure):
        _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

    class KEY_EVENT_RECORD(ctypes.Structure):
        _fields_ = [("bKeyDown", ctypes.c_int),
                    ("wRepeatCount", ctypes.c_ushort),
                    ("wVirtualKeyCode", ctypes.c_ushort),
                    ("wVirtualScanCode", ctypes.c_ushort),
                    ("uChar", ctypes.c_wchar),
                    ("dwControlKeyState", ctypes.c_uint)]

    class MOUSE_EVENT_RECORD(ctypes.Structure):
        _fields_ = [("dwMousePosition", COORD),
                    ("dwButtonState", ctypes.c_uint),
                    ("dwControlKeyState", ctypes.c_uint),
                    ("dwEventFlags", ctypes.c_uint)]

    class WINDOW_BUFFER_SIZE_RECORD(ctypes.Structure):
        _fields_ = [("dwSize", COORD)]

    class _EVENT_UNION(ctypes.Union):
        _fields_ = [("KeyEvent", KEY_EVENT_RECORD),
                    ("MouseEvent", MOUSE_EVENT_RECORD),
                    ("WindowBufferSizeEvent", WINDOW_BUFFER_SIZE_RECORD)]

    class INPUT_RECORD(ctypes.Structure):
        _fields_ = [("EventType", ctypes.c_ushort), ("Event", _EVENT_UNION)]

else:  # non-Windows: keep importable, raise on use
    INPUT_RECORD = object  # type: ignore[assignment,misc]
    KEY_EVENT_RECORD = MOUSE_EVENT_RECORD = WINDOW_BUFFER_SIZE_RECORD = object  # type: ignore


@dataclass
class Event:
    kind: str = "key"          # "key" | "paste" | "wheel" | "resize" | "mouse_down" | "mouse_move" | "mouse_up"
    key: str = ""              # char, or "<enter>" / "<up>" / "<ctrl-c>" ...
    text: str = ""             # a paste's whole text, one key record per char folded in
    delta: int = 0             # wheel steps, +1 per notch up
    width: int = 0             # resize
    height: int = 0
    x: int = 0                 # mouse cell column (0-based)
    y: int = 0                 # mouse cell row (0-based)
    button: str = ""           # "left" while a left-button drag/down is delivered


def sanitize_text(text: str) -> str:
    """Drop unpaired UTF-16 surrogates.

    The Windows clipboard is raw UTF-16: a mangled copy (an emoji cut in half,
    text from another app) hands back a lone surrogate that no later step can
    encode - not a UTF-8 file, not a JSON body.  Paired surrogates (real emoji)
    encode normally and are kept as they are.
    """
    if not any(0xD800 <= ord(char) <= 0xDFFF for char in text):
        return text
    return text.encode("utf-8", "replace").decode("utf-8", "replace")


def get_clipboard_text() -> str:
    """Read plain Unicode text from the Windows clipboard for Ctrl+V in TUI."""
    if os.name != "nt":
        return ""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.OpenClipboard.argtypes = [ctypes.c_void_p]
        user32.OpenClipboard.restype = ctypes.c_int
        user32.GetClipboardData.argtypes = [ctypes.c_uint]
        user32.GetClipboardData.restype = ctypes.c_void_p
        user32.CloseClipboard.argtypes = []
        kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalLock.restype = ctypes.c_void_p
        kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]

        if not user32.OpenClipboard(None):
            return ""
        try:
            handle = user32.GetClipboardData(CF_UNICODETEXT)
            if not handle:
                return ""
            ptr = kernel32.GlobalLock(handle)
            if not ptr:
                return ""
            try:
                text = ctypes.wstring_at(ptr)
                return sanitize_text(text.replace("\r\n", "\n").replace("\r", "\n"))
            finally:
                kernel32.GlobalUnlock(handle)
        finally:
            user32.CloseClipboard()
    except Exception:
        return ""


GMEM_MOVEABLE = 0x0002


def set_clipboard_text(text: str) -> bool:
    """Put plain Unicode text on the Windows clipboard.

    Returns True only when the clipboard actually accepted the data; callers
    must not report success based on the keypress alone.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.OpenClipboard.argtypes = [ctypes.c_void_p]
        user32.OpenClipboard.restype = ctypes.c_int
        user32.EmptyClipboard.restype = ctypes.c_int
        user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        user32.SetClipboardData.restype = ctypes.c_void_p
        user32.CloseClipboard.argtypes = []
        kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
        kernel32.GlobalAlloc.restype = ctypes.c_void_p
        kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalLock.restype = ctypes.c_void_p
        kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalFree.argtypes = [ctypes.c_void_p]

        buffer = ctypes.create_unicode_buffer(text.replace("\n", "\r\n"))
        size = ctypes.sizeof(buffer)
        if not user32.OpenClipboard(None):
            return False
        handle = None
        try:
            if not user32.EmptyClipboard():
                return False
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
            if not handle:
                return False
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                return False
            ctypes.memmove(pointer, buffer, size)
            kernel32.GlobalUnlock(handle)
            if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                return False
            handle = None  # the clipboard now owns the block
            return True
        finally:
            if handle:
                kernel32.GlobalFree(handle)
            user32.CloseClipboard()
    except Exception:
        return False


def _burst_cell(event: Event) -> Optional[str]:
    """The text one event contributes to a paste burst, or None if it ends it.

    Newlines and tabs count: a pasted file carries them, and left alone each
    newline fires the composer's submit mid-paste.  A bare modifier or arrow
    key is real input, not text, and closes the run.
    """
    if event.kind != "key":
        return None
    if len(event.key) == 1:
        return event.key
    if event.key == "<enter>":
        return "\n"
    if event.key == "<tab>":
        return "\t"
    return None


def coalesce_pastes(events: list[Event]) -> list[Event]:
    """Fold a run of typed cells long enough to be a paste into one event.

    A terminal that pastes without bracketed paste delivers one key record per
    character.  Left as-is, a 5000-character clipboard becomes 5000 keystrokes:
    the composer grows line by line and any newline inside it submits early.
    """
    out: list[Event] = []
    run: list[Event] = []
    cells: list[str] = []

    def flush() -> None:
        if len(cells) >= PASTE_BURST_CHARS:
            out.append(Event("paste", text="".join(cells)))
        else:
            out.extend(run)          # short run: ordinary typing, untouched
        run.clear()
        cells.clear()

    for event in events:
        cell = _burst_cell(event)
        if cell is None:
            flush()
            out.append(event)
            continue
        run.append(event)
        cells.append(cell)
    flush()
    return out


def decode(record, left_down: bool = False, right_down: bool = False) -> Optional[Event]:
    """Turn one INPUT_RECORD into an Event, or None for events to ignore.

    `left_down` is the caller's previous left-button state.  A Win32 mouse move
    record with no button held is indistinguishable from a release, so the
    reader supplies that one bit of history to keep this function pure.  The
    right button needs the same bit for the same reason: a right-click pastes
    once per press, and the move records that follow a held right button must
    not paste the clipboard again.
    """
    if record.EventType == KEY_EVENT:
        key_record = record.Event.KeyEvent
        if not key_record.bKeyDown:
            return None
        control = key_record.dwControlKeyState
        ctrl = bool(control & (LEFT_CTRL_PRESSED | RIGHT_CTRL_PRESSED))
        shift = bool(control & SHIFT_PRESSED)
        virtual = key_record.wVirtualKeyCode
        if ctrl and virtual == 0x43:            # Ctrl+C
            return Event("key", "<ctrl-c>")
        if ctrl and virtual == 0x54:            # Ctrl+T (toggle thinking)
            return Event("key", "<ctrl-t>")
        if ctrl and virtual == 0x56:            # Ctrl+V (paste clipboard)
            return Event("key", "<ctrl-v>")
        if virtual in VK_SPECIALS:
            name = VK_SPECIALS[virtual]
            # Some keyboards (Fn+arrow PgUp/PgDn on laptops) report the arrow key
            # with the page key's scan code.  Without this the page keys would
            # walk the prompt history instead of paging the transcript.
            if virtual in (0x26, 0x28) and key_record.wVirtualScanCode in (0x49, 0x51):
                name = "<pgup>" if key_record.wVirtualScanCode == 0x49 else "<pgdn>"
            if shift and name == "<enter>":
                return Event("key", "<shift-enter>")
            if shift and name in ("<up>", "<down>"):
                return Event("key", "<shift-" + name[1:])
            if ctrl and name in ("<left>", "<right>", "<up>", "<down>", "<home>", "<end>"):
                name = "<ctrl-" + name[1:]
            return Event("key", name)
        char = key_record.uChar
        if char in ("\x00", ""):
            return None
        if char == "\x03":
            return Event("key", "<ctrl-c>")
        if char == "\x14":
            return Event("key", "<ctrl-t>")
        if char == "\x16":
            return Event("key", "<ctrl-v>")
        if char in ("\r", "\n"):
            return Event("key", "<enter>")
        if char in ("\x08", "\x7f"):
            return Event("key", "<backspace>")
        if char == "\x1b":
            return Event("key", "<esc>")
        if char == "\t":
            return Event("key", "<tab>")
        return Event("key", char)
    if record.EventType == MOUSE_EVENT:
        mouse = record.Event.MouseEvent
        if mouse.dwEventFlags & MOUSE_WHEELED:
            raw = (mouse.dwButtonState >> 16) & 0xFFFF
            signed = ctypes.c_short(raw).value if os.name == "nt" else raw
            delta = int(signed / WHEEL_DELTA)
            if delta == 0 and signed:
                delta = 1 if signed > 0 else -1
            return Event("wheel", delta=delta)
        right = bool(mouse.dwButtonState & RIGHTMOST_BUTTON_PRESSED)
        held = bool(mouse.dwButtonState & FROM_LEFT_1ST_BUTTON_PRESSED)
        x, y = int(mouse.dwMousePosition.X), int(mouse.dwMousePosition.Y)
        if right:
            # A right press is one paste; a drag with it held is nothing at all.
            if right_down:
                return None
            return Event("mouse_down", x=x, y=y, button="right")
        if held:
            # A held left button means the owner is pressing or dragging; a move
            # record without the button held is not interesting to the TUI.
            return Event("mouse_move" if left_down else "mouse_down", x=x, y=y, button="left")
        if left_down:
            return Event("mouse_up", x=x, y=y)
        return None
    if record.EventType == WINDOW_BUFFER_SIZE_EVENT:
        size = record.Event.WindowBufferSizeEvent.dwSize
        return Event("resize", width=size.X, height=size.Y)
    return None


class ConsoleInput:
    """Blocking + non-blocking readers over ReadConsoleInputW."""

    def __init__(self) -> None:
        self._kernel32 = None
        self._handle = None
        self._old_mode: Optional[int] = None
        # The mode DAMAR last put on the console.  A tool's child process
        # (bash, node, powershell) can leave its own mode behind on exit, and a
        # console that no longer carries ENABLE_MOUSE_INPUT hands the owner's
        # drag to the terminal's own selection - which paints whole rows to the
        # buffer's right edge ("blok ... ujung ke ujung" the moment a run
        # started).  Reads re-assert this mode.
        self._held_mode: Optional[int] = None
        self._enabled = False
        # `read_timeout()` may receive several mouse-wheel records at once.
        # Keep every decoded record instead of dropping all but the first.
        self._pending: list[Event] = []
        # Win32 mouse records carry no explicit "release" bit, so keep the last
        # left-button state to turn the next bare move into a semantic mouse_up.
        self._left_down = False
        # The right button needs its own bit: a release record is dropped (the
        # TUI ignores it), so the flag is read off every mouse record instead.
        self._right_down = False

    def _decode(self, record) -> Optional[Event]:
        event = decode(record, self._left_down, self._right_down)
        if event is not None:
            self._left_down = event.kind in ("mouse_down", "mouse_move") and event.button != "right"
        if record.EventType == MOUSE_EVENT:
            self._right_down = bool(
                record.Event.MouseEvent.dwButtonState & RIGHTMOST_BUTTON_PRESSED)
        return event

    def enable(self) -> None:
        if os.name != "nt":
            raise NotImplementedError("TUI input needs Windows (ReadConsoleInputW)")
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetStdHandle.restype = ctypes.c_void_p
        kernel32.GetStdHandle.argtypes = [ctypes.c_uint]
        kernel32.GetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
        kernel32.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        kernel32.GetNumberOfConsoleInputEvents.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.ReadConsoleInputW.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(INPUT_RECORD), ctypes.c_uint,
            ctypes.POINTER(ctypes.c_ulong)]
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint
        handle = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        if not handle:
            raise NotImplementedError("no console stdin available")
        mode = ctypes.c_uint()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            raise NotImplementedError("GetConsoleMode failed (not a console?)")
        self._kernel32 = kernel32
        self._handle = handle
        self._old_mode = mode.value
        new_mode = mode.value
        for flag in (ENABLE_PROCESSED_INPUT, ENABLE_LINE_INPUT, ENABLE_ECHO_INPUT,
                     ENABLE_QUICK_EDIT_MODE, ENABLE_VIRTUAL_TERMINAL_INPUT):
            new_mode &= ~flag
        new_mode |= ENABLE_EXTENDED_FLAGS | ENABLE_MOUSE_INPUT | ENABLE_WINDOW_INPUT
        if not kernel32.SetConsoleMode(handle, new_mode):
            raise NotImplementedError("SetConsoleMode failed")
        self._held_mode = new_mode
        self._enabled = True

    def disable(self) -> None:
        if self._enabled and self._kernel32 is not None and self._handle:
            self._kernel32.SetConsoleMode(self._handle, self._old_mode or 0)
        self._held_mode = None
        self._enabled = False

    def _hold_mode(self) -> None:
        """Take the console mode back if a tool's child process left its own.

        Cheap enough to run before every read (one GetConsoleMode, and a
        SetConsoleMode only when the mode really drifted), so the app keeps
        owning the mouse while it works instead of the drag falling through to
        the terminal's own selection.
        """
        import ctypes
        if not (self._enabled and self._kernel32 is not None and self._handle
                and self._held_mode is not None):
            return
        mode = ctypes.c_uint()
        if not self._kernel32.GetConsoleMode(self._handle, ctypes.byref(mode)):
            return
        if mode.value != self._held_mode:
            self._kernel32.SetConsoleMode(self._handle, self._held_mode)

    def set_copy_mode(self, enabled: bool) -> bool:
        """Toggle native Quick Edit selection without changing the saved console mode.

        Quick Edit gives Windows Console/Terminal users ordinary drag selection
        and Ctrl+C copying.  It intentionally replaces mouse-wheel events while
        active; callers restore normal DAMAR scrolling by turning it back off.
        """
        if not self._enabled or self._kernel32 is None or not self._handle:
            return False
        import ctypes
        mode = ctypes.c_uint()
        if not self._kernel32.GetConsoleMode(self._handle, ctypes.byref(mode)):
            return False
        new_mode = mode.value | ENABLE_EXTENDED_FLAGS | ENABLE_WINDOW_INPUT
        if enabled:
            new_mode |= ENABLE_QUICK_EDIT_MODE
            new_mode &= ~ENABLE_MOUSE_INPUT
        else:
            new_mode &= ~ENABLE_QUICK_EDIT_MODE
            new_mode |= ENABLE_MOUSE_INPUT
        if not self._kernel32.SetConsoleMode(self._handle, new_mode):
            return False
        # The mode the reads keep holding: `/copy on` must not be undone by the
        # next read, and `/copy off` must not be undone by a tool's child.
        self._held_mode = new_mode
        return True

    # -- reading -------------------------------------------------------------
    def _read_record(self):
        import ctypes
        record = INPUT_RECORD()
        read = ctypes.c_ulong()
        if not self._kernel32.ReadConsoleInputW(
                self._handle, ctypes.byref(record), 1, ctypes.byref(read)) or not read.value:
            raise OSError("ReadConsoleInputW failed")
        return record

    def read(self) -> Event:
        """Block until one meaningful input event arrives."""
        self._hold_mode()
        if self._pending:
            return self._pending.pop(0)
        while True:
            event = self._decode(self._read_record())
            if event is not None:
                return event

    def read_timeout(self, timeout_ms: int = 120) -> Optional[Event]:
        """Wait up to timeout_ms for a meaningful input event (drives GIF animation)."""
        self._hold_mode()
        if self._pending:
            return self._pending.pop(0)
        if self._kernel32 is None or not self._handle:
            return self.read()
        res = self._kernel32.WaitForSingleObject(self._handle, max(10, int(timeout_ms)))
        if res != WAIT_OBJECT_0:
            return None
        events = self.poll()
        if not events:
            return None
        self._pending.extend(events[1:])
        return events[0]

    def poll(self) -> list[Event]:
        """Drain queued events without blocking, coalescing rapid mouse-wheel bursts."""
        self._hold_mode()
        import ctypes
        events: list[Event] = self._pending
        self._pending = []
        count = ctypes.c_ulong()
        while True:
            if not self._kernel32.GetNumberOfConsoleInputEvents(
                    self._handle, ctypes.byref(count)) or count.value == 0:
                break
            record = INPUT_RECORD()
            read = ctypes.c_ulong()
            if not self._kernel32.ReadConsoleInputW(
                    self._handle, ctypes.byref(record), 1, ctypes.byref(read)) or not read.value:
                break
            event = self._decode(record)
            if event is not None:
                events.append(event)

        # Terminal mouse wheels often arrive as a burst of one record per
        # notch. Redrawing a full-screen Rich frame for every record makes
        # scrolling feel delayed, so collapse only adjacent wheel events.
        # Drag moves collapse the same way: only the newest position matters.
        events = coalesce_pastes(events)
        coalesced: list[Event] = []
        for event in events:
            if event.kind == "wheel" and coalesced and coalesced[-1].kind == "wheel":
                coalesced[-1].delta += event.delta
            elif event.kind == "mouse_move" and coalesced and coalesced[-1].kind == "mouse_move":
                coalesced[-1] = event
            else:
                coalesced.append(event)
        return coalesced
