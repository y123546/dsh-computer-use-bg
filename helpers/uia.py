"""
UI Automation for the desktop agent, over raw COM.

Why not the obvious routes:

- `Add-Type` / .NET: the environment this was built in blocks dynamic assembly loading,
  so a UIA implementation that way could not be verified at all.
- `comtypes`: works, but adds a third-party dependency to a helper that otherwise needs
  nothing but the standard library.

So the COM vtable is called directly. `IUIAutomation` is an ordinary COM object
(CLSID_CUIAutomation); its methods are just function pointers at fixed slots. The only
fiddly parts are BSTR ownership (`SysFreeString`) and releasing every element the
walkers hand back, both handled below.

What this buys over enumerating child windows: a real semantic tree. On the same Notepad
window Win32 sees 2 child windows; UIA sees 23 elements with roles and names — the text
editor, the status bar, the scroll-bar buttons, the menu bar items, the window buttons.
On a WPF or WinForms app the difference is far larger.
"""

import ctypes
from ctypes import POINTER, byref, c_void_p, c_wchar_p, wintypes

ole32 = ctypes.WinDLL('ole32')
oleaut32 = ctypes.WinDLL('oleaut32')

CLSID_CUIAutomation = '{ff48dba4-60ef-4201-aa87-54103eef594e}'
IID_IUIAutomation = '{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}'

IID_INVOKE = '{fb377fbe-8ea6-46d5-9c73-6499642d3059}'
IID_VALUE = '{43f8d7b7-a444-4f87-9383-af5edc0b5ba7}'
IID_TOGGLE = '{94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70}'
IID_SELECTION_ITEM = '{a94cd8b1-0844-4cd6-9d2d-640537ab39e9}'
IID_EXPAND_COLLAPSE = '{619be086-1f4e-4ee4-bafa-210128738730}'
IID_TEXT = '{32eba289-3583-42c9-9c59-3b6d9a1e9b2a}'

INVOKE_PATTERN = 10000
VALUE_PATTERN = 10002
EXPAND_COLLAPSE_PATTERN = 10005
SELECTION_ITEM_PATTERN = 10010
TOGGLE_PATTERN = 10015
TEXT_PATTERN = 10014

HRESULT = ctypes.c_long

# Control type ids, from UIAutomationClient.h — the model reads these names, so they
# matter as much as the ids themselves.
CONTROL_TYPES = {
    50000: 'button', 50001: 'calendar', 50002: 'checkbox', 50003: 'dropdown',
    50004: 'text field', 50005: 'link', 50006: 'image', 50007: 'list item',
    50008: 'list', 50009: 'menu', 50010: 'menu bar', 50011: 'menu item',
    50012: 'progress bar', 50013: 'radio', 50014: 'scroll bar', 50015: 'slider',
    50016: 'spinner', 50017: 'status bar', 50018: 'tab', 50019: 'tab item',
    50020: 'text', 50021: 'toolbar', 50022: 'tooltip', 50023: 'tree',
    50024: 'tree item', 50025: 'custom', 50026: 'group', 50027: 'thumb',
    50028: 'data grid', 50029: 'data item', 50030: 'document', 50031: 'split button',
    50032: 'window', 50033: 'pane', 50034: 'header', 50035: 'header item',
    50036: 'table', 50037: 'title bar', 50038: 'separator', 50039: 'semantic zoom',
    50040: 'app bar',
}

# Elements that are structure, not targets: listing them wastes the model's attention.
STRUCTURAL = {50033, 50026, 50009, 50037, 50021, 50017}
# ...but these are often worth acting on, so they only get skipped when they have no name.
STRUCTURAL_UNNAMED_ONLY = STRUCTURAL


class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', ctypes.c_ubyte * 8),
    ]


def _guid(text):
    value = GUID()
    hr = ole32.CLSIDFromString(ctypes.c_wchar_p(text), byref(value))
    if hr != 0:
        raise OSError('CLSIDFromString failed for %s (0x%08x)' % (text, hr & 0xFFFFFFFF))
    return value


def _call(ptr, slot, restype, argtypes, *args):
    """Invoke the `slot`-th vtable entry of a COM interface pointer."""
    vtable = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    function = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(vtable[slot])
    return function(ptr, *args)


def _release(ptr):
    if ptr:
        _call(ptr, 2, ctypes.c_ulong, [])


def _take_bstr(ptr):
    if not ptr or not ptr.value:
        return ''
    try:
        return ctypes.cast(ptr, c_wchar_p).value or ''
    finally:
        oleaut32.SysFreeString(ptr)


class UiaError(RuntimeError):
    pass


class Uia:
    """
    One object per process; every element it hands out stays alive until `clear_refs`.

    `refs` is the contract with the model: `u7` means "the element that was 7th in the
    last desktop_tree". A ref from before a UI change is refused rather than acted on
    blindly — the same reasoning as refs in the browser plane.
    """

    def __init__(self):
        self.ok = False
        self.uia = None
        self.condition = None
        self.walker = None
        self.refs = {}
        self.error = ''
        try:
            hr = ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED
            if hr not in (0, 1):
                raise OSError('CoInitializeEx failed (0x%08x)' % (hr & 0xFFFFFFFF))
            ptr = c_void_p()
            hr = ole32.CoCreateInstance(
                byref(_guid(CLSID_CUIAutomation)), None, 1, byref(_guid(IID_IUIAutomation)), byref(ptr)
            )
            if hr != 0 or not ptr.value:
                raise OSError('CoCreateInstance(IUIAutomation) failed (0x%08x)' % (hr & 0xFFFFFFFF))
            self.uia = ptr

            condition = c_void_p()
            _call(self.uia, 21, HRESULT, [POINTER(c_void_p)], byref(condition))  # CreateTrueCondition
            self.condition = condition

            walker = c_void_p()
            _call(self.uia, 14, HRESULT, [POINTER(c_void_p)], byref(walker))  # get_ControlViewWalker
            self.walker = walker
            self.ok = True
        except Exception as error:  # noqa: BLE001 - a missing UIA must not break the helper
            self.error = str(error)

    # --- properties --------------------------------------------------------

    def _string(self, element, slot):
        buf = c_void_p()
        _call(element, slot, HRESULT, [POINTER(c_void_p)], byref(buf))
        return _take_bstr(buf)

    def _int(self, element, slot):
        out = ctypes.c_int(0)
        _call(element, slot, HRESULT, [POINTER(ctypes.c_int)], byref(out))
        return out.value

    def _rect(self, element):
        rect = wintypes.RECT()
        _call(element, 43, HRESULT, [POINTER(wintypes.RECT)], byref(rect))
        return {
            'left': rect.left,
            'top': rect.top,
            'right': rect.right,
            'bottom': rect.bottom,
            'width': rect.right - rect.left,
            'height': rect.bottom - rect.top,
        }

    def describe(self, element):
        control_type = self._int(element, 21)
        return {
            'controlType': control_type,
            'kind': CONTROL_TYPES.get(control_type, 'control %d' % control_type),
            'localizedKind': self._string(element, 22),
            'name': self._string(element, 23),
            'automationId': self._string(element, 29),
            'class': self._string(element, 30),
            'enabled': bool(self._int(element, 28)),
            'offscreen': bool(self._int(element, 38)),
            'nativeWindowHandle': self._int(element, 36),
            'rect': self._rect(element),
        }

    def element_from_handle(self, hwnd):
        ptr = c_void_p()
        hr = _call(self.uia, 6, HRESULT, [wintypes.HWND, POINTER(c_void_p)], hwnd, byref(ptr))
        if hr != 0 or not ptr.value:
            return None
        return ptr

    # --- tree --------------------------------------------------------------

    def clear_refs(self):
        for element in self.refs.values():
            _release(element)
        self.refs = {}

    def tree(self, hwnd, max_nodes=200):
        """
        Depth-first over the control view, with refs assigned in order.
        Returns (nodes, complete, window).
        """
        root = self.element_from_handle(hwnd)
        if not root:
            return [], True, None
        self.clear_refs()

        window = self.describe(root)
        nodes = []
        complete = True

        # Iterative walk: (element, depth). The root itself is the window and is not
        # listed as a control — the caller already knows which window it asked about.
        # The root's *children* have to be collected as siblings: taking only the first
        # one silently returns just that one branch (an editor and its scrollbar, say),
        # which looks like a window with four controls instead of twenty.
        top = []
        sibling = self._first_child(root)
        while sibling:
            top.append(sibling)
            sibling = self._next_sibling(sibling)
        stack = [(element, 1) for element in reversed(top)]
        try:
            while stack:
                element, depth = stack.pop()
                if not element:
                    continue
                if len(nodes) >= max_nodes:
                    complete = False
                    _release(element)
                    break
                info = self.describe(element)
                # A bare pane/group is structure, not a target — but its children may
                # well be, so it is only left out of the list, never out of the walk.
                skip = info['controlType'] in STRUCTURAL_UNNAMED_ONLY and not info['name']
                if not skip:
                    ref = 'u%d' % (len(nodes) + 1)
                    self.refs[ref] = element
                    info['ref'] = ref
                    info['depth'] = depth
                    del info['controlType']
                    nodes.append(info)

                # Children are pushed in reverse so they come out in visual order.
                children = []
                child = self._first_child(element)
                while child:
                    children.append(child)
                    child = self._next_sibling(child)
                for item in reversed(children):
                    stack.append((item, depth + 1))
                if skip:
                    _release(element)
        finally:
            # Whatever the cap cut off is still owned by us.
            for leftover, _depth in stack:
                _release(leftover)
            _release(root)

        return nodes, complete, {k: v for k, v in window.items() if k != 'controlType'}

    def _first_child(self, element):
        if not element:
            return None
        ptr = c_void_p()
        _call(self.walker, 4, HRESULT, [c_void_p, POINTER(c_void_p)], element, byref(ptr))  # GetFirstChildElement
        return ptr if ptr.value else None

    def _next_sibling(self, element):
        ptr = c_void_p()
        _call(self.walker, 6, HRESULT, [c_void_p, POINTER(c_void_p)], element, byref(ptr))  # GetNextSiblingElement
        return ptr if ptr.value else None

    # --- actions -----------------------------------------------------------

    def _pattern(self, element, pattern_id, iid_text):
        """IUnknown -> the pattern interface, or None when the element does not offer it."""
        unknown = c_void_p()
        hr = _call(element, 16, HRESULT, [ctypes.c_int, POINTER(c_void_p)], pattern_id, byref(unknown))
        if hr != 0 or not unknown.value:
            return None
        typed = c_void_p()
        hr = _call(
            unknown,
            0,  # QueryInterface
            HRESULT,
            [POINTER(GUID), POINTER(c_void_p)],
            byref(_guid(iid_text)),
            byref(typed),
        )
        _release(unknown)
        if hr != 0 or not typed.value:
            return None
        return typed

    def element_for(self, ref):
        element = self.refs.get(str(ref))
        if not element:
            raise UiaError(
                'no element "%s" in the last snapshot — the UI may have changed, take a fresh desktop_tree' % ref
            )
        return element

    def invoke(self, element):
        pattern = self._pattern(element, INVOKE_PATTERN, IID_INVOKE)
        if not pattern:
            return None
        try:
            hr = _call(pattern, 3, HRESULT, [])  # Invoke
            return 'Invoke' if hr == 0 else None
        finally:
            _release(pattern)

    def toggle(self, element):
        pattern = self._pattern(element, TOGGLE_PATTERN, IID_TOGGLE)
        if not pattern:
            return None
        try:
            hr = _call(pattern, 3, HRESULT, [])  # Toggle
            return 'Toggle' if hr == 0 else None
        finally:
            _release(pattern)

    def select(self, element):
        pattern = self._pattern(element, SELECTION_ITEM_PATTERN, IID_SELECTION_ITEM)
        if not pattern:
            return None
        try:
            hr = _call(pattern, 3, HRESULT, [])  # Select
            return 'Select' if hr == 0 else None
        finally:
            _release(pattern)

    def expand(self, element):
        pattern = self._pattern(element, EXPAND_COLLAPSE_PATTERN, IID_EXPAND_COLLAPSE)
        if not pattern:
            return None
        try:
            hr = _call(pattern, 3, HRESULT, [])  # Expand
            return 'Expand' if hr == 0 else None
        finally:
            _release(pattern)

    def set_value(self, element, text):
        pattern = self._pattern(element, VALUE_PATTERN, IID_VALUE)
        if not pattern:
            return None
        try:
            buffer = ctypes.c_wchar_p(str(text))
            hr = _call(pattern, 3, HRESULT, [ctypes.c_wchar_p], buffer)  # SetValue
            return 'Value.SetValue' if hr == 0 else None
        finally:
            _release(pattern)

    def value_of(self, element):
        pattern = self._pattern(element, VALUE_PATTERN, IID_VALUE)
        if not pattern:
            return None
        try:
            out = c_void_p()
            hr = _call(pattern, 4, HRESULT, [POINTER(c_void_p)], byref(out))  # get_CurrentValue
            return _take_bstr(out) if hr == 0 else None
        finally:
            _release(pattern)

    def text_of(self, element):
        """
        Full text through ITextPattern's document range.

        Multiline editors (Notepad's, for one) expose text but no Value pattern, so
        reading them needs the text pattern. `GetText(-1)` means "the whole range".
        """
        pattern = self._pattern(element, TEXT_PATTERN, IID_TEXT)
        if not pattern:
            return None
        try:
            document = c_void_p()
            hr = _call(pattern, 5, HRESULT, [POINTER(c_void_p)], byref(document))  # get_DocumentRange
            if hr != 0 or not document.value:
                return None
            try:
                out = c_void_p()
                hr = _call(document, 12, HRESULT, [ctypes.c_int, POINTER(c_void_p)], -1, byref(out))  # GetText
                return _take_bstr(out) if hr == 0 else None
            finally:
                _release(document)
        finally:
            _release(pattern)

    def focus(self, element):
        hr = _call(element, 3, HRESULT, [])  # SetFocus
        return hr == 0
