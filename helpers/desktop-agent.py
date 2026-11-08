#!/usr/bin/env python3
"""
Win32 desktop agent for dsh-computer-use-bg.

Speaks newline-delimited JSON over stdin/stdout, so the plugin can drive native
applications the same way it drives the browser: no window on top, no focus stolen
from whatever the user is doing.

Why this exists at all: the browser plane can reach anything with a DOM. A desktop
app has no DOM — but it does have windows, child controls, and a message queue, and
all three are reachable without touching the foreground window.

Two roles:

  (default)          the parent: one process per plugin session, stdin/stdout.
  --worker --port N  a proxy pinned to an isolated desktop. `CreateDesktopW` gives an
                     app its own invisible desktop; only a process *running on* that
                     desktop can enumerate or draw its windows, so a second process
                     lives there and answers over a loopback socket. That is what
                     makes "run this app without it ever appearing" real rather than
                     a promise.

Deliberately no dependency beyond the standard library: ctypes calls user32/gdi32
directly. A .NET / UIA route would give a richer control tree for modern apps but
cannot be verified in the environment this was built in, and shipping unverified
automation code is worse than shipping less of it.
"""

import ctypes
import json
import os
import socket
import tempfile
import struct
import subprocess
import sys
import threading
import time
import zlib
from ctypes import wintypes

import difflib

import ocr
import pixels

IS_WINDOWS = sys.platform.startswith('win')

# --- Win32 bindings --------------------------------------------------------

if IS_WINDOWS:
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)
else:  # pragma: no cover - the plugin is Windows-only, but import must not explode
    user32 = kernel32 = gdi32 = None

LRESULT = ctypes.c_ssize_t
HANDLE = ctypes.c_void_p
HWND = wintypes.HWND
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

GWL_STYLE = -16
GWL_ID = -12
GW_OWNER = 4
GW_CHILD = 5
GW_HWNDNEXT = 2
SMTO_ABORTIFHUNG = 0x0002
WM_SETTEXT = 0x000C
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_CLOSE = 0x0010
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MOUSEWHEEL = 0x020A
MK_LBUTTON = 0x0001
MK_RBUTTON = 0x0002
WS_DISABLED = 0x08000000
WS_VISIBLE = 0x10000000
PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002
DIB_RGB_COLORS = 0
GENERIC_ALL = 0x10000000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STARTF_USESHOWWINDOW = 0x00000001
SW_SHOWNORMAL = 1
CREATE_UNICODE_ENVIRONMENT = 0x00000400


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('lpReserved', wintypes.LPWSTR),
        ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR),
        ('dwX', wintypes.DWORD),
        ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD),
        ('dwYSize', wintypes.DWORD),
        ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD),
        ('dwFillAttribute', wintypes.DWORD),
        ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD),
        ('cbReserved2', wintypes.WORD),
        ('lpReserved2', ctypes.POINTER(ctypes.c_byte)),
        ('hStdInput', HANDLE),
        ('hStdOutput', HANDLE),
        ('hStdError', HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', HANDLE),
        ('hThread', HANDLE),
        ('dwProcessId', wintypes.DWORD),
        ('dwThreadId', wintypes.DWORD),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD),
        ('biWidth', ctypes.c_long),
        ('biHeight', ctypes.c_long),
        ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD),
        ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD),
        ('biXPelsPerMeter', ctypes.c_long),
        ('biYPelsPerMeter', ctypes.c_long),
        ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wintypes.DWORD * 3)]


def _bind():
    if not IS_WINDOWS:
        return
    u = user32
    u.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    u.EnumWindows.restype = wintypes.BOOL
    u.EnumChildWindows.argtypes = [HWND, WNDENUMPROC, wintypes.LPARAM]
    u.EnumChildWindows.restype = wintypes.BOOL
    u.GetWindowTextLengthW.argtypes = [HWND]
    u.GetWindowTextLengthW.restype = ctypes.c_int
    u.GetWindowTextW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.restype = ctypes.c_int
    u.GetClassNameW.argtypes = [HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetClassNameW.restype = ctypes.c_int
    u.IsWindow.argtypes = [HWND]
    u.IsWindowVisible.argtypes = [HWND]
    u.IsWindowEnabled.argtypes = [HWND]
    u.IsIconic.argtypes = [HWND]
    u.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
    u.GetClientRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
    u.ClientToScreen.argtypes = [HWND, ctypes.POINTER(wintypes.POINT)]
    u.ScreenToClient.argtypes = [HWND, ctypes.POINTER(wintypes.POINT)]
    u.GetWindowLongW.argtypes = [HWND, ctypes.c_int]
    u.GetWindowLongW.restype = ctypes.c_long
    u.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.GetWindow.argtypes = [HWND, wintypes.UINT]
    u.GetWindow.restype = HWND
    u.GetAncestor.argtypes = [HWND, wintypes.UINT]
    u.GetAncestor.restype = HWND
    u.PostMessageW.argtypes = [HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.SendMessageTimeoutW.restype = LRESULT
    u.SendMessageTimeoutW.argtypes = [
        HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t),
    ]
    u.PrintWindow.argtypes = [HWND, wintypes.HDC, wintypes.UINT]
    u.PrintWindow.restype = wintypes.BOOL
    u.SetForegroundWindow.argtypes = [HWND]
    u.ShowWindow.argtypes = [HWND, ctypes.c_int]
    u.GetFocus.restype = HWND
    u.GetForegroundWindow.restype = HWND
    # Desktops live in user32, not kernel32 — the obvious guess is wrong.
    u.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    u.CreateDesktopW.restype = HANDLE
    u.CloseDesktop.argtypes = [HANDLE]
    u.GetWindowDC.argtypes = [HWND]
    u.GetWindowDC.restype = wintypes.HDC
    u.ReleaseDC.argtypes = [HWND, wintypes.HDC]

    k = kernel32
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.OpenProcess.restype = HANDLE
    k.CloseHandle.argtypes = [HANDLE]
    k.QueryFullProcessImageNameW.argtypes = [HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k.CreateProcessW.restype = wintypes.BOOL
    k.CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION),
    ]

    g = gdi32
    g.CreateCompatibleDC.argtypes = [wintypes.HDC]
    g.CreateCompatibleDC.restype = wintypes.HDC
    g.CreateDIBSection.restype = wintypes.HBITMAP
    g.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    g.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    g.SelectObject.restype = wintypes.HGDIOBJ
    g.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    g.DeleteDC.argtypes = [wintypes.HDC]


_bind()


# --- helpers ---------------------------------------------------------------

def text_of(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ''
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def class_of(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def rect_of(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return {'left': r.left, 'top': r.top, 'right': r.right, 'bottom': r.bottom,
            'width': r.right - r.left, 'height': r.bottom - r.top}


def client_rect_of(hwnd):
    r = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    return {'width': r.right - r.left, 'height': r.bottom - r.top}


def client_origin(hwnd):
    """Where the client area starts, in screen pixels."""
    pt = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return {'x': pt.x, 'y': pt.y}


def pid_of(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


_PROCESS_NAMES = {}


def process_of(hwnd):
    pid = pid_of(hwnd)
    if pid in _PROCESS_NAMES:
        return _PROCESS_NAMES[pid], pid
    name = ''
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        try:
            size = wintypes.DWORD(1024)
            buf = ctypes.create_unicode_buffer(1024)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                name = buf.value.rsplit('\\', 1)[-1]
        finally:
            kernel32.CloseHandle(handle)
    _PROCESS_NAMES[pid] = name
    return name, pid


def win_id(hwnd):
    return 'w%08x' % (int(hwnd) & 0xFFFFFFFF)


def ctl_id(hwnd):
    return 'c%08x' % (int(hwnd) & 0xFFFFFFFF)


def parse_id(value):
    """`w1a2b3c4` / `c1a2b3c4` -> int handle."""
    raw = str(value or '').strip().lower()
    if raw[:1] in ('w', 'c'):
        raw = raw[1:]
    if not raw:
        raise ValueError('missing window id')
    try:
        return int(raw, 16)
    except ValueError:
        raise ValueError('"%s" is not an id from a previous call' % value)


def make_lparam(x, y):
    return (int(y) & 0xFFFF) << 16 | (int(x) & 0xFFFF)


def post(hwnd, message, wparam=0, lparam=0):
    return bool(user32.PostMessageW(hwnd, message, wparam, lparam))


def send_timeout(hwnd, message, wparam=0, lparam=0, timeout_ms=2000):
    result = ctypes.c_size_t(0)
    ok = user32.SendMessageTimeoutW(
        hwnd, message, wparam, lparam, SMTO_ABORTIFHUNG, timeout_ms, ctypes.byref(result)
    )
    return int(result.value) if ok else None


# --- enumeration -----------------------------------------------------------

SKIP_CLASSES = {
    'IME', 'MSCTFIME UI', 'GDI+ Hook Window Class', 'tooltips_class32',
    'TaskListThumbnailWnd', 'ForegroundStaging', 'Windows.UI.Core.CoreWindow',
    # Shell furniture: always visible, never something to drive.
    'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
    'Windows.UI.Composition.DesktopWindowContentBridge', 'SysShadow',
}

# Classes that say what a control *is*, which is what the model needs to choose one.
CONTROL_KINDS = {
    'button': 'button', 'edit': 'text field', 'richedit': 'rich text', 'richedit50w': 'rich text',
    'static': 'label', 'combobox': 'dropdown', 'comboboxex32': 'dropdown',
    'listbox': 'list', 'systreeview32': 'tree', 'syslistview32': 'list view',
    'sysheader32': 'header', 'msctls_trackbar32': 'slider', 'msctls_updown32': 'spinner',
    'msctls_progress32': 'progress bar', 'msctls_statusbar32': 'status bar',
    'systabcontrol32': 'tabs', 'toolbarwindow32': 'toolbar', 'scrollbar': 'scroll bar',
}


def kind_of(class_name):
    lowered = class_name.lower()
    if lowered in CONTROL_KINDS:
        return CONTROL_KINDS[lowered]
    if lowered.startswith('edit') or lowered.startswith('richedit'):
        return 'text field'
    if lowered.startswith('button'):
        return 'button'
    if lowered.startswith('static'):
        return 'label'
    if 'listview' in lowered:
        return 'list view'
    if 'treeview' in lowered:
        return 'tree'
    return ''


def visible_windows():
    found = []

    def callback(hwnd, _):
        if not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd):
            return True
        class_name = class_of(hwnd)
        if class_name in SKIP_CLASSES:
            return True
        rect = rect_of(hwnd)
        if rect['width'] <= 0 or rect['height'] <= 0:
            return True
        found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return found


def direct_children(hwnd):
    """
    Immediate child windows only.

    `EnumChildWindows` walks every descendant, so a breadth-first walk built on it
    would visit grandchildren twice and print the same control at two depths.
    """
    children = []
    child = user32.GetWindow(hwnd, GW_CHILD)
    while child:
        children.append(child)
        child = user32.GetWindow(child, GW_HWNDNEXT)
    return children


def has_children(hwnd):
    return len(direct_children(hwnd)) > 0


def window_info(hwnd, desktop='user'):
    name, pid = process_of(hwnd)
    return {
        'id': win_id(hwnd),
        'title': text_of(hwnd),
        'class': class_of(hwnd),
        'process': name,
        'pid': pid,
        'rect': rect_of(hwnd),
        'client': client_rect_of(hwnd),
        'minimized': bool(user32.IsIconic(hwnd)),
        'desktop': desktop,
        'kind': kind_of(class_of(hwnd)),
    }


def list_windows(desktop='user', process=None):
    result = []
    for hwnd in visible_windows():
        title = text_of(hwnd)
        class_name = class_of(hwnd)
        if class_name in SKIP_CLASSES:
            continue
        if not title and class_name.startswith('#'):
            continue
        info = window_info(hwnd, desktop)
        if not title and not has_children(hwnd):
            continue
        if process and process.lower() not in info['process'].lower():
            continue
        result.append(info)
    result.sort(key=lambda item: (item['pid'], item['rect']['top'], item['rect']['left']))
    return result


def control_tree(hwnd, max_nodes=240):
    """Breadth-first over direct children: enough for menus, dialogs and toolbars."""
    out = []
    queue = [(hwnd, 0)]
    while queue and len(out) < max_nodes:
        parent, depth = queue.pop(0)
        for child in direct_children(parent):
            if len(out) >= max_nodes:
                break
            style = user32.GetWindowLongW(child, GWL_STYLE)
            if not (style & WS_VISIBLE):
                continue
            class_name = class_of(child)
            out.append({
                'id': ctl_id(child),
                'class': class_name,
                'kind': kind_of(class_name),
                'text': text_of(child)[:120],
                'controlId': int(user32.GetWindowLongW(child, GWL_ID) or 0),
                'rect': rect_of(child),
                'enabled': not bool(style & WS_DISABLED),
                'depth': depth,
            })
            queue.append((child, depth + 1))
    return out


def read_text(target):
    length = send_timeout(target, WM_GETTEXTLENGTH)
    if length is None:
        raise RuntimeError('that control did not answer WM_GETTEXTLENGTH — it may be hung or not a text control')
    size = min(max(length, 0) + 1, 1 << 20)
    buf = ctypes.create_unicode_buffer(size)
    written = send_timeout(target, WM_GETTEXT, size, ctypes.addressof(buf), 2000)
    if written is None:
        raise RuntimeError('that control did not answer WM_GETTEXT')
    return buf.value


# --- screenshot ------------------------------------------------------------

def grab_stable(hwnd, client_only=True):
    """
    Capture twice and keep the richer frame.

    A composited window's first PrintWindow returns the surface it had *before* this call
    nudged it to paint: measured 10 distinct colours (title bar only), then 64 (the real
    content), with both calls reporting success. One capture is indistinguishable from an
    empty application, so every path that reads pixels goes through here — a second copy
    of this logic elsewhere is how `find` once searched a blank frame and reported
    "no matches" for text that was plainly on screen.
    """
    shot = pixels.grab(hwnd, client_only)
    time.sleep(0.06)
    second = pixels.grab(hwnd, client_only)
    return second if pixels.colours(second) > pixels.colours(shot) else shot


def capture(hwnd, path, client_only=True, grid=False):
    """
    Draw a window into a bitmap without showing it, optionally with a ruler on top.

    PrintWindow asks the app to paint into a DC we own, so it works for a window that is
    covered, off screen, or on an invisible desktop. A minimised window has nothing
    painted, and a few GPU-composited apps hand back an empty frame; both are reported
    as such instead of shipping a blank image.
    """
    shot = grab_stable(hwnd, client_only)
    rgb = shot['rgb']
    if grid:
        # The ruler exists for the case with no accessibility tree: estimating a pixel
        # from a bare rectangle is guesswork, estimating it off tick marks is not.
        rgb = pixels.draw_grid(shot['width'], shot['height'], rgb)
    pixels.write_png(path, shot['width'], shot['height'], rgb)
    return {
        'path': path,
        'width': shot['width'],
        'height': shot['height'],
        'clientOnly': shot['clientOnly'],
        'painted': shot['painted'],
        # `painted` is PrintWindow's own verdict and it is not enough: a composited window
        # with nothing rendered still reports True and hands back one flat colour.
        'colours': pixels.colours(shot),
        'grid': bool(grid),
        'clientOrigin': client_origin(hwnd),
    }


GA_ROOT = 2


def top_level(hwnd):
    """The top-level window that owns a control — the thing worth diffing."""
    if not hwnd:
        return None
    root = user32.GetAncestor(hwnd, GA_ROOT)
    return root or hwnd


def box_around(x, y, radius=64):
    """The area an action is expected to disturb, in client pixels."""
    return {'x': int(x) - radius, 'y': int(y) - radius, 'width': radius * 2, 'height': radius * 2}


def client_box_of(target, anchor):
    """A control's rectangle, expressed in the anchor window's client pixels."""
    rect = None
    raw = str(target or '')
    if raw.startswith('u'):
        api = get_uia()
        if api:
            try:
                r = api.describe(api.element_for(raw))['rect']
                rect = {'left': r['left'], 'top': r['top'], 'right': r['right'], 'bottom': r['bottom']}
            except Exception:  # noqa: BLE001 - a bad anchor only costs precision
                rect = None
    else:
        try:
            hwnd = parse_id(raw)
            if user32.IsWindow(hwnd):
                rect = rect_of(hwnd)
        except Exception:  # noqa: BLE001
            rect = None
    if not rect:
        return None
    top_left = wintypes.POINT(rect['left'], rect['top'])
    bottom_right = wintypes.POINT(rect['right'], rect['bottom'])
    user32.ScreenToClient(anchor, ctypes.byref(top_left))
    user32.ScreenToClient(anchor, ctypes.byref(bottom_right))
    return {'x': top_left.x, 'y': top_left.y,
            'width': max(1, bottom_right.x - top_left.x),
            'height': max(1, bottom_right.y - top_left.y)}


def act_region(payload, anchor):
    """
    Where this action should leave a mark.

    Comparing the whole window answers the wrong question on anything that animates: a
    clock, a cursor, a game loop. The region is what the caller pointed at, so a change
    inside it means the click landed and a change outside it means the scene moved on.
    """
    if not anchor:
        return None
    action = str(payload.get('action') or 'click').lower()
    if action == 'click':
        x = payload.get('x')
        y = payload.get('y')
        if x is not None and y is not None:
            if (payload.get('origin') or 'client') == 'screen':
                point = wintypes.POINT(int(x), int(y))
                user32.ScreenToClient(anchor, ctypes.byref(point))
                x, y = point.x, point.y
            return box_around(x, y)
        return client_box_of(payload.get('target'), anchor)
    if action == 'type':
        return client_box_of(payload.get('target'), anchor)
    return None


def describe_change(anchor, baseline, windows_before, region):
    """
    What actually changed, judged against the scene's own motion.

    Two signals, because one is not enough: the window's pixels (did the pointed-at area
    repaint?) and the set of visible windows (did a dialog appear?). A click that opens a
    modal changes the window list while the parent's pixels stay put; a click that only
    moves a caret changes pixels and adds no window.

    The two pre-action frames are what make the pixel half trustworthy. Whatever differs
    between them is the scene animating, and those pixels are excluded from the verdict
    instead of being reported as a successful click.
    """
    out = {}
    # A posted click and a UI change are not the same instant: a dialog is destroyed a
    # frame or two after the button's mouse-up, and the repaint lands after that.
    time.sleep(0.12)
    if anchor and not user32.IsWindow(anchor):
        # It closed: that is a change, and a very definite one.
        out['closed'] = True
        anchor = None
    if anchor and baseline:
        try:
            after = pixels.grab(anchor, True)
        except Exception as error:  # noqa: BLE001 - verification must never fail an action
            out['error'] = str(error)
        else:
            # Two measurements, side by side: what the area did on its own (noise,
            # measured across the baseline) and what it did around the action (signal).
            # Their relationship is the only honest verdict available — a slow, large
            # colour block can move less than the difference threshold between frames
            # and pass for still, so a bare "changed: true" would be a guess.
            noise = pixels.diff(baseline[0], baseline[-1], sample=2, region=region)
            signal = pixels.diff(baseline[-1], after, sample=2, region=region)
            still = pixels.diff_steady(baseline, after, region)
            out['local'] = {
                'noise': noise.get('ratio', 0.0),
                'signal': signal.get('ratio', 0.0),
                'steady': still.get('steady', 0.0),
                'where': signal.get('region'),
            }
            # Kept as context, never as the verdict: on an animated window this is
            # non-zero whatever the click did.
            whole = pixels.diff(baseline[0], after)
            out['global'] = {'ratio': whole.get('ratio', 0.0)}
    if windows_before is not None:
        appeared = [hwnd for hwnd in visible_windows() if hwnd not in windows_before]
        out['newWindows'] = [
            {'id': win_id(hwnd), 'title': text_of(hwnd)[:60], 'class': class_of(hwnd)} for hwnd in appeared[:4]
        ]
    return out


def act_anchor(payload):
    """Which window to watch: the target control's top-level, or the named window."""
    raw = str(payload.get('target') or '')
    if raw.startswith('u'):
        api = get_uia()
        if api:
            try:
                info = api.describe(api.element_for(raw))
                if info['nativeWindowHandle']:
                    return info['nativeWindowHandle']
            except Exception:  # noqa: BLE001
                pass
        raw = ''
    try:
        return parse_id(raw) if raw else (parse_id(payload.get('window')) if payload.get('window') else None)
    except Exception:  # noqa: BLE001
        return None


def _act_body(payload, isolated):
    """The action itself, with no verification around it."""
    action = str(payload.get('action') or 'click').lower()
    raw_target = str(payload.get('target') or '')
    if raw_target.startswith('u'):
        return act_on_uia_element(action, raw_target, payload, isolated)
    target = parse_id(payload.get('target')) if payload.get('target') else None
    window = parse_id(payload.get('window')) if payload.get('window') else None
    subject = target or window
    if not subject or not user32.IsWindow(subject):
        raise RuntimeError('need a live target (or window) from a previous call')
    if action == 'click':
        if target and payload.get('x') is None:
            return click_center(target)
        origin = payload.get('origin') or 'client'
        if origin == 'screen':
            point = wintypes.POINT(int(payload.get('x', 0)), int(payload.get('y', 0)))
            user32.ScreenToClient(subject, ctypes.byref(point))
            return click_at(subject, point.x, point.y, payload.get('button', 'left'), int(payload.get('count', 1)))
        return click_at(subject, int(payload.get('x', 0)), int(payload.get('y', 0)),
                        payload.get('button', 'left'), int(payload.get('count', 1)))
    if action == 'type':
        if target is None:
            raise RuntimeError('type needs a target control — pick one from the tree')
        return type_text(target, payload.get('text'))
    if action == 'key':
        return press_keys(subject, payload.get('keys'))
    if action == 'scroll':
        return scroll(subject, int(payload.get('x', 10)), int(payload.get('y', 10)), int(payload.get('delta', -120)))
    if action == 'focus':
        user32.SetForegroundWindow(subject)
        return {'focused': True, 'note': 'this does bring the window forward'}
    if action == 'close':
        post(subject, WM_CLOSE)
        return {'closed': True}
    raise RuntimeError('unknown action "%s"' % action)


def handle_act(payload, isolated):
    """
    Run one action, then say what changed.

    The verification is deliberately outside the action: a screenshot that fails must
    never turn a successful click into an error, and read/focus cannot change pixels.
    """
    action = str(payload.get('action') or 'click').lower()
    want_verify = action in ('click', 'type') and payload.get('verify') is not False

    anchor = None
    baseline = []
    region = None
    windows_before = None
    if want_verify:
        try:
            anchor = top_level(act_anchor(payload))
            region = act_region(payload, anchor)
            # Three frames spanning roughly the same span the after-shot will span:
            # anything that differs across them is the scene's own motion and cannot be
            # used as evidence that the click worked. Two frames is not enough — a slow
            # edge moves less than the threshold between two captures and passes for
            # still, which then scores a miss higher than a hit.
            if anchor:
                baseline.append(pixels.grab(anchor, True))
                time.sleep(0.07)
                baseline.append(pixels.grab(anchor, True))
                time.sleep(0.07)
                baseline.append(pixels.grab(anchor, True))
        except Exception:  # noqa: BLE001
            baseline = []
            region = None
        try:
            windows_before = set(visible_windows())
        except Exception:  # noqa: BLE001
            windows_before = None

    result = _act_body(payload, isolated)
    if want_verify and isinstance(result, dict):
        result['verify'] = describe_change(anchor, baseline, windows_before, region)
    return result


# --- input -----------------------------------------------------------------

VK = {
    'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'esc': 0x1B, 'escape': 0x1B,
    'space': 0x20, 'backspace': 0x08, 'delete': 0x2E, 'insert': 0x2D,
    'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
    'ctrl': 0x11, 'control': 0x11, 'alt': 0x12, 'shift': 0x10, 'win': 0x5B,
    'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74, 'f6': 0x75,
    'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
}


def vk_for(name):
    lowered = str(name or '').strip().lower()
    if lowered in VK:
        return VK[lowered]
    if len(lowered) == 1:
        return ord(lowered.upper())
    raise ValueError('unknown key "%s"' % name)


def click_at(hwnd, x, y, button='left', count=1):
    """Click at client coordinates of `hwnd` by posting the messages it would receive."""
    down = WM_LBUTTONDOWN if button == 'left' else WM_RBUTTONDOWN
    up = WM_LBUTTONUP if button == 'left' else WM_RBUTTONUP
    state = MK_LBUTTON if button == 'left' else MK_RBUTTON
    lparam = make_lparam(x, y)
    post(hwnd, WM_MOUSEMOVE, 0, lparam)
    time.sleep(0.02)
    for _ in range(max(1, count)):
        post(hwnd, down, state, lparam)
        time.sleep(0.02)
        post(hwnd, up, 0, lparam)
        time.sleep(0.02)
    return {'posted': True, 'x': x, 'y': y, 'button': button, 'count': count}


def click_center(target):
    """Click the middle of a control, in that control's own client coordinates."""
    rect = rect_of(target)
    width = rect['width']
    height = rect['height']
    return click_at(target, max(1, width // 2), max(1, height // 2))


def type_text(target, text):
    """Set the value of a text control, or type into whatever has focus."""
    value = str(text or '')
    low = class_of(target).lower()
    if low.startswith('edit') or low.startswith('richedit'):
        # The buffer has to outlive the call. Building it inline (`cast(c_wchar_p(v))`)
        # hands SendMessage a pointer whose only reference is gone before the message is
        # delivered — the control then stores whatever was in that memory, which reads
        # back as a couple of nonsense characters.
        buffer = ctypes.create_unicode_buffer(value)
        sent = send_timeout(target, WM_SETTEXT, 0, ctypes.addressof(buffer))
        if sent is None:
            raise RuntimeError('that text control did not accept WM_SETTEXT — it may be hung')
        return {'via': 'WM_SETTEXT', 'chars': len(value)}
    for ch in value:
        post(target, WM_CHAR, ord(ch), 1)
        time.sleep(0.005)
    return {'via': 'WM_CHAR', 'chars': len(value)}


def press_keys(target, spec):
    parts = [part.strip().lower() for part in str(spec or '').split('+') if part.strip()]
    if not parts:
        raise ValueError('keys is required')
    *mods, last = parts
    codes = [vk_for(mod) for mod in mods]
    for code in codes:
        post(target, WM_KEYDOWN, code, 1)
    main = vk_for(last)
    post(target, WM_KEYDOWN, main, 1)
    time.sleep(0.01)
    post(target, WM_KEYUP, main, 1)
    for code in reversed(codes):
        post(target, WM_KEYUP, code, 1)
    return {'keys': spec}


def scroll(hwnd, x, y, delta):
    point = wintypes.POINT(x, y)
    user32.ClientToScreen(hwnd, ctypes.byref(point))
    lparam = make_lparam(point.x, point.y)  # wheel takes screen coordinates
    wparam = ((int(delta) & 0xFFFF) << 16)
    post(hwnd, WM_MOUSEWHEEL, wparam, lparam)
    return {'delta': delta}


# --- isolated desktops -----------------------------------------------------

class Isolated:
    def __init__(self, name, worker, sock):
        self.name = name
        self.worker = worker
        self.sock = sock
        self.buffer = b''
        self.lock = threading.Lock()
        self.apps = []

    def call(self, payload, timeout=20.0):
        with self.lock:
            self.sock.sendall((json.dumps(payload) + '\n').encode('utf-8'))
            self.sock.settimeout(timeout)
            while b'\n' not in self.buffer:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise RuntimeError('the desktop worker for "%s" closed the connection' % self.name)
                self.buffer += chunk
            line, _, self.buffer = self.buffer.partition(b'\n')
            return json.loads(line.decode('utf-8'))

    def close(self):
        try:
            self.sock.sendall((json.dumps({'cmd': 'quit'}) + '\n').encode('utf-8'))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def start_isolated(name, script_path):
    handle = user32.CreateDesktopW(name, None, None, 0, GENERIC_ALL, None)
    if not handle:
        raise RuntimeError('CreateDesktopW failed (%s)' % ctypes.get_last_error())
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    port = listener.getsockname()[1]

    args = [sys.executable, script_path, '--worker', '--port', str(port)]
    command_line = subprocess.list2cmdline(args)
    startup = STARTUPINFOW()
    startup.cb = ctypes.sizeof(STARTUPINFOW)
    startup.lpDesktop = name
    startup.dwFlags = STARTF_USESHOWWINDOW
    startup.wShowWindow = SW_SHOWNORMAL
    info = PROCESS_INFORMATION()
    ok = kernel32.CreateProcessW(
        sys.executable, ctypes.create_unicode_buffer(command_line),
        None, None, False, CREATE_UNICODE_ENVIRONMENT, None, None,
        ctypes.byref(startup), ctypes.byref(info),
    )
    if not ok:
        user32.CloseDesktop(handle)
        listener.close()
        raise RuntimeError('could not start the worker on "%s" (%s)' % (name, ctypes.get_last_error()))

    listener.settimeout(15.0)
    try:
        conn, _ = listener.accept()
    except socket.timeout:
        listener.close()
        raise RuntimeError('the worker did not connect within 15s — the isolated desktop may be unusable on this system')
    finally:
        listener.close()
    return Isolated(name, int(info.dwProcessId), conn)


# --- finding things in a picture -------------------------------------------

def parse_colour(value):
    """#rrggbb, rrggbb or rgb(r,g,b) into a triple. Anything else is a caller mistake."""
    raw = str(value or '').strip().lower()
    if raw.startswith('rgb(') and raw.endswith(')'):
        parts = [piece.strip() for piece in raw[4:-1].split(',')]
        if len(parts) >= 3:
            return tuple(max(0, min(255, int(float(piece)))) for piece in parts[:3])
    raw = raw.lstrip('#')
    if len(raw) == 3:
        raw = ''.join(ch * 2 for ch in raw)
    if len(raw) != 6:
        raise RuntimeError('"%s" is not a colour — use #rrggbb' % value)
    return tuple(int(raw[i:i + 2], 16) for i in (0, 2, 4))


def box_of(words):
    left = min(word['x'] for word in words)
    top = min(word['y'] for word in words)
    right = max(word['x'] + word['width'] for word in words)
    bottom = max(word['y'] + word['height'] for word in words)
    return {'x': left, 'y': top, 'width': right - left, 'height': bottom - top}


def fuzzy_hit(needle, candidate):
    """
    Substring first, then approximately equal.

    OCR is not a lookup table: on a painted canvas it read "START 0" as "STARTO", dropping
    the space. Demanding an exact hit would report "not found" for a button that is
    plainly on screen, which is the one answer a caller cannot act on.
    """
    lowered = str(candidate or '').lower()
    if needle in lowered:
        return True
    if len(needle) < 4:
        return False  # anything shorter fuzzes into everything
    return difflib.SequenceMatcher(None, needle, lowered).ratio() >= 0.75


def find_in_window(hwnd, payload):
    """
    Locate something in a window that has no control tree.

    Two kinds of evidence exist on a painted surface, and only two: text, which the OCR
    engine Windows ships can read along with its bounding box, and a flat block of colour,
    which is what an icon button is. Both are reported in client pixels — the same space
    `desktop_act` takes and the same image `desktop_shot` returns — so a match can be
    clicked directly instead of being estimated from a picture.
    """
    text = str(payload.get('text') or '').strip()
    colour = str(payload.get('color') or payload.get('colour') or '').strip()
    if not text and not colour:
        raise RuntimeError('find needs "text" or "color" — a picture has nothing else to search by')

    region = payload.get('region') if isinstance(payload.get('region'), dict) else None
    shot = grab_stable(hwnd, True)

    out = {
        'window': window_info(hwnd, str(payload.get('desktop') or 'user')),
        'size': {'width': shot['width'], 'height': shot['height']},
        'engines': [],
        'matches': [],
    }

    if colour:
        target = parse_colour(colour)
        box = pixels.find_colour(
            shot, target,
            tolerance=int(payload.get('tolerance') or 24),
            region=region,
        )
        out['engines'].append('colour')
        if box:
            box['kind'] = 'colour'
            box['color'] = colour
            box['cx'] = box['x'] + box['width'] // 2
            box['cy'] = box['y'] + box['height'] // 2
            out['matches'].append(box)

    if text:
        if not ocr.available():
            out['engines'].append('ocr:unavailable')
            out['ocrReason'] = ocr.status().get('reason')
        else:
            temp = os.path.join(
                tempfile.gettempdir(),
                'dsh-bg-find-%d-%d.png' % (os.getpid(), int(time.time() * 1000)),
            )
            pixels.write_png(temp, shot['width'], shot['height'], shot['rgb'])
            try:
                read = ocr.recognise(temp)
            finally:
                try:
                    os.remove(temp)
                except OSError:
                    pass
            out['engines'].append('ocr')
            out['language'] = read['language']
            # The full read, trimmed: when a query finds nothing, the useful answer is
            # "this is what the picture says", not just an empty list.
            out['readText'] = read['text'][:400]
            needle = text.lower()
            limit = int(payload.get('max') or 8)

            # A phrase is matched against the whole line, then words are matched one by
            # one: "Submit order" should find the line, "Submit" should find the word.
            by_line = {}
            for word in read['words']:
                by_line.setdefault(word['line'], []).append(word)

            hits = []
            if ' ' in needle:
                for line, words in by_line.items():
                    if fuzzy_hit(needle, line):
                        box = box_of(words)
                        box.update({'kind': 'line', 'text': line})
                        hits.append(box)
            if not hits:
                for word in read['words']:
                    if fuzzy_hit(needle, word['text']):
                        hits.append({
                            'kind': 'word',
                            'text': word['text'],
                            'line': word['line'],
                            'x': word['x'],
                            'y': word['y'],
                            'width': word['width'],
                            'height': word['height'],
                        })
            for box in hits[:limit]:
                box['cx'] = int(box['x'] + box['width'] / 2)
                box['cy'] = int(box['y'] + box['height'] / 2)
                out['matches'].append(box)

    if region:
        def inside(box):
            return (
                box['x'] + box['width'] >= region.get('x', 0)
                and box['x'] <= region.get('x', 0) + region.get('width', shot['width'])
                and box['y'] + box['height'] >= region.get('y', 0)
                and box['y'] <= region.get('y', 0) + region.get('height', shot['height'])
            )

        out['matches'] = [box for box in out['matches'] if inside(box)]

    return out


# --- UI Automation ---------------------------------------------------------

_UIA = None
_UIA_TRIED = False
_UIA_ERROR = ['']


def get_uia():
    """
    Lazily build one IUIAutomation for this process (and this COM apartment).

    Lazy on purpose: an app that only needs window enumeration must not pay for COM
    initialisation, and a machine where UIA refuses must degrade to the Win32 tree
    instead of failing the whole command.
    """
    global _UIA, _UIA_TRIED
    if _UIA_TRIED:
        return _UIA
    _UIA_TRIED = True
    try:
        from uia import Uia

        instance = Uia()
        if instance.ok:
            _UIA = instance
        else:
            _UIA_ERROR[0] = instance.error or 'UIA reported no reason'
    except Exception as error:  # noqa: BLE001
        _UIA_ERROR[0] = str(error)
    return _UIA


def uia_tree(hwnd, max_nodes):
    """
    The semantic tree if UIA can read this window, else (None, reason).

    The two engines answer different questions: UIA knows what a control *is*, Win32
    only knows that a child window exists. Preferring UIA is what makes modern apps
    legible — but a window with no accessibility support must still fall back, not
    come back empty.
    """
    api = get_uia()
    if not api:
        return None, _UIA_ERROR[0] or 'UI Automation is unavailable'
    try:
        nodes, complete, _window = api.tree(hwnd, max_nodes)
    except Exception as error:  # noqa: BLE001
        return None, str(error)
    if not nodes:
        return None, 'this window exposes nothing through UI Automation'
    for node in nodes:
        node['id'] = node.pop('ref')
        node['engine'] = 'uia'
    return (nodes, complete), None


def uia_element(ref):
    api = get_uia()
    if not api:
        raise RuntimeError('"%s" is a UI Automation ref, but UIA is unavailable here: %s' % (ref, _UIA_ERROR[0]))
    return api.element_for(ref)


def act_on_uia_element(action, ref, payload, isolated):
    """
    Act on a semantic element.

    Patterns first: Invoke/Toggle/Select/SetValue are what accessibility itself uses, so
    they work on controls that ignore posted mouse messages, and they do not depend on
    the element being visible on screen. Posting a click at its rectangle is the last
    resort, and only when the element owns a real window handle.
    """
    api = get_uia()
    element = uia_element(ref)
    info = api.describe(element)

    if action == 'click':
        for name in ('invoke', 'toggle', 'select', 'expand'):
            done = getattr(api, name)(element)
            if done:
                return {'via': 'UIA ' + done, 'ref': ref, 'name': info['name']}
        fallback = None
        hwnd = info['nativeWindowHandle']
        if hwnd and user32.IsWindow(hwnd):
            rect = info['rect']
            fallback = click_at(hwnd, max(1, rect['width'] // 2), max(1, rect['height'] // 2))
        if fallback:
            return {'via': 'posted click at its centre (no Invoke pattern)', 'ref': ref, 'name': info['name']}
        raise RuntimeError(
            '"%s" (%s "%s") offers no Invoke/Toggle/Select pattern and owns no window, so there is '
            'nothing to click. Read it with desktop_act action "read", or act on its window instead.'
            % (ref, info['kind'], info['name'])
        )

    if action == 'type':
        text = str(payload.get('text') or '')
        done = api.set_value(element, text)
        if done:
            return {'via': 'UIA ' + done, 'ref': ref, 'chars': len(text)}
        # No Value pattern. Plenty of classic controls are like that (Notepad's own
        # editor), and they are still perfectly writable through their window.
        hwnd = info['nativeWindowHandle']
        if hwnd and user32.IsWindow(hwnd):
            if class_of(hwnd).lower().startswith(('edit', 'richedit')):
                buffer = ctypes.create_unicode_buffer(text)
                if send_timeout(hwnd, WM_SETTEXT, 0, ctypes.addressof(buffer)) is not None:
                    return {'via': 'WM_SETTEXT on the element window (no Value pattern)', 'ref': ref, 'chars': len(text)}
            api.focus(element)
            for char in text:
                post(hwnd, WM_CHAR, ord(char), 1)
                time.sleep(0.005)
            return {'via': 'WM_CHAR after focus (no Value pattern)', 'ref': ref, 'chars': len(text)}
        raise RuntimeError(
            '"%s" (%s) has no Value pattern and no window handle, so text cannot be put into it.'
            % (ref, info['kind'])
        )

    if action == 'read':
        value = api.value_of(element)
        if value is not None:
            return {'text': value[:4000], 'via': 'UIA Value pattern'}
        text = api.text_of(element)
        if text is not None:
            return {'text': text[:4000], 'via': 'UIA Text pattern'}
        # Last resort: the element's own window still knows its text.
        hwnd = info['nativeWindowHandle']
        if hwnd and user32.IsWindow(hwnd):
            try:
                content = read_text(hwnd)
                if content:
                    return {'text': content[:4000], 'via': 'WM_GETTEXT on the element window'}
            except Exception:  # noqa: BLE001 - a hung control must not fail the read
                pass
        return {
            'text': info['name'][:4000],
            'via': 'name only',
            'note': 'this element exposes neither a Value nor a Text pattern, and its window returns no text — '
                    'only its accessible name is available',
        }

    if action == 'focus':
        api.focus(element)
        return {'focused': True, 'ref': ref, 'note': 'UIA SetFocus, no window raised'}

    raise RuntimeError('action "%s" does not apply to a UI Automation element (try click/type/read/focus)' % action)


# --- command dispatch ------------------------------------------------------

def handle(payload, isolated=None):
    cmd = str(payload.get('cmd') or '').strip().lower()
    if cmd == 'ping':
        api = get_uia()
        return {'python': sys.version.split()[0], 'platform': sys.platform,
                'arch': '64' if ctypes.sizeof(ctypes.c_void_p) == 8 else '32',
                'desktop': isolated.name if isolated else 'user',
                'uia': bool(api), 'uiaError': _UIA_ERROR[0] or None,
                'ocr': ocr.available(), 'ocrLanguage': ocr.status().get('language'),
                'ocrError': ocr.status().get('reason')}
    if cmd == 'windows':
        desktop = isolated.name if isolated else 'user'
        return {'windows': list_windows(desktop, payload.get('process'))}
    if cmd == 'tree':
        hwnd = parse_id(payload.get('window'))
        if not user32.IsWindow(hwnd):
            raise RuntimeError('window "%s" is gone' % payload.get('window'))
        info = window_info(hwnd, isolated.name if isolated else 'user')
        engine = 'win32'
        controls = []
        complete = True
        note = None
        if str(payload.get('engine') or '').lower() != 'win32':
            answer, reason = uia_tree(hwnd, int(payload.get('max') or 200))
            if answer:
                controls, complete = answer
                engine = 'uia'
            else:
                note = reason
        if not controls:
            # Deliberately no clear_refs() here: a Win32 tree does not touch the UIA ref
            # table, so asking for one must not invalidate refs the caller still holds.
            controls = control_tree(hwnd)
        return {'window': info, 'controls': controls, 'engine': engine,
                'complete': complete, 'uiaNote': note,
                'clientOrigin': client_origin(hwnd)}
    if cmd == 'read':
        wanted = str(payload.get('target') or payload.get('window') or '')
        if wanted.startswith('u'):
            return act_on_uia_element('read', wanted, payload, isolated)
        hwnd = parse_id(wanted)
        return {'text': read_text(hwnd)[:4000]}
    if cmd == 'find':
        hwnd = parse_id(payload.get('window'))
        return find_in_window(hwnd, payload)
    if cmd == 'shot':
        hwnd = parse_id(payload.get('window'))
        return capture(hwnd, payload['path'], payload.get('clientOnly', True), bool(payload.get('grid')))
    if cmd == 'act':
        return handle_act(payload, isolated)
    if cmd == 'launch':
        path = str(payload.get('path') or '').strip()
        if not path:
            raise RuntimeError('path is required')
        args = payload.get('args') or []
        command_line = subprocess.list2cmdline([path] + [str(a) for a in args])
        startup = STARTUPINFOW()
        startup.cb = ctypes.sizeof(STARTUPINFOW)
        # Leave lpDesktop unset: the child then inherits *our* desktop, which is the
        # user's when this is the parent and the isolated one when this is a worker.
        # Naming the desktop here would have to be the real name, and a wrong name
        # silently starts the app somewhere nobody can see it.
        startup.lpDesktop = None
        startup.dwFlags = STARTF_USESHOWWINDOW
        startup.wShowWindow = SW_SHOWNORMAL
        info = PROCESS_INFORMATION()
        ok = kernel32.CreateProcessW(
            path, ctypes.create_unicode_buffer(command_line),
            None, None, False, CREATE_UNICODE_ENVIRONMENT, None,
            payload.get('cwd') or None, ctypes.byref(startup), ctypes.byref(info),
        )
        if not ok:
            raise RuntimeError('CreateProcessW failed for %s (%s)' % (path, ctypes.get_last_error()))
        return {'pid': int(info.dwProcessId)}
    if cmd == 'kill':
        pid = int(payload.get('pid') or 0)
        if pid <= 0:
            raise RuntimeError('pid is required')
        subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True)
        return {'killed': pid}
    if cmd == 'quit':
        return {'bye': True}
    raise RuntimeError('unknown command "%s"' % cmd)


def serve(sock, isolated):
    """One JSON line in, one JSON line out."""
    handle_in = sock.makefile('rb')
    handle_out = sock.makefile('wb')
    while True:
        line = handle_in.readline()
        if not line:
            return
        payload = {}
        try:
            payload = json.loads(line.decode('utf-8'))
        except Exception as error:
            reply = {'ok': False, 'error': 'bad request: %s' % error}
        else:
            try:
                reply = {'ok': True, 'result': handle(payload, isolated)}
            except Exception as error:
                reply = {'ok': False, 'error': str(error)}
        handle_out.write((json.dumps(reply, ensure_ascii=True) + '\n').encode('utf-8'))
        handle_out.flush()
        if str(payload.get('cmd') or '').lower() == 'quit':
            return


def run_worker(port):
    """Connect back to the parent that spawned us onto this desktop."""
    conn = socket.create_connection(('127.0.0.1', port), timeout=20.0)
    conn.settimeout(None)
    try:
        serve(conn, Isolated('worker', os.getpid(), conn))
    finally:
        conn.close()
    return 0


def main():
    try:
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    args = sys.argv[1:]
    if '--worker' in args:
        port = int(args[args.index('--port') + 1]) if '--port' in args else 0
        return run_worker(port)

    script_path = os.path.abspath(__file__)
    isolates = {}

    def reply(payload):
        try:
            return {'ok': True, 'result': payload()}
        except Exception as error:
            return {'ok': False, 'error': str(error)}

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except Exception as error:
            sys.stdout.write(json.dumps({'ok': False, 'error': 'bad request: %s' % error}) + '\n')
            sys.stdout.flush()
            continue

        cmd = str(payload.get('cmd') or '').lower()
        try:
            if cmd in ('windows', 'tree', 'read', 'act', 'launch', 'shot') and payload.get('desktop'):
                name = str(payload['desktop'])
                current = isolates.get(name)
                if not current:
                    raise RuntimeError('no isolated desktop named "%s" — desktop_launch creates one' % name)
                if cmd == 'launch':
                    sub = dict(payload)
                    sub.pop('desktop', None)
                    result = current.call(sub, timeout=30)
                else:
                    result = current.call(payload, timeout=30)
                if not result.get('ok'):
                    raise RuntimeError(result.get('error') or 'the desktop worker failed')
                out = {'ok': True, 'result': result.get('result')}
                if cmd == 'windows':
                    out['result']['desktop'] = name
                sys.stdout.write(json.dumps(out, ensure_ascii=True) + '\n')
                sys.stdout.flush()
                continue

            if cmd == 'desktops':
                sys.stdout.write(json.dumps({'ok': True, 'result': {
                    'isolated': [{'name': item.name, 'worker': item.worker, 'apps': item.apps} for item in isolates.values()]
                }}) + '\n')
                sys.stdout.flush()
                continue

            if cmd == 'launch' and payload.get('isolated'):
                name = str(payload.get('name') or ('dsh-agent-%d' % (len(isolates) + 1)))
                if name in isolates:
                    raise RuntimeError('an isolated desktop named "%s" already exists' % name)
                isolated = start_isolated(name, script_path)
                isolates[name] = isolated
                sub = {'cmd': 'launch', 'path': payload.get('path'), 'args': payload.get('args') or []}
                started = isolated.call(sub, timeout=30)
                if not started.get('ok'):
                    raise RuntimeError(started.get('error') or 'the worker could not start that program')
                isolated.apps.append(started.get('result'))
                sys.stdout.write(json.dumps({'ok': True, 'result': {
                    'desktop': name, 'isolated': True, 'pid': started['result']['pid']
                }}) + '\n')
                sys.stdout.flush()
                continue

            if cmd == 'quit':
                for item in isolates.values():
                    item.close()
                sys.stdout.write(json.dumps({'ok': True, 'result': {'bye': True}}) + '\n')
                sys.stdout.flush()
                return 0

            out = reply(lambda: handle(payload, None))
            sys.stdout.write(json.dumps(out, ensure_ascii=True) + '\n')
            sys.stdout.flush()
        except Exception as error:
            sys.stdout.write(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True) + '\n')
            sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
