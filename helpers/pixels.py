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


def colours(shot, step=8, ceiling=64):
    """
    How many distinct colours a coarse sweep finds.

    A GPU-composited window on a desktop nobody is looking at sometimes hands PrintWindow
    an empty surface, and PrintWindow reports success — the failure is a picture that is
    entirely one colour. Counting colours is what turns that into a statement instead of
    a blank image the caller has to interpret.
    """
    width, height = shot['width'], shot['height']
    rgb = shot['rgb']
    stride = width * 3
    seen = set()
    for y in range(0, height, step):
        row = y * stride
        for x in range(0, width, step):
            offset = row + x * 3
            seen.add(rgb[offset:offset + 3])
            if len(seen) >= ceiling:
                return len(seen)
    return len(seen)


def find_colour(shot, target, tolerance=24, region=None, step=2, floor=3):
    """
    Bounding box of everything close to one colour.

    A flat rectangle of known colour is the one thing a painted UI does expose reliably —
    a button is a block of pixels, whatever it draws inside. This turns that into a
    coordinate instead of an estimate.

    Scanned coarsely first and refined inside the hit box: a full-resolution sweep of a
    4K window in Python is slow enough to be felt, while a coarse pass plus a local
    refinement finds the same box in a fraction of the time. `hits` reports how many
    samples matched, so a single stray pixel is not mistaken for a button.
    """
    width, height = shot['width'], shot['height']
    rgb = shot['rgb']
    stride = width * 3
    tr, tg, tb = int(target[0]), int(target[1]), int(target[2])
    x0, y0, x1, y1 = _bounds(region, width, height)

    def sweep(step_size, left, top, right, bottom):
        found = []
        for y in range(top, bottom, step_size):
            row = y * stride
            for x in range(left, right, step_size):
                i = row + x * 3
                if abs(rgb[i] - tr) <= tolerance and abs(rgb[i + 1] - tg) <= tolerance and abs(rgb[i + 2] - tb) <= tolerance:
                    found.append((x, y))
        return found

    hits = sweep(step, x0, y0, x1, y1)
    if len(hits) < floor:
        hits = sweep(1, x0, y0, x1, y1)
    if not hits:
        return None

    min_x = min(point[0] for point in hits)
    max_x = max(point[0] for point in hits)
    min_y = min(point[1] for point in hits)
    max_y = max(point[1] for point in hits)

    # Grow the box back out to the true edges: the coarse pass lands inside it.
    pad = step + 1
    edge = sweep(1, max(0, min_x - pad), max(0, min_y - pad), min(width, max_x + pad + 1), min(height, max_y + pad + 1))
    if edge:
        min_x = min(point[0] for point in edge)
        max_x = max(point[0] for point in edge)
        min_y = min(point[1] for point in edge)
        max_y = max(point[1] for point in edge)

    return {
        'x': min_x,
        'y': min_y,
        'width': max_x - min_x + 1,
        'height': max_y - min_y + 1,
        'hits': len(hits),
    }


# --- comparison ------------------------------------------------------------   

def _bounds(region, width, height):
    if not region:
        return 0, 0, width, height
    x0 = max(0, int(region.get('x', 0)))
    y0 = max(0, int(region.get('y', 0)))
    x1 = min(width, x0 + max(1, int(region.get('width', width))))
    y1 = min(height, y0 + max(1, int(region.get('height', height))))
    return x0, y0, x1, y1


def _same(a, b, offset, threshold):
    return (
        abs(a[offset] - b[offset]) <= threshold
        and abs(a[offset + 1] - b[offset + 1]) <= threshold
        and abs(a[offset + 2] - b[offset + 2]) <= threshold
    )


def diff_steady(pre_frames, after, region=None, sample=2, threshold=8):
    """
    Judge only the pixels that were already still before the action.

    An animated scene differs from itself between any two frames, so a plain comparison
    cannot separate "the click did something" from "the scene kept moving". Measured on
    a running canvas game: a click that hit a button and a click into empty space came
    back as 0.7% and 0.5% — the same number twice, and in the wrong order.

    Pixels that were identical across *all* pre-action frames cannot be part of the
    animation, so a change there came from the action. `steady` reports how much of the
    region qualified: when it is small, the honest answer is that this area moves by
    itself and pixels prove nothing — not a guess dressed up as a result.

    Three frames, not two: a slow edge can move less than the threshold between two
    captures 90ms apart and still be animating. Measured on a canvas game, two frames
    left a ball's outline counted as steady, and a click into empty space then scored
    higher (2.8%) than a click that hit a button (0.7%).
    """
    if not pre_frames:
        return {'steady': 0.0, 'changed': 0.0, 'reason': 'no baseline frames'}
    first = pre_frames[0]
    width, height = first['width'], first['height']
    for frame in pre_frames:
        if frame['width'] != width or frame['height'] != height:
            return {'steady': 0.0, 'changed': 0.0, 'reason': 'the window changed size during the baseline'}
    if after['width'] != width or after['height'] != height:
        return {'steady': 0.0, 'changed': 0.0, 'reason': 'the window changed size'}

    x0, y0, x1, y1 = _bounds(region, width, height)
    stride = width * 3
    buffers = [frame['rgb'] for frame in pre_frames]
    reference = buffers[-1]
    final = after['rgb']

    total = 0
    steady = 0
    changed = 0
    min_x = min_y = 10 ** 9
    max_x = max_y = -1
    for y in range(y0, y1, sample):
        row = y * stride
        for x in range(x0, x1, sample):
            offset = row + x * 3
            total += 1
            still = True
            for buffer in buffers[:-1]:
                if not _same(buffer, reference, offset, threshold):
                    still = False
                    break
            if not still:
                continue  # moving on its own, so it cannot testify
            steady += 1
            if not _same(reference, final, offset, threshold):
                changed += 1
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y

    out = {
        'steady': round(steady / max(1, total), 3),
        'changed': round(changed / steady, 4) if steady else 0.0,
        'samples': total,
    }
    if changed:
        out['region'] = {'x': min_x, 'y': min_y, 'width': max_x - min_x + 1, 'height': max_y - min_y + 1}
    return out


def diff(before, after, sample=3, threshold=12, region=None):
    """
    How much changed between two grabs, optionally inside one rectangle.

    Sampled rather than pixel-by-pixel: the point is a yes/no signal plus roughly where,
    and a full scan of a 4K window costs more than the answer is worth. A blinking caret
    or an animation will register as a change — which is why the ratio and the region are
    reported instead of a bare true/false, and why callers compare it against the same
    measurement taken with nothing happening (`noise`).
    """
    if before['width'] != after['width'] or before['height'] != after['height']:
        return {'changed': True, 'ratio': 1.0, 'reason': 'the window changed size'}
    width, height = before['width'], before['height']
    a = before['rgb']
    b = after['rgb']
    stride = width * 3
    x0, y0, x1, y1 = _bounds(region, width, height)

    total = 0
    changed = 0
    min_x = min_y = 10 ** 9
    max_x = max_y = -1
    for y in range(y0, y1, sample):
        row = y * stride
        for x in range(x0, x1, sample):
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
