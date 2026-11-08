"""
The Windows clipboard, text and bitmaps, with no dependency.

Why it belongs in an automation tool rather than being a nicety: "copy from here, paste
there" is the one operation that has no reliable substitute. Typing into a control with
posted key messages is ignored by any modern app; the clipboard route is the one users
actually take, and it produces a value we can read back to prove it worked.

Two things this deliberately does:

- it reports the clipboard **sequence number**, so a caller can tell "the copy landed"
  from "nothing changed" without guessing — the same idea as the pixel check on a click;
- it never claims success it cannot see. Writing returns the text it read back afterwards.

The clipboard is global and shared with the user, which the tool layer says out loud
before it overwrites anything.
"""

import ctypes
import struct
from ctypes import wintypes

CF_TEXT = 1
CF_BITMAP = 2
CF_DIB = 8
CF_UNICODETEXT = 13

GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040

BI_RGB = 0
BI_BITFIELDS = 3

# What a normal 32-bit screenshot uses, in DIB byte order (B, G, R, X).
BGRA_MASKS = (0x00FF0000, 0x0000FF00, 0x000000FF)

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.restype = wintypes.BOOL
user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.GetClipboardSequenceNumber.restype = wintypes.DWORD

kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wintypes.HANDLE
kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.GlobalFree.argtypes = [wintypes.HANDLE]
kernel32.GlobalFree.restype = wintypes.HANDLE


class Busy(RuntimeError):
    """Another program holds the clipboard open."""


def sequence():
    """A number that changes every time the clipboard's contents change."""
    return int(user32.GetClipboardSequenceNumber())


def _open(retries=8, delay=0.03):
    """
    Take the clipboard, waiting briefly if someone else has it.

    OpenClipboard fails when any other window is using it — including a clipboard viewer
    mid-update — so a single attempt reports "busy" for what is usually a 5ms overlap.
    """
    import time

    for _ in range(max(1, retries)):
        if user32.OpenClipboard(None):
            return True
        time.sleep(delay)
    return False


def read():
    """
    What is on the clipboard right now.

    Returns {'text', 'hasText', 'hasImage', 'sequence'}. Text is None rather than '' when
    there is nothing to read, so "empty" and "empty string" stay distinguishable.
    """
    out = {'text': None, 'hasText': False, 'hasImage': False, 'sequence': sequence()}
    if not _open():
        raise Busy('the clipboard is held open by another program — try again in a moment')
    try:
        out['hasText'] = bool(user32.IsClipboardFormatAvailable(CF_UNICODETEXT))
        out['hasImage'] = bool(
            user32.IsClipboardFormatAvailable(CF_DIB) or user32.IsClipboardFormatAvailable(CF_BITMAP)
        )
        if out['hasText']:
            handle = user32.GetClipboardData(CF_UNICODETEXT)
            if handle:
                pointer = kernel32.GlobalLock(handle)
                if pointer:
                    try:
                        out['text'] = ctypes.wstring_at(pointer)
                    finally:
                        kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()
    return out


def write(text):
    """
    Replace the clipboard with `text`, then read it back.

    The read-back is the point: SetClipboardData succeeding only means Windows took
    ownership of the block, not that the block contained what we meant to put there.
    """
    value = str(text)
    buffer = ctypes.create_unicode_buffer(value)
    size = ctypes.sizeof(buffer)

    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size)
    if not handle:
        raise RuntimeError('could not allocate %d bytes for the clipboard' % size)
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        kernel32.GlobalFree(handle)
        raise RuntimeError('could not lock the clipboard buffer')
    try:
        ctypes.memmove(pointer, buffer, size)
    finally:
        kernel32.GlobalUnlock(handle)

    if not _open():
        kernel32.GlobalFree(handle)
        raise Busy('the clipboard is held open by another program — try again in a moment')
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)  # ownership never transferred
            raise RuntimeError('Windows refused the clipboard data (error %d)' % ctypes.get_last_error())
        # Past this point the system owns `handle`; freeing it would corrupt the clipboard.
    finally:
        user32.CloseClipboard()

    return {'chars': len(value), 'sequence': sequence()}


def clear():
    """Empty the clipboard. Reports the sequence so the caller can confirm it moved."""
    if not _open():
        raise Busy('the clipboard is held open by another program — try again in a moment')
    try:
        if not user32.EmptyClipboard():
            raise RuntimeError('Windows refused to empty the clipboard')
    finally:
        user32.CloseClipboard()
    return {'sequence': sequence()}


def read_image():
    """
    Decode a DIB from the clipboard into {'width', 'height', 'rgb'}.

    CF_DIB starts at the BITMAPINFOHEADER, so the pixels are the part of the block the
    header describes — no file header to skip, which is the one difference from a .bmp.
    Bottom-up by default (a positive height), top-down when it is negative.
    """
    if not _open():
        raise Busy('the clipboard is held open by another program — try again in a moment')
    try:
        if not user32.IsClipboardFormatAvailable(CF_DIB):
            return None
        handle = user32.GetClipboardData(CF_DIB)
        if not handle:
            return None
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return None
        try:
            header = ctypes.string_at(pointer, 40)
            size, width, height, _planes, bits, compression = struct.unpack('<IiiHHI', header[:20])
            if size < 40 or width <= 0 or height == 0:
                raise RuntimeError('the clipboard image has an unusable header')
            if bits not in (24, 32):
                raise RuntimeError('that image is %d-bit, only 24 and 32 are supported' % bits)

            # Screenshots land as BI_BITFIELDS far more often than BI_RGB: a 32-bit image
            # with an alpha channel carries three channel masks between the header and the
            # pixels. Assuming BI_RGB there reads the masks as the first three pixels.
            if compression == BI_BITFIELDS:
                masks = struct.unpack('<III', ctypes.string_at(pointer + size, 12))
                if masks != BGRA_MASKS:
                    raise RuntimeError(
                        'that image uses custom channel masks (%s), which is not supported'
                        % ', '.join(hex(mask) for mask in masks)
                    )
                pixel_base = size + 12
            elif compression == BI_RGB:
                pixel_base = size
            else:
                raise RuntimeError(
                    'that image uses a compressed DIB layout (compression %d), which is not supported' % compression
                )

            top_down = height < 0
            height = abs(height)
            stride = ((width * bits + 31) // 32) * 4
            total = stride * height
            # Palette sits between the header and the pixels; 24/32-bit has none.
            payload = ctypes.string_at(pointer + pixel_base, total)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()

    step = bits // 8
    rgb = bytearray(width * height * 3)
    for y in range(height):
        source_row = y if top_down else (height - 1 - y)
        offset = source_row * stride
        target = y * width * 3
        for x in range(width):
            source = offset + x * step
            target_pixel = target + x * 3
            rgb[target_pixel] = payload[source + 2]  # BGR(A) -> RGB
            rgb[target_pixel + 1] = payload[source + 1]
            rgb[target_pixel + 2] = payload[source]

    return {'width': width, 'height': height, 'rgb': bytes(rgb)}


def write_image(width, height, rgb):
    """
    Put a bitmap on the clipboard as a DIB.

    The counterpart to read_image, and the useful half for anyone driving a GUI: a
    screenshot that lands on the clipboard can be pasted into any application, which is
    the only reliable way to move a picture between programs without a file on disk.

    Built bottom-up with 32-bit BGRA and no channel masks (BI_BITFIELDS): that is the
    layout every consumer accepts, and it avoids writing a variant that some app reads
    as garbage.
    """
    width = int(width)
    height = int(height)
    if width <= 0 or height <= 0:
        raise RuntimeError('an image needs a positive size')
    expected = width * height * 3
    if len(rgb) < expected:
        raise RuntimeError('expected %d bytes of RGB, got %d' % (expected, len(rgb)))

    header = struct.pack(
        '<IiiHHIIiiII',
        40,          # biSize
        width,       # biWidth
        height,      # biHeight (positive = bottom-up)
        1,           # biPlanes
        32,          # biBitCount
        BI_RGB,      # biCompression
        0,           # biSizeImage (may be 0 for BI_RGB)
        0, 0, 0, 0,  # resolution and palette counts
    )

    rows = []
    for y in range(height - 1, -1, -1):  # DIB rows run bottom-up
        base = y * width * 3
        row = bytearray(width * 4)
        for x in range(width):
            source = base + x * 3
            target = x * 4
            row[target] = rgb[source + 2]
            row[target + 1] = rgb[source + 1]
            row[target + 2] = rgb[source]
            row[target + 3] = 255
        rows.append(bytes(row))

    payload = header + b''.join(rows)

    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(payload))
    if not handle:
        raise RuntimeError('could not allocate %d bytes for the image' % len(payload))
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        kernel32.GlobalFree(handle)
        raise RuntimeError('could not lock the image buffer')
    try:
        ctypes.memmove(pointer, payload, len(payload))
    finally:
        kernel32.GlobalUnlock(handle)

    if not _open():
        kernel32.GlobalFree(handle)
        raise Busy('the clipboard is held open by another program — try again in a moment')
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(CF_DIB, handle):
            kernel32.GlobalFree(handle)
            raise RuntimeError('Windows refused the clipboard image (error %d)' % ctypes.get_last_error())
    finally:
        user32.CloseClipboard()

    return {'width': width, 'height': height, 'sequence': sequence()}


if __name__ == '__main__':
    # Manual probe: python helpers/winclip.py [text-to-put]
    import json
    import sys

    before = read()
    print('before:', json.dumps({k: before[k] for k in ('hasText', 'hasImage', 'sequence')}, ensure_ascii=False))
    if before['text'] is not None:
        print('  text:', repr(before['text'][:80]))
    if before['hasImage']:
        image = read_image()
        print('  image:', image['width'], 'x', image['height'], 'pixels' if image else '')
    if len(sys.argv) > 1:
        result = write(sys.argv[1])
        after = read()
        print('write:', json.dumps(result))
        print('read back:', repr(after['text']))
