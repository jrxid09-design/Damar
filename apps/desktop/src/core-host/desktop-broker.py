"""Core-owned Computer-Use desktop helper (real Windows APIs; one JSON command per invocation).

This helper is NOT agent code and never runs agent code: it executes exactly one broker
command supplied as JSON on stdin and answers with one JSON line on stdout. It is spawned
by the Core host's own process, in isolated mode (-I), without a shell, and only after the
Owner authorized the exact target. Agent subprocesses stay in the no-capability AppContainer
(job-run.py) and never run this helper.

Invariants (fail closed):
  - Input dispatching verifies the foreground window BEFORE any input is sent, inside this
    same short-lived process, so a focus race cannot redirect the input.
  - Click/keyboard coordinates must fall inside the authorized target window rect.
  - No clipboard access of any kind (nothing is read or written).
  - No network APIs are used.
  - Unknown ops are refused.
"""
import ctypes as c
import os
from ctypes import wintypes as w
import hashlib
import json
import struct
import sys
import time
import zlib

user = c.WinDLL("user32", use_last_error=True)
kernel = c.WinDLL("kernel32", use_last_error=True)
gdi = c.WinDLL("gdi32", use_last_error=True)

user.SendInput.argtypes = [w.UINT, c.c_void_p, c.c_int]
user.SendInput.restype = w.UINT
user.MapVirtualKeyW.argtypes = [w.UINT, w.UINT]
user.MapVirtualKeyW.restype = w.UINT
user.VkKeyScanW.argtypes = [c.c_wchar]
user.VkKeyScanW.restype = w.SHORT

# Physical-pixel coordinates regardless of the python manifest: the screen math and any
# ground-truth fixture must agree cell for cell. SetProcessDPIAware is a no-op when the
# executable manifest already opted into per-monitor awareness.
user.SetProcessDPIAware()

SW_RESTORE = 9
VK_MENU = 0x12
VK_ESCAPE = 0x1B
VK_CONTROL = 0x11
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MAPVK_VK_TO_VSC = 0
# Virtual keys Windows reports with the extended bit set (scan code is shared with a
# numpad twin; without KEYEVENTF_EXTENDEDKEY, browsers map the event to the numpad
# code and KeyboardEvent.code never becomes e.g. "ArrowLeft").
EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
                0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5}
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000


class RECT(c.Structure):
    _fields_ = [("left", w.LONG), ("top", w.LONG), ("right", w.LONG), ("bottom", w.LONG)]


class POINT(c.Structure):
    _fields_ = [("x", w.LONG), ("y", w.LONG)]


class MOUSEINPUT(c.Structure):
    _fields_ = [("dx", w.LONG), ("dy", w.LONG), ("mouseData", w.DWORD), ("dwFlags", w.DWORD),
                ("time", w.DWORD), ("dwExtraInfo", c.POINTER(c.c_ulong))]


class KEYBDINPUT(c.Structure):
    _fields_ = [("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD), ("time", w.DWORD),
                ("dwExtraInfo", c.POINTER(c.c_ulong))]


class INPUTUNION(c.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("padding", c.c_byte * 24)]


class INPUT(c.Structure):
    _fields_ = [("type", w.DWORD), ("union", INPUTUNION)]


def window_info(hwnd):
    user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    user.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    user.GetWindowRect.argtypes = [w.HWND, c.POINTER(RECT)]
    title = c.create_unicode_buffer(512)
    user.GetWindowTextW(hwnd, title, 512)
    cls = c.create_unicode_buffer(256)
    user.GetClassNameW(hwnd, cls, 256)
    pid = w.DWORD(0)
    user.GetWindowThreadProcessId(hwnd, c.byref(pid))
    rect = RECT()
    user.GetWindowRect(hwnd, c.byref(rect))
    return {"hwnd": int(hwnd), "pid": int(pid.value), "title": title.value, "class": cls.value,
            "rect": [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]}


def enumerate_windows(limit):
    found = []

    @c.WINFUNCTYPE(c.c_int, w.HWND, w.LPARAM)
    def callback(hwnd, _lparam):
        if len(found) >= limit:
            return 0
        if not user.IsWindowVisible(hwnd):
            return 1
        info = window_info(hwnd)
        if info["title"].strip() or info["class"] in ("ConsoleWindowClass", "PseudoConsoleWindow"):
            found.append(info)
        return 1

    user.EnumWindows(callback, 0)
    return found


def foreground_info():
    return window_info(user.GetForegroundWindow())


def same_target(info, expect_hwnd, expect_title):
    if expect_hwnd is not None and int(expect_hwnd) == info["hwnd"]:
        return True
    if expect_title is not None and info["title"] == expect_title:
        return True
    return expect_hwnd is None and expect_title is None


SHELL_OVERLAY_TITLES = ("Start", "Search", "Windows Input Experience")


def dismiss_shell_overlay():
    """Transient shell overlays (Start menu, Search pane, Input Experience) are
    full-screen CoreWindows that hold the foreground and silently swallow the
    focus contract: SetForegroundWindow to any app window fails while one is
    up, and they reappear whenever a stray Windows-key press lands. Dismissing
    one with a single ESC tap is focus management aimed at the shell itself -
    the same class as the ALT-tap fallback in bring_to_front - never input to
    an application window. Returns True when an overlay was dismissed."""
    fg = user.GetForegroundWindow()
    if not fg:
        return False
    info = window_info(fg)
    if info["class"] != "Windows.UI.Core.CoreWindow" or info["title"] not in SHELL_OVERLAY_TITLES:
        return False
    user.keybd_event(VK_ESCAPE, 0, 0, 0)
    user.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.18)
    return True


def bring_to_front(hwnd):
    """SetForegroundWindow from a non-input process is restricted. The documented unlock is
    AttachThreadInput with the current foreground thread; it injects NO synthetic keys, so
    the target never arms its menu bar and never swallows a leading keystroke. The classic
    ALT tap stays only as a fallback, with a CTRL tap to cancel any menu mode it armed."""
    dismiss_shell_overlay()
    user.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.04)
    fg = user.GetForegroundWindow()
    fg_thread = user.GetWindowThreadProcessId(fg, None) if fg else 0
    this_thread = kernel.GetCurrentThreadId()
    attached = False
    if fg and fg_thread and fg_thread != this_thread:
        attached = bool(user.AttachThreadInput(this_thread, fg_thread, True))
    ok = bool(user.SetForegroundWindow(hwnd))
    if attached:
        user.AttachThreadInput(this_thread, fg_thread, False)
    if not ok:
        user.keybd_event(VK_MENU, 0, 0, 0)
        ok = bool(user.SetForegroundWindow(hwnd))
        user.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.15)
        user.keybd_event(VK_CONTROL, 0, 0, 0)
        user.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.12)
    return ok


def verify_foreground(expect_hwnd, expect_title):
    info = foreground_info()
    if same_target(info, expect_hwnd, expect_title):
        return info
    return None


def virtual_screen():
    # SM_XVIRTUALSCREEN(76), SM_YVIRTUALSCREEN(77), SM_CXVIRTUALSCREEN(78), SM_CYVIRTUALSCREEN(79)
    return (user.GetSystemMetrics(76), user.GetSystemMetrics(77),
            user.GetSystemMetrics(78), user.GetSystemMetrics(79))


def normalize_point(x, y):
    """MOUSEEVENTF_ABSOLUTE takes 0..65535 coordinates across the whole virtual
    screen, never pixels: convert the screen point once, right here."""
    vx, vy, vw, vh = virtual_screen()
    if vw <= 1 or vh <= 1:
        return max(0, min(65535, int(x))), max(0, min(65535, int(y)))
    nx = (int(x) - vx) * 65536 // (vw - 1)
    ny = (int(y) - vy) * 65536 // (vh - 1)
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def send_mouse(action, x, y):
    def flag_pair(a):
        return {"click": (MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP),
                "right": (MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP),
                "dblclick": (MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP)}.get(a)

    def mouse_event(flags, data=0):
        nx, ny = normalize_point(x, y)
        rec = INPUT(); rec.type = INPUT_MOUSE
        rec.union.mi = MOUSEINPUT(nx, ny, data, flags, 0, None)
        arr = (INPUT * 1)(rec)
        if not user.SendInput(1, arr, c.sizeof(INPUT)):
            return False
        return True

    if action == "move":
        return mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
    if action == "wheel":
        return mouse_event(MOUSEEVENTF_WHEEL | MOUSEEVENTF_ABSOLUTE, int(y) * 120)
    if action == "hwheel":
        return mouse_event(MOUSEEVENTF_HWHEEL | MOUSEEVENTF_ABSOLUTE, int(y) * 120)
    if action in ("down", "up"):
        flag = MOUSEEVENTF_LEFTDOWN if action == "down" else MOUSEEVENTF_LEFTUP
        return mouse_event(flag | MOUSEEVENTF_ABSOLUTE)
    if action in ("click", "right", "dblclick"):
        flags = flag_pair(action)
        half = MOUSEEVENTF_LEFTDOWN if action != "right" else MOUSEEVENTF_RIGHTDOWN
        halfup = MOUSEEVENTF_LEFTUP if action != "right" else MOUSEEVENTF_RIGHTUP
        if action == "dblclick":
            for _ in range(2):
                if not mouse_event(half | MOUSEEVENTF_ABSOLUTE) or not mouse_event(halfup | MOUSEEVENTF_ABSOLUTE):
                    return False
                time.sleep(0.02)
            return True
        return mouse_event(half | MOUSEEVENTF_ABSOLUTE) and mouse_event(halfup | MOUSEEVENTF_ABSOLUTE)
    raise ValueError("action")


def send_wheel(delta, horizontal=False):
    flags = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    rec = INPUT(); rec.type = INPUT_MOUSE
    rec.union.mi = MOUSEINPUT(0, 0, int(delta) * 120, flags, 0, None)
    return bool(user.SendInput(1, (INPUT * 1)(rec), c.sizeof(INPUT)))


def _key_input(vk, up=False):
    """One KEYBDINPUT carrying the key's real scan code (MapVirtualKey) and, for
    extended keys, KEYEVENTF_EXTENDEDKEY - the pair a physical keyboard produces,
    which is what browsers translate into KeyboardEvent.code."""
    rec = INPUT(); rec.type = INPUT_KEYBOARD
    flags = KEYEVENTF_KEYUP if up else 0
    if int(vk) in EXTENDED_VKS:
        flags |= KEYEVENTF_EXTENDEDKEY
    rec.union.ki = KEYBDINPUT(int(vk), int(user.MapVirtualKeyW(int(vk), MAPVK_VK_TO_VSC)), flags, 0, None)
    return rec


def _send_key(vk, up=False):
    return bool(user.SendInput(1, (INPUT * 1)(_key_input(vk, up)), c.sizeof(INPUT)))


def send_key(vk):
    return _send_key(vk) and _send_key(vk, True)


def _send_unicode_char(ch):
    for down in (0, KEYEVENTF_KEYUP):
        rec = INPUT(); rec.type = INPUT_KEYBOARD
        rec.union.ki = KEYBDINPUT(0, ord(ch), KEYEVENTF_UNICODE | down, 0, None)
        if not user.SendInput(1, (INPUT * 1)(rec), c.sizeof(INPUT)):
            return False
    return True


def send_text(text):
    """Type text as real key events whenever the active layout maps the character
    to a plain or Shift-only key (VkKeyScan): browsers then see the true
    KeyboardEvent.code ("Digit2", "KeyA") instead of a code-less Unicode event,
    which canvas/DOM field handlers rely on. Characters needing Ctrl/Alt combos
    or with no layout mapping keep the Unicode path."""
    sent = 0
    for ch in text:
        if ch in ("\r", "\n"):
            ok = send_key(0x0D)
        elif ch == "\t":
            ok = send_key(0x09)
        else:
            raw = user.VkKeyScanW(ch) & 0xFFFF
            vk, shift_state = raw & 0xFF, (raw >> 8) & 0xFF
            if raw == 0xFFFF or vk == 0xFF or (shift_state & ~1):
                ok = _send_unicode_char(ch)
            elif shift_state & 1:
                ok = _send_key(0x10) and send_key(vk) and _send_key(0x10, True)
            else:
                ok = send_key(vk)
        if not ok:
            return sent
        sent += 1
        time.sleep(0.004)
    return sent


MODIFIERS = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B}


def send_hotkey(vk, mods):
    held = []
    for name, vkmod in MODIFIERS.items():
        if mods.get(name):
            _send_key(vkmod); held.append(vkmod)
    time.sleep(0.03)
    send_key(int(vk))
    time.sleep(0.03)
    for vkmod in reversed(held):
        _send_key(vkmod, True)
    return True


def capture(path, hwnd=None, region=None, max_dim=None):
    """Capture pixels visible on the desktop, optionally limited to one window rect.
    Some packaged/WinUI apps return black from GetWindowDC, so use the desktop DC and
    the exact authorized window bounds instead. Analysis remains a bounded luminance map."""
    if hwnd:
        rect = RECT(); user.GetWindowRect(hwnd, c.byref(rect))
        base_left, base_top = rect.left, rect.top
        width, height = rect.right - rect.left, rect.bottom - rect.top
    else:
        base_left, base_top = 0, 0
        width, height = user.GetSystemMetrics(0), user.GetSystemMetrics(1)
    if region:
        rl, rt, rw, rh = region
        src_left, src_top = base_left + int(rl), base_top + int(rt)
        width, height = int(rw), int(rh)
    else:
        src_left, src_top = base_left, base_top
    width, height = max(1, min(width, 5120)), max(1, min(height, 2880))
    # GetDC(0) captures only the selected rectangle below; it never writes the full desktop
    # when hwnd identifies a window. Pixels outside that exact target remain unread.
    hdc = user.GetDC(0)
    mem = gdi.CreateCompatibleDC(hdc)
    bmp = gdi.CreateCompatibleBitmap(hdc, width, height)
    old = gdi.SelectObject(mem, bmp)
    if not gdi.BitBlt(mem, 0, 0, width, height, hdc, src_left, src_top, SRCCOPY | CAPTUREBLT):
        return None
    class BMIHEADER(c.Structure):
        _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG), ("biPlanes", w.WORD),
                    ("biBitCount", w.WORD), ("biCompression", w.DWORD), ("biSizeImage", w.DWORD),
                    ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
                    ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD)]
    bmi = BMIHEADER()
    c.memset(c.byref(bmi), 0, c.sizeof(BMIHEADER))
    bmi.biSize = c.sizeof(BMIHEADER); bmi.biWidth = width; bmi.biHeight = -height
    bmi.biPlanes = 1; bmi.biBitCount = 32; bmi.biCompression = 0
    row_bytes = width * 4
    buf = (c.c_ubyte * (row_bytes * height))()
    gdi.GetDIBits(mem, bmp, 0, height, buf, c.byref(bmi), 0)
    # BGRA -> RGBA rows for the PNG; a coarse luminance grid for deterministic change checks.
    ink_grid, cols_n, rows_n = [], 48, 27
    for gy in range(rows_n):
        line = []
        for gx in range(cols_n):
            px = int((gy + 0.5) / rows_n * height) * row_bytes + int((gx + 0.5) / cols_n * width) * 4
            b, g_, r = buf[px], buf[px + 1], buf[px + 2]
            line.append((r * 299 + g_ * 587 + b * 114) // 1000)
        ink_grid.append(line)
    png_rows = []
    for y in range(height):
        row = buf[y * row_bytes:(y + 1) * row_bytes]
        rgba = bytearray(row_bytes)
        rgba[0::4], rgba[1::4], rgba[2::4], rgba[3::4] = row[2::4], row[1::4], row[0::4], b"\xff" * width
        png_rows.append(bytes(rgba))
    # Optional stride downscale of the DELIVERED image only (fast perception for
    # real-time loops): the ink grid above always comes from native-resolution
    # pixels, so deterministic verification is unaffected. Scale is reported so
    # callers can map image coordinates back to screen coordinates.
    scale = 1
    if isinstance(max_dim, int) and not isinstance(max_dim, bool) and max_dim >= 64 and max(width, height) > max_dim:
        factor = (max(width, height) + max_dim - 1) // max_dim
        if factor > 1:
            small = []
            for row in png_rows[::factor]:
                chans = [row[ch::4][::factor] for ch in range(4)]
                out_row = bytearray(len(chans[0]) * 4)
                for ch in range(4):
                    out_row[ch::4] = chans[ch]
                small.append(bytes(out_row))
            png_rows = small
            # Declared dims must match the sliced rows exactly: slicing yields
            # ceil(dim/factor) rows/pixels, floor division would corrupt the PNG.
            height = len(png_rows)
            width = (len(png_rows[0]) // 4) if png_rows else width
            scale = factor

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in png_rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))
    gdi.SelectObject(mem, old); gdi.DeleteObject(bmp); gdi.DeleteDC(mem); user.ReleaseDC(0, hdc)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    flat = [value for line in ink_grid for value in line]
    return {"path": path, "width": int(width), "height": int(height), "sha256": digest,
            "ink": flat, "mean": sum(flat) // max(1, len(flat)), "scale": scale}


def point_in_rect(rect, x, y):
    l, t, r, b = rect
    return l <= int(x) < r and t <= int(y) < b


def main():
    try:
        command = json.loads(sys.stdin.read())
    except Exception:
        print(json.dumps({"ok": False, "error": "COMMAND_INVALID"})); return 1
    op = command.get("op")
    try:
        if op == "hello":
            print(json.dumps({"ok": True, "desktop": True,
                              "screen": [user.GetSystemMetrics(0), user.GetSystemMetrics(1)]}))
        elif op == "windows":
            print(json.dumps({"ok": True, "windows": enumerate_windows(min(200, int(command.get("limit", 60))))}))
        elif op == "foreground":
            print(json.dumps({"ok": True, "foreground": foreground_info()}))
        elif op == "focus":
            hwnd = int(command["hwnd"])
            bring_to_front(hwnd)
            info = foreground_info()
            if info["hwnd"] != hwnd:
                print(json.dumps({"ok": False, "error": "FOCUS_REFUSED", "foreground": info})); return 0
            print(json.dumps({"ok": True, "foreground": info}))
        elif op == "mouse":
            expect_hwnd = command.get("expect_hwnd")
            expect_title = command.get("expect_title")
            action = command["action"]; x, y = command.get("x"), command.get("y")
            cancel_flag = command.get("cancel_flag")
            def cancel_requested():
                return isinstance(cancel_flag, str) and os.path.isfile(cancel_flag)
            if cancel_requested():
                print(json.dumps({"ok": False, "error": "DESKTOP_CANCELLED"})); return 0
            if not isinstance(x, int) or isinstance(x, bool) or not isinstance(y, int) or isinstance(y, bool):
                print(json.dumps({"ok": False, "error": "POINT_REQUIRED"})); return 0
            if action == "wheel" and (not isinstance(command.get("delta", 1), int) or isinstance(command.get("delta", 1), bool) or abs(command.get("delta", 1)) > 100):
                print(json.dumps({"ok": False, "error": "WHEEL_DELTA_INVALID"})); return 0
            rect = None
            if expect_hwnd is not None:
                rect = window_info(int(expect_hwnd))["rect"]
                if not point_in_rect(rect, x, y):
                    print(json.dumps({"ok": False, "error": "POINT_OUTSIDE_TARGET",
                                      "target_rect": rect})); return 0
                if action == "drag":
                    end_x, end_y = command.get("end_x"), command.get("end_y")
                    if (not isinstance(end_x, int) or isinstance(end_x, bool) or
                            not isinstance(end_y, int) or isinstance(end_y, bool)):
                        print(json.dumps({"ok": False, "error": "POINT_REQUIRED"})); return 0
                    if not point_in_rect(rect, end_x, end_y):
                        print(json.dumps({"ok": False, "error": "POINT_OUTSIDE_TARGET",
                                          "target_rect": rect})); return 0
                if action == "path":
                    points = command.get("points")
                    if not isinstance(points, list) or len(points) < 2 or len(points) > 128 or any(
                            not isinstance(p, list) or len(p) != 2 or
                            any(not isinstance(v, int) or isinstance(v, bool) for v in p) for p in points):
                        print(json.dumps({"ok": False, "error": "PATH_INVALID"})); return 0
                    if not any(a != b for a, b in zip(points, points[1:])):
                        print(json.dumps({"ok": False, "error": "PATH_INVALID"})); return 0
                    if any(not point_in_rect(rect, p[0], p[1]) for p in points):
                        print(json.dumps({"ok": False, "error": "POINT_OUTSIDE_TARGET",
                                          "target_rect": rect})); return 0
            fg = verify_foreground(expect_hwnd, expect_title)
            if fg is None:
                print(json.dumps({"ok": False, "error": "FOREGROUND_MISMATCH",
                                  "foreground": foreground_info()})); return 0
            if action == "wheel":
                if not user.SetCursorPos(int(x), int(y)):
                    print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
                sent = send_wheel(command.get("delta", 1), command.get("horizontal") is True)
            elif action == "hwheel":
                if not user.SetCursorPos(int(x), int(y)):
                    print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
                sent = send_wheel(command.get("delta", 1), True)
            elif action == "drag":
                end_x, end_y = int(command["end_x"]), int(command["end_y"])
                if not user.SetCursorPos(int(x), int(y)):
                    print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
                down = False
                sent = True
                last_x, last_y = int(x), int(y)
                try:
                    down = send_mouse("down", last_x, last_y)
                    sent = down
                    distance = max(abs(end_x - int(x)), abs(end_y - int(y)))
                    steps = max(2, min(60, (distance + 23) // 24))
                    for step in range(1, steps + 1):
                        if not down or cancel_requested() or verify_foreground(expect_hwnd, expect_title) is None:
                            sent = False; break
                        last_x = round(int(x) + (end_x - int(x)) * step / steps)
                        last_y = round(int(y) + (end_y - int(y)) * step / steps)
                        if not send_mouse("move", last_x, last_y):
                            sent = False; break
                        time.sleep(0.008)
                finally:
                    if down:
                        sent = bool(send_mouse("up", last_x, last_y)) and sent
            elif action == "path":
                points = command["points"]
                duration_ms = command.get("duration_ms", 500)
                if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or not 0 <= duration_ms <= 5000:
                    print(json.dumps({"ok": False, "error": "DURATION_INVALID"})); return 0
                first_x, first_y = points[0]
                if not user.SetCursorPos(int(first_x), int(first_y)):
                    print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
                down = False
                sent = True
                last_x, last_y = int(first_x), int(first_y)
                segments = [(a, b, max(abs(b[0] - a[0]), abs(b[1] - a[1]))) for a, b in zip(points, points[1:])]
                total_distance = sum(segment for _, _, segment in segments)
                steps = max(len(points) - 1, min(120, max(2, (total_distance + 15) // 16)))
                interval = duration_ms / 1000 / steps if steps else 0
                try:
                    down = send_mouse("down", last_x, last_y)
                    sent = down
                    for step in range(1, steps + 1):
                        if not down or cancel_requested() or verify_foreground(expect_hwnd, expect_title) is None:
                            sent = False; break
                        distance = step / steps * total_distance
                        walked = 0
                        for a, b, segment in segments:
                            if walked + segment >= distance or (a, b, segment) == segments[-1]:
                                local = 1 if segment == 0 else max(0, min(1, (distance - walked) / segment))
                                last_x = round(a[0] + (b[0] - a[0]) * local)
                                last_y = round(a[1] + (b[1] - a[1]) * local)
                                break
                            walked += segment
                        if not send_mouse("move", last_x, last_y):
                            sent = False; break
                        if interval > 0: time.sleep(interval)
                finally:
                    if down:
                        sent = bool(send_mouse("up", last_x, last_y)) and sent
            else:
                if not user.SetCursorPos(int(x), int(y)):
                    print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
                sent = send_mouse(action, x, y)
            time.sleep(0.06)
            cursor = POINT(); user.GetCursorPos(c.byref(cursor))
            print(json.dumps({"ok": True, "sent": bool(sent), "cursor": [cursor.x, cursor.y],
                              "foreground": foreground_info(), "target_rect": rect}))
        elif op == "type":
            fg = verify_foreground(command.get("expect_hwnd"), command.get("expect_title"))
            if fg is None:
                print(json.dumps({"ok": False, "error": "FOREGROUND_MISMATCH",
                                  "foreground": foreground_info()})); return 0
            typed = send_text(str(command.get("text", ""))[:2000])
            print(json.dumps({"ok": True, "typed": typed, "foreground": foreground_info()}))
        elif op == "hotkey":
            fg = verify_foreground(command.get("expect_hwnd"), command.get("expect_title"))
            if fg is None:
                print(json.dumps({"ok": False, "error": "FOREGROUND_MISMATCH",
                                  "foreground": foreground_info()})); return 0
            sent = send_hotkey(int(command["vk"]), command.get("modifiers") or {})
            print(json.dumps({"ok": True, "sent": bool(sent), "foreground": foreground_info()}))
        elif op == "setfield":
            # Composite field entry for small dialog inputs: focus the field,
            # select its current content, type the replacement as real key
            # events, commit the way the dialog expects, then read back a tight
            # native-resolution crop around the field as evidence of the value
            # that actually landed (a whole-window diff cannot see a 2-digit
            # change in a 48x27 field).
            expect_hwnd = command.get("expect_hwnd")
            expect_title = command.get("expect_title")
            x, y = command.get("x"), command.get("y")
            if not isinstance(x, int) or isinstance(x, bool) or not isinstance(y, int) or isinstance(y, bool):
                print(json.dumps({"ok": False, "error": "POINT_REQUIRED"})); return 0
            if expect_hwnd is None:
                print(json.dumps({"ok": False, "error": "POINT_OUTSIDE_TARGET"})); return 0
            rect = window_info(int(expect_hwnd))["rect"]
            if not point_in_rect(rect, x, y):
                print(json.dumps({"ok": False, "error": "POINT_OUTSIDE_TARGET",
                                  "target_rect": rect})); return 0
            fg = verify_foreground(expect_hwnd, expect_title)
            if fg is None:
                print(json.dumps({"ok": False, "error": "FOREGROUND_MISMATCH",
                                  "foreground": foreground_info()})); return 0
            if not user.SetCursorPos(int(x), int(y)):
                print(json.dumps({"ok": False, "error": "CURSOR_MOVE_FAILED"})); return 0
            if not send_mouse("dblclick", x, y):
                print(json.dumps({"ok": False, "error": "DISPATCH_FAILED"})); return 0
            time.sleep(0.18)
            send_hotkey(0x41, {"ctrl": True})
            time.sleep(0.05)
            typed = send_text(str(command.get("text", ""))[:64])
            time.sleep(0.08)
            commit = command.get("commit", "enter")
            if commit == "enter":
                send_key(0x0D)
            elif commit == "tab":
                send_key(0x09)
            time.sleep(0.15)
            win_w, win_h = rect[2] - rect[0], rect[3] - rect[1]
            rw = command.get("region_w", 280)
            rh = command.get("region_h", 64)
            if not isinstance(rw, int) or isinstance(rw, bool):
                rw = 280
            if not isinstance(rh, int) or isinstance(rh, bool):
                rh = 64
            rw = max(16, min(rw, win_w)); rh = max(16, min(rh, win_h))
            rl = max(0, min(int(x) - rect[0] - rw // 2, win_w - rw))
            rt = max(0, min(int(y) - rect[1] - rh // 2, win_h - rh))
            readback = capture(command["path"], int(expect_hwnd), [rl, rt, rw, rh])
            if readback is None:
                print(json.dumps({"ok": False, "error": "CAPTURE_FAILED"})); return 0
            readback["region"] = [rl, rt, rw, rh]
            cursor = POINT(); user.GetCursorPos(c.byref(cursor))
            print(json.dumps({"ok": True, "sent": True, "typed": typed,
                              "cursor": [cursor.x, cursor.y],
                              "foreground": foreground_info(), "readback": readback}))
        elif op == "capture":
            hwnd = command.get("hwnd")
            result = capture(command["path"], int(hwnd) if hwnd else None, command.get("region"),
                             command.get("max_dim"))
            if result is None:
                print(json.dumps({"ok": False, "error": "CAPTURE_FAILED"})); return 0
            result["foreground"] = foreground_info()
            print(json.dumps({"ok": True, **result}))
        else:
            print(json.dumps({"ok": False, "error": "OP_UNKNOWN"})); return 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__ + ":" + str(error)[:120]}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
