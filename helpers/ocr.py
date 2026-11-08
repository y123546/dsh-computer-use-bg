"""
Drive the OCR engine Windows already ships, without adding a dependency.

Why this exists: on a surface with no control tree (a canvas, a game, a remote-desktop
session) the only way to find a control was to look at a screenshot and estimate a
coordinate. Estimating is where the error comes from. `Windows.Media.Ocr` returns the
text *and* its bounding box, so "where is the Submit button" becomes a lookup instead of
a guess.

The engine is reached through PowerShell rather than a native binding: the WinRT API is
async-only, and PowerShell's WinRT projection can await it (IAsyncOperation -> AsTask),
which costs one process start (~200 ms) and zero packages. A pure ctypes route was
considered and dropped: it needs the interface IIDs, which live in .winmd metadata that
would have to be parsed by hand, all to save one process launch.

Everything is best-effort. A machine with no OCR language pack, or one where script
execution is blocked, reports itself unavailable and the caller keeps working without it.
"""

import json
import os
import subprocess
import sys

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ocr.ps1')

# Absolute path: the helper may be started by an app whose PATH is not the user's.
POWERSHELL = os.path.join(
    os.environ.get('SystemRoot', r'C:\Windows'),
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

TIMEOUT = 30
_state = {'checked': False, 'available': False, 'reason': None, 'version': None}


def _run(args, timeout=TIMEOUT):
    """Run PowerShell without a window, return (code, stdout, stderr)."""
    proc = subprocess.run(
        [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] + args,
        capture_output=True, timeout=timeout,
        creationflags=0x08000000,  # CREATE_NO_WINDOW: no console flash, no focus change
    )
    decode = lambda blob: (blob or b'').decode('utf-8', 'replace')
    return proc.returncode, decode(proc.stdout), decode(proc.stderr)


def available():
    """Whether a usable OCR engine is present. Cached: probing costs a process start."""
    if _state['checked']:
        return _state['available']
    _state['checked'] = True
    if not os.path.exists(POWERSHELL):
        _state['reason'] = 'powershell.exe not found at %s' % POWERSHELL
        return False
    if not os.path.exists(SCRIPT):
        _state['reason'] = 'helpers/ocr.ps1 is missing from this install'
        return False
    try:
        code, out, err = _run(
            ['-Command',
             'try { $e = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType=WindowsRuntime];'
             ' $l = $e::AvailableRecognizerLanguages;'
             ' if ($l.Count -gt 0) { $l[0].LanguageTag } else { "" } }'
             ' catch { "" }'],
            timeout=20,
        )
    except Exception as error:  # noqa: BLE001 - availability must never raise
        _state['reason'] = str(error)
        return False
    tag = (out or '').strip()
    if code == 0 and tag:
        _state['available'] = True
        _state['version'] = tag
        return True
    _state['reason'] = (
        'no OCR language pack is installed (Settings → Time & Language → Language → '
        'optional features → OCR)' if code == 0 else (err.strip()[:200] or 'the OCR probe failed')
    )
    return False


def status():
    return {
        'available': _state['available'],
        'language': _state['version'],
        'reason': _state['reason'],
    }


def recognise(image_path, out_path=None):
    """
    Read the text in an image.

    Returns {'language', 'width', 'height', 'text', 'words': [...]} where every word
    carries x/y/width/height in image pixels — the same pixels desktop_act expects, since
    the image came from the same client area.
    """
    if not available():
        raise RuntimeError('OCR is not available here: %s' % (_state['reason'] or 'unknown reason'))

    # Windows paths only: WinRT's GetFileFromPathAsync does not accept forward slashes,
    # and the failure surfaces as an opaque AggregateException from the script host.
    image_path = os.path.normpath(os.path.abspath(image_path))
    out_path = os.path.normpath(os.path.abspath(out_path or (image_path + '.ocr.json')))
    code, out, err = _run(['-File', SCRIPT, '-ImagePath', image_path, '-OutPath', out_path])
    if code != 0:
        detail = (err or out or '').strip().splitlines()
        raise RuntimeError('OCR failed: %s' % (detail[-1][:300] if detail else 'exit code %d' % code))
    try:
        with open(out_path, 'r', encoding='utf-8') as handle:
            payload = json.load(handle)
    except Exception as error:  # noqa: BLE001
        raise RuntimeError('OCR produced no readable result: %s' % error)
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass

    if payload.get('error'):
        raise RuntimeError('OCR failed: %s' % payload['error'])

    words = []
    for line in payload.get('lines') or []:
        for word in line.get('words') or []:
            words.append({
                'text': str(word.get('text') or ''),
                'x': float(word.get('x') or 0),
                'y': float(word.get('y') or 0),
                'width': float(word.get('width') or 0),
                'height': float(word.get('height') or 0),
                'line': str(line.get('text') or ''),
            })
    return {
        'language': payload.get('language'),
        'width': int(payload.get('width') or 0),
        'height': int(payload.get('height') or 0),
        'text': str(payload.get('text') or ''),
        'words': words,
    }


if __name__ == '__main__':
    # Manual probe: python helpers/ocr.py <image> [query]
    print(json.dumps(status() if available() else status(), ensure_ascii=False))
    if len(sys.argv) < 2:
        raise SystemExit(0)
    result = recognise(sys.argv[1])
    query = sys.argv[2] if len(sys.argv) > 2 else None
    hits = [
        word for word in result['words']
        if not query or query.lower() in word['text'].lower()
    ]
    print(json.dumps({
        'language': result['language'],
        'size': [result['width'], result['height']],
        'words': len(result['words']),
        'matches': hits[:12],
    }, ensure_ascii=False, indent=2))
