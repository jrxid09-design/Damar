"""Owned console record reader, without legacy execution engines."""
import argparse
import ctypes as c
import importlib.util
import json
import sys
import threading
from pathlib import Path


def viewport_coordinates(x, y, left, top):
    """Convert console-buffer mouse positions to the visible terminal viewport."""
    return int(x) - int(left), int(y) - int(top)


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prototype', required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('damar_original_console', Path(args.prototype) / 'console_input.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [c.c_wchar_p, c.c_ulong, c.c_ulong, c.c_void_p, c.c_ulong, c.c_ulong, c.c_void_p]
    kernel.CreateFileW.restype = c.c_void_p
    kernel.GetConsoleMode.argtypes = [c.c_void_p, c.POINTER(c.c_ulong)]
    kernel.SetConsoleMode.argtypes = [c.c_void_p, c.c_ulong]
    kernel.CloseHandle.argtypes = [c.c_void_p]
    class COORD(c.Structure):
        _fields_ = [('X', c.c_short), ('Y', c.c_short)]
    class SMALL_RECT(c.Structure):
        _fields_ = [('Left', c.c_short), ('Top', c.c_short), ('Right', c.c_short), ('Bottom', c.c_short)]
    class CONSOLE_SCREEN_BUFFER_INFO(c.Structure):
        _fields_ = [('dwSize', COORD), ('dwCursorPosition', COORD), ('wAttributes', c.c_ushort),
                    ('srWindow', SMALL_RECT), ('dwMaximumWindowSize', COORD)]
    kernel.GetConsoleScreenBufferInfo.argtypes = [c.c_void_p, c.POINTER(CONSOLE_SCREEN_BUFFER_INFO)]
    kernel.GetConsoleScreenBufferInfo.restype = c.c_int
    kernel.WaitForSingleObject.argtypes = [c.c_void_p, c.c_ulong]
    kernel.ReadConsoleInputW.argtypes = [c.c_void_p, c.POINTER(module.INPUT_RECORD), c.c_ulong, c.POINTER(c.c_ulong)]
    handle = kernel.CreateFileW('CONIN$', 0xC0000000, 3, None, 3, 0, None)
    mode = c.c_ulong()
    if not kernel.GetConsoleMode(handle, c.byref(mode)):
        raise RuntimeError('NATIVE_CONSOLE_UNAVAILABLE')
    held_mode = (mode.value & ~(1 | 2 | 4 | 0x40 | 0x200)) | 0x80 | 0x10 | 8
    stop = threading.Event()
    def control():
        sys.stdin.buffer.read()
        stop.set()
    threading.Thread(target=control, daemon=True).start()
    pressed = set()
    left_down = False
    right_down = False
    try:
        if not kernel.SetConsoleMode(handle, held_mode):
            raise RuntimeError('NATIVE_CONSOLE_MODE_FAILED')
        emit({'kind': 'ready', 'initialMode': mode.value})
        while not stop.is_set():
            wait = kernel.WaitForSingleObject(handle, 20)
            if wait == 258:
                continue
            if wait != 0:
                raise RuntimeError('NATIVE_CONSOLE_WAIT_FAILED')
            records = (module.INPUT_RECORD * 128)()
            count = c.c_ulong()
            if not kernel.ReadConsoleInputW(handle, records, 128, c.byref(count)):
                raise RuntimeError('NATIVE_CONSOLE_READ_FAILED')
            batch = records[:count.value]
            paste_indexes = set()
            runs = []
            run = []
            def flush_run():
                # A single trailing Enter remains submit, matching the existing editor.
                # Multiline bursts must never execute their first line as a command.
                text = ''.join(batch[index].Event.KeyEvent.uChar for index in run)
                if len(run) >= module.PASTE_BURST_CHARS and ('\n' in text.rstrip('\r\n') or '\r' in text.rstrip('\r\n')):
                    runs.append(list(run))
                run.clear()
            for index, record in enumerate(batch):
                if record.EventType == module.KEY_EVENT:
                    key = record.Event.KeyEvent
                    if not key.bKeyDown:
                        continue
                    if not int(key.dwControlKeyState) & 15 and (key.uChar and key.uChar != '\x00' and (ord(key.uChar) >= 32 or key.uChar in '\r\n\t')):
                        run.append(index)
                        continue
                flush_run()
            flush_run()
            for indexes in runs:
                paste_indexes.update(indexes)
            paste_starts = {indexes[0]: ''.join(batch[index].Event.KeyEvent.uChar for index in indexes) for indexes in runs}
            for index, record in enumerate(batch):
                if record.EventType == module.KEY_EVENT:
                    key = record.Event.KeyEvent
                    identity = (int(key.wVirtualKeyCode), int(key.wVirtualScanCode))
                    down = bool(key.bKeyDown)
                    repeat = identity in pressed
                    if down:
                        pressed.add(identity)
                    else:
                        pressed.discard(identity)
                    if index in paste_indexes:
                        if index in paste_starts:
                            text = paste_starts[index].encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')
                            if len(text.encode('utf-8')) <= 8192:
                                emit({'kind': 'paste', 'text': text.replace('\r\n', '\n').replace('\r', '\n')})
                            else:
                                emit({'kind': 'inputError', 'code': 'PASTE_REJECTED'})
                        continue
                    if down and identity[0] == 0x56 and int(key.dwControlKeyState) & 12:
                        if not repeat:
                            clipboard = module.get_clipboard_text()
                            if len(clipboard.encode('utf-8')) > 8192:
                                emit({'kind': 'inputError', 'code': 'PASTE_REJECTED'})
                            else:
                                emit({'kind': 'paste', 'text': clipboard})
                        continue
                    emit({'kind': 'key', 'down': down, 'repeat': repeat, 'count': int(key.wRepeatCount),
                          'vk': identity[0], 'scan': identity[1], 'text': key.uChar,
                          'control': int(key.dwControlKeyState)})
                else:
                    event = module.decode(record, left_down, right_down)
                    if event is not None and event.kind in ('mouse_down', 'mouse_move', 'mouse_up'):
                        screen = CONSOLE_SCREEN_BUFFER_INFO()
                        if kernel.GetConsoleScreenBufferInfo(handle, c.byref(screen)):
                            event.x, event.y = viewport_coordinates(event.x, event.y, screen.srWindow.Left, screen.srWindow.Top)
                    if event is not None and event.kind in ('mouse_down', 'mouse_move', 'mouse_up'):
                        left_down = event.kind in ('mouse_down', 'mouse_move') and event.button != 'right'
                    if record.EventType == module.MOUSE_EVENT:
                        right_down = bool(record.Event.MouseEvent.dwButtonState & module.RIGHTMOST_BUTTON_PRESSED)
                    if event is not None:
                        if event.kind == 'mouse_down' and event.button == 'right':
                            clipboard = module.get_clipboard_text()
                            if len(clipboard.encode('utf-8')) <= 8192:
                                emit({'kind': 'paste', 'text': clipboard})
                            else:
                                emit({'kind': 'inputError', 'code': 'PASTE_REJECTED'})
                        else:
                            emit(vars(event))
    finally:
        restored = bool(kernel.SetConsoleMode(handle, mode.value))
        actual = c.c_ulong()
        measured = bool(kernel.GetConsoleMode(handle, c.byref(actual)))
        emit({'kind': 'stopped', 'restored': restored and measured and actual.value == mode.value,
              'initialMode': mode.value, 'finalMode': actual.value if measured else None})
        kernel.CloseHandle(handle)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit({'kind': 'error', 'code': 'NATIVE_INPUT_FAILED'})
        sys.exit(1)
