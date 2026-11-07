/**
 * Page-level operations over a CDP connection.
 *
 * Coordinates are CSS pixels of the emulated 1440x900 viewport with
 * deviceScaleFactor 1, so screenshot pixels and input coordinates are 1:1.
 */

import { Buffer } from 'node:buffer';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects interactive elements with a stable 1-based `ref`, in viewport order.
 * Runs in the page; returns plain JSON.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX = 220;
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]', '[role="option"]',
    '[role="switch"]', '[role="searchbox"]', '[role="textbox"]', '[role="treeitem"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]'
  ].join(',');
  const nameOf = (el) => {
    const parts = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.innerText,
      el.value,
      el.getAttribute('name')
    ];
    for (const part of parts) {
      if (typeof part === 'string' && part.trim()) {
        return part.trim().replace(/\\s+/g, ' ').slice(0, 160);
      }
    }
    return '';
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    if (out.length >= MAX) break;
    const ref = out.length + 1;
    el.setAttribute('data-dsh-bg-ref', String(ref));
    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      name: nameOf(el),
      x: cx,
      y: cy,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    });
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: {
      x: Math.round(scrollX),
      y: Math.round(scrollY),
      height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    },
    elements: out
  };
})()`;

const KEY_TABLE = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const MODIFIERS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  shift: 8,
};

export async function evaluate(connection, expression, { timeoutMs = 20000, awaitPromise = true } = {}) {
  const response = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise, userGesture: true },
    { timeoutMs },
  );
  if (response.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      'JavaScript evaluation failed';
    throw new Error(detail);
  }
  return response.result?.value;
}

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('url is required');
  if (/^(https?|file|about|chrome):/i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}

async function waitForLoad(connection, timeoutMs) {
  // `complete` is a bad gate: modern sites keep connections open (analytics,
  // long-polling, websockets) and never reach it, so waiting for it burns the whole
  // budget on a page that has been usable for seconds. `interactive` means the DOM
  // is parsed and scriptable, which is all the element snapshot needs.
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  let state = 'loading';
  do {
    try {
      state = await evaluate(connection, 'document.readyState', { timeoutMs: 5000 });
      if (state === 'interactive' || state === 'complete') {
        await sleep(250); // let the first paint / hydration settle
        return { ok: true, state };
      }
    } catch {
      /* navigation in flight */
    }
    if (Date.now() >= deadline) return { ok: false, state };
    await sleep(150);
  } while (true);
}

export async function navigate(connection, url, { timeoutMs = 30000 } = {}) {
  const target = normalizeUrl(url);
  const result = await connection.send('Page.navigate', { url: target }, { timeoutMs });
  if (result.errorText) throw new Error(`Navigation to ${target} failed: ${result.errorText}`);
  const status = await waitForLoad(connection, timeoutMs);
  return { url: target, loaded: status.ok, readyState: status.state };
}

export async function snapshot(connection) {
  const value = await evaluate(connection, SNAPSHOT_SCRIPT, { timeoutMs: 25000 });
  if (!value || !Array.isArray(value.elements)) {
    throw new Error('Snapshot returned no element list — the page may still be loading.');
  }
  return value;
}

export async function clickAt(connection, x, y, { button = 'left', clickCount = 1 } = {}) {
  const px = Math.round(x);
  const py = Math.round(y);
  // Synthetic input is unreliable right after a navigation: the renderer still has
  // to settle, and events that arrive too early are dropped without an error. The
  // same applies between press and release, where a too-tight sequence produces no
  // `click` event at all.
  await sleep(80);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: px,
    y: py,
    button: 'none',
    buttons: 0,
  });
  await sleep(60);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button,
    buttons: button === 'right' ? 2 : 1,
    clickCount,
  });
  await sleep(60);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button,
    buttons: 0,
    clickCount,
  });
}

export async function insertText(connection, text) {
  await connection.send('Input.insertText', { text: String(text ?? '') });
}

export async function pressKey(connection, rawKey) {
  const spec = String(rawKey ?? '').trim().toLowerCase();
  if (!spec) throw new Error('key is required');

  const parts = spec.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  const keyName = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (!bit) throw new Error(`Unknown modifier "${part}" in "${rawKey}"`);
    modifiers |= bit;
  }

  const entry = KEY_TABLE[keyName] ?? { key: keyName, code: undefined, keyCode: 0 };
  const common = {
    key: entry.key,
    code: entry.code,
    windowsVirtualKeyCode: entry.keyCode,
    nativeVirtualKeyCode: entry.keyCode,
    modifiers,
  };
  await connection.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

export async function screenshot(connection, { format = 'png' } = {}) {
  const result = await connection.send(
    'Page.captureScreenshot',
    { format, captureBeyondViewport: false },
    { timeoutMs: 30000 },
  );
  if (!result?.data) throw new Error('Page.captureScreenshot returned no data');
  return Buffer.from(result.data, 'base64');
}

export async function scrollBy(connection, { deltaY = 0, deltaX = 0, x, y } = {}) {
  const viewport = await evaluate(connection, '({w: innerWidth, h: innerHeight})').catch(() => ({ w: 1440, h: 900 }));
  const px = x ?? Math.round(viewport.w / 2);
  const py = y ?? Math.round(viewport.h / 2);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(px),
    y: Math.round(py),
    deltaX,
    deltaY,
    button: 'none',
    buttons: 0,
  });
}

/** Readable text of the page, trimmed to `limit` characters. */
export async function pageText(connection, limit = 6000) {
  const text = await evaluate(
    connection,
    `(() => {
      const main = document.querySelector('main,article,[role="main"]') || document.body;
      const raw = main ? (main.innerText || '') : '';
      return raw.replace(/\\n{3,}/g, '\\n\\n').trim();
    })()`,
    { timeoutMs: 25000 },
  );
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value;
}
