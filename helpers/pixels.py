"""
Screen pixels for the desktop agent: grab, encode, annotate, compare.

Two things live here, and they exist for the same reason — the case where a window
publishes no accessibility tree at all (a game, a canvas, a remote desktop, a Chromium
app that has not been told to build one). There is no structure to read there, so the
only loop left is "look, guess a coordinate, click, look again". That loop is only as
good as two properties:

- **the coordinate is unambiguous** — what you see is what you click, 1:1, client pixels.
  Half of all vision-based agents fail this quietly through display scaling; here the
  screenshot and the click share one coordinate space by construction.
- **the click can be checked** — a pixel diff of the same window before and after turns
  "I clicked and hope" into "the screen changed here", which is the only feedback an
  opaque surface can give.

`draw_grid` adds a ruler for the guess step: estimating a pixel position from an image is
much more accurate when the image carries tick marks and numbers than when it is a bare
rectangle.
"""

import ctypes
import struct
import zlib
from ctypes import byref, c_void_p, wintypes

# Self-contained bindings rather than import from desktop-agent: that module imports
# this one, and a cycle between them would make either hard to test on its own.
user32 = ctypes.WinDLL('user32', use_last_error=True)
gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)

PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002
DIB_RGB_COLORS = 0

user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetWindowDC.argtypes = [wintypes.HWND]
user32.GetWindowDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.PrintWindow.restype = wintypes.BOOL

gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]


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


gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
]

# 3x5 digits, enough to label a ruler without shipping a font.
DIGITS = {
    '0': ('111', '101', '101', '101', '111'),
    '1': ('010', '110', '010', '010', '111'),
    '2': ('111', '001', '111', '100', '111'),
    '3': ('111', '001', '111', '001', '111'),
    '4': ('101', '101', '111', '001', '001'),
    '5': ('111', '100', '111', '001', '111'),
    '6': ('111', '100', '111', '101', '111'),
    '7': ('111', '001', '010', '010', '010'),
    '8': ('111', '101', '111', '101', '111'),
    '9': ('111', '101', '111', '001', '111'),
}


class CaptureError(RuntimeError):
    pass


def grab(hwnd, client_only=True):
    """Ask the window to paint itself into a bitmap we own. Works while covered."""
    width = height = 0
    flags = PW_RENDERFULLCONTENT
    if client_only:
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, byref(rect))
        width, height = rect.right - rect.left, rect.bottom - rect.top
        flags |= PW_CLIENTONLY
    if width <= 0 or height <= 0:
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, byref(rect))
        width, height = rect.right - rect.left, rect.bottom - rect.top
        flags = PW_RENDERFULLCONTENT
        client_only = False
    if width <= 0 or height <= 0:
        raise CaptureError('that window has no drawable area (%dx%d)' % (width, height))
    if user32.IsIconic(hwnd):
        raise CaptureError('that window is minimised, so there is nothing painted to capture — restore it first')

    window_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(window_dc)
    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = width
    info.bmiHeader.biHeight = -height  # top-down
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0
    bits = c_void_p()
    bitmap = gdi32.CreateDIBSection(mem_dc, ctypes.byref(info), DIB_RGB_COLORS, ctypes.byref(bits), None, 0)
    if not bitmap:
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, window_dc)
        raise CaptureError('could not allocate a %dx%d bitmap' % (width, height))
    old = gdi32.SelectObject(mem_dc, bitmap)
    try:
        painted = bool(user32.PrintWindow(hwnd, mem_dc, flags))
        stride = width * 4
        raw = ctypes.string_at(bits, stride * height)
        out = bytearray(width * height * 3)
        for y in range(height):
            line = bytearray(raw[y * stride:(y + 1) * stride])
            line[0::4], line[2::4] = line[2::4], line[0::4]  # BGRA -> RGBA
            del line[3::4]                                    # -> RGB
            out[y * width * 3:(y + 1) * width * 3] = line
        return {'width': width, 'height': height, 'rgb': bytes(out), 'painted': painted, 'clientOnly': client_only}
    finally:
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, window_dc)


def write_png(path, width, height, rgb):
    stride = width * 3
    raw = b''.join(b'\x00' + rgb[y * stride:(y + 1) * stride] for y in range(height))
    compressed = zlib.compress(raw, 6)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as handle:
        handle.write(png)


# --- annotation ------------------------------------------------------------

GRID_COLOR = (255, 0, 255)
LABEL_FG = (255, 255, 255)
LABEL_BG = (0, 0, 0)


def _put(pixels, width, height, x, y, colour):
    if 0 <= x < width and 0 <= y < height:
        offset = (y * width + x) * 3
        pixels[offset:offset + 3] = bytes(colour)


def _text(pixels, width, height, x, y, text, scale=4):
    """Draw a short label with the 3x5 font, on a filled box so it stays readable."""
    advance = 4 * scale
    box_w = len(text) * advance + scale
    box_h = 7 * scale
    for dy in range(box_h):
        for dx in range(box_w):
            _put(pixels, width, height, x + dx, y + dy, LABEL_BG)
    for index, char in enumerate(text):
        glyph = DIGITS.get(char)
        if not glyph:
            continue
        origin_x = x + scale + index * advance
        for row, pattern in enumerate(glyph):
            for column, on in enumerate(pattern):
                if on != '1':
                    continue
                for sy in range(scale):
                    for sx in range(scale):
                        _put(pixels, width, height, origin_x + column * scale + sx, y + scale + row * scale + sy, LABEL_FG)


def draw_grid(width, height, rgb, step=100):
    """
    Overlay a ruler: a line every `step` pixels, a number every 2*step.

    Rendered into the image the model actually looks at, so "the button is at about
    (412, 96)" can be read off the picture instead of estimated from a blank edge.
    """
    pixels = bytearray(rgb)
    for x in range(step, width, step):
        for y in range(height):
            _put(pixels, width, height, x, y, GRID_COLOR)
    for y in range(step, height, step):
        # Dashed, so the horizontal lines do not fight the content.
        for x in range(0, width, 4):
            _put(pixels, width, height, x, y, GRID_COLOR)
    # Labels every other line, in a size that survives being viewed scaled down: a ruler
    # nobody can read is worse than no ruler.
    for y in range(0, height, step * 2):
        _text(pixels, width, height, 2, min(y + 2, max(0, height - 23)), str(y))
    for x in range(0, width, step * 2):
        _text(pixels, width, height, min(x + 2, max(0, width - 40)), 2, str(x))
    return bytes(pixels)


# --- comparison ------------------------------------------------------------

def diff(before, after, sample=3, threshold=12):
    """
    How much of the window changed between two grabs.

    Sampled rather than pixel-by-pixel: the point is a yes/no signal plus roughly where,
    and a full scan of a 4K window costs more than the answer is worth. A blinking caret
    or an animation will register as a small change — which is why the ratio and the
    region are reported instead of a bare true/false.
    """
    if before['width'] != after['width'] or before['height'] != after['height']:
        return {'changed': True, 'ratio': 1.0, 'reason': 'the window changed size'}
    width, height = before['width'], before['height']
    a = before['rgb']
    b = after['rgb']
    stride = width * 3

    total = 0
    changed = 0
    min_x = min_y = 10 ** 9
    max_x = max_y = -1
    for y in range(0, height, sample):
        row = y * stride
        for x in range(0, width, sample):
            offset = row + x * 3
            total += 1
            if (
                abs(a[offset] - b[offset]) > threshold
                or abs(a[offset + 1] - b[offset + 1]) > threshold
                or abs(a[offset + 2] - b[offset + 2]) > threshold
            ):
                changed += 1
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if changed == 0:
        return {'changed': False, 'ratio': 0.0}
    return {
        'changed': True,
        'ratio': round(changed / max(1, total), 4),
        'region': {'x': min_x, 'y': min_y, 'width': max_x - min_x + 1, 'height': max_y - min_y + 1},
    }
