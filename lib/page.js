/**
 * Page-level operations over a CDP connection.
 *
 * Coordinates are CSS pixels of the emulated 1440x900 viewport with
 * deviceScaleFactor 1, so screenshot pixels and input coordinates are 1:1.
 */

import { Buffer } from 'node:buffer';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walks same-origin frames depth first, carrying each document's offset inside the
 * top-level viewport.
 *
 * Two rules make this survivable on real pages:
 *  - A cross-origin child is recorded in `blocked` instead of thrown: one embedded ad
 *    or payment widget must not blank out the page around it.
 *  - The offset is `rect.left + clientLeft`, because an element's own
 *    getBoundingClientRect is relative to *its* viewport and the frame's content box
 *    starts inside its border. Skipping clientLeft lands clicks a few pixels off on
 *    framed layouts, which is enough to hit the wrong control.
 *
 * Inlined into every script that needs it rather than parked on `window`: a helper
 * there dies on navigation, and a page is free to overwrite it.
 *
 * Exported so callers that build their own expressions (locate, in index.js) walk
 * frames exactly the same way instead of growing a second, subtly different copy.
 */
export const FRAME_WALK = `
  const walkDocs = (root) => {
    const docs = [{ doc: root, path: '', dx: 0, dy: 0 }];
    const blocked = [];
    for (let i = 0; i < docs.length; i += 1) {
      const entry = docs[i];
      let frames = [];
      try { frames = entry.doc.querySelectorAll('iframe,frame'); } catch (error) { frames = []; }
      for (let j = 0; j < frames.length; j += 1) {
        const frame = frames[j];
        const rect = frame.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        let child = null;
        try { child = frame.contentDocument; } catch (error) { child = null; }
        if (!child) {
          let src = '';
          try { src = String(frame.getAttribute('src') || ''); } catch (error) { src = ''; }
          blocked.push(src);
          continue;
        }
        docs.push({
          doc: child,
          path: entry.path ? entry.path + '.' + j : String(j),
          dx: entry.dx + rect.left + (frame.clientLeft || 0),
          dy: entry.dy + rect.top + (frame.clientTop || 0)
        });
      }
    }
    return { docs, blocked };
  };
`;

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
  ${FRAME_WALK}
  const { docs, blocked } = walkDocs(document);
  outer: for (const entry of docs) {
    const view = entry.doc.defaultView;
    if (!view) continue;
    let nodes = [];
    try { nodes = entry.doc.querySelectorAll(SELECTOR); } catch (error) { continue; }
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const style = view.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (Number(style.opacity) === 0) continue;
      // Kept in top-level viewport space: that is what clicks and drags need, and it
      // makes "is it on screen" a single comparison instead of one per frame.
      const cx = Math.round(rect.left + rect.width / 2 + entry.dx);
      const cy = Math.round(rect.top + rect.height / 2 + entry.dy);
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      if (out.length >= MAX) break outer;
      const ref = out.length + 1;
      el.setAttribute('data-dsh-bg-ref', String(ref));
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        name: nameOf(el),
        frame: entry.path,
        x: cx,
        y: cy,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true'
      });
    }
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
    elements: out,
    frames: { scanned: docs.length - 1, blocked }
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

/**
 * Park the pointer on a point without pressing anything.
 *
 * Two moves, the second a couple of pixels away: a single synthetic jump can land
 * before the renderer has dispatched `mouseenter`, and components that open on
 * `mousemove` never see one at all. Arriving twice makes both styles fire.
 */
export async function hoverAt(connection, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await sleep(60);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: px + 2,
    y: py + 2,
    button: 'none',
    buttons: 0,
  });
  await sleep(40);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: px,
    y: py,
    button: 'none',
    buttons: 0,
  });
}

/**
 * Press at `from`, move in small increments, release at `to`.
 *
 * The intermediate points are the whole trick: drag libraries arm themselves on the
 * first move that crosses their threshold and ignore a single jump from A to B, and
 * HTML5 drag needs the renderer to see a steady pressed pointer before it promotes
 * the gesture to a native drag. `settleMs` gives the drop target time to react.
 */
export async function dragBetween(connection, from, to, { steps = 14, settleMs = 150 } = {}) {
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const ex = Math.round(to.x);
  const ey = Math.round(to.y);
  const count = Math.max(3, Math.min(60, Number(steps) || 14));

  await sleep(80);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sx,
    y: sy,
    button: 'none',
    buttons: 0,
  });
  await sleep(60);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: sx,
    y: sy,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await sleep(60);
  for (let step = 1; step <= count; step += 1) {
    const t = step / count;
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(sx + (ex - sx) * t),
      y: Math.round(sy + (ey - sy) * t),
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }
  await sleep(settleMs);
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: ex,
    y: ey,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Count the drag events a gesture produces, so a failed drop can be explained
 * instead of guessed at. HTML5 drag and pointer-based libraries look identical
 * from the outside; the counters tell them apart (`dragstart 0` = pointer handlers,
 * `dragstart` without `drop` = the native drag started but the target refused it).
 *
 * `dragProbe` returns what happened since the previous call and then resets, so
 * calling it once before and once after a gesture is enough.
 */
const DRAG_PROBE_KEY = '__dshBgDragProbe';
export async function dragProbe(connection) {
  try {
    return await evaluate(
      connection,
      `(() => {
        const KEY = ${JSON.stringify(DRAG_PROBE_KEY)};
        const empty = () => ({ dragstart: 0, dragend: 0, drop: 0, dragenter: 0, pointermove: 0 });
        const state = window[KEY] || (window[KEY] = { counts: empty(), installed: false });
        if (!state.installed) {
          for (const type of Object.keys(empty())) {
            document.addEventListener(type, () => { state.counts[type] += 1; }, true);
          }
          state.installed = true;
        }
        const snapshot = { ...state.counts };
        state.counts = empty();
        return snapshot;
      })()`,
      { timeoutMs: 10000 },
    );
  } catch {
    // A probe is diagnostics only: never fail a gesture because it could not be read.
    return null;
  }
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

/**
 * Readable text of the page, trimmed to `limit` characters.
 *
 * Frames are concatenated with a `[frame 0.1]` marker: `innerText` never includes a
 * child document, so a framed editor or a framed login would otherwise read as an
 * empty page with no hint about where the content went.
 */
export async function pageText(connection, limit = 6000) {
  const text = await evaluate(
    connection,
    `(() => {
      ${FRAME_WALK}
      const { docs, blocked } = walkDocs(document);
      const parts = [];
      for (const entry of docs) {
        const main = entry.doc.querySelector('main,article,[role="main"]') || entry.doc.body;
        const raw = main ? (main.innerText || '') : '';
        const body = raw.replace(/\\n{3,}/g, '\\n\\n').trim();
        if (!body) continue;
        parts.push(entry.path ? '[frame ' + entry.path + ']\\n' + body : body);
      }
      if (blocked.length > 0) {
        parts.push('[not readable: ' + blocked.length + ' cross-origin frame(s)]');
      }
      return parts.join('\\n\\n');
    })()`,
    { timeoutMs: 25000 },
  );
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/**
 * Block until one condition holds, or the budget runs out.
 *
 * The polling loop runs *inside* the page in a single evaluate call. A Node-side
 * loop would cost one CDP round-trip per tick and, worse, would fail the moment a
 * click starts a navigation (the document being polled disappears). Resolving with
 * a plain object also means "it never appeared" is a normal return value: the caller
 * decides whether that is a failure, and can still report what the page looked like.
 */
export async function waitFor(connection, { selector, text, gone, timeoutMs = 15000, pollMs = 150 } = {}) {
  const budget = Math.max(200, Math.min(120000, Number(timeoutMs) || 15000));
  const poll = Math.max(50, Math.min(1000, Number(pollMs) || 150));
  const spec = {
    selector: selector === undefined || selector === null || selector === '' ? null : String(selector),
    text: text === undefined || text === null || text === '' ? null : String(text),
    gone: gone === undefined || gone === null || gone === '' ? null : String(gone),
  };
  const expression = [
    'new Promise((resolve) => {',
    `  const spec = ${JSON.stringify(spec)};`,
    `  const deadline = Date.now() + ${budget};`,
    '  const started = Date.now();',
    FRAME_WALK,
    '  const snapshotState = () => ({',
    '    readyState: document.readyState,',
    '    url: location.href,',
    '    title: document.title,',
    '  });',
    '  const tick = () => {',
    '    let ok = false;',
    '    try {',
    // Re-walked every tick: a frame that has not loaded yet cannot be queried, and
    // which frames exist changes while the page settles.
    '      const { docs } = walkDocs(document);',
    '      const anyMatch = (sel) => docs.some((entry) => !!entry.doc.querySelector(sel));',
    '      if (spec.selector !== null) ok = anyMatch(spec.selector);',
    '      else if (spec.gone !== null) ok = !anyMatch(spec.gone);',
    '      else if (spec.text !== null) ok = docs.some((entry) => (entry.doc.body ? entry.doc.body.innerText : "").includes(spec.text));',
    '      else ok = document.readyState !== "loading";',
    '    } catch (error) {',
    // An invalid selector can never become valid: fail now instead of burning the budget.
    '      return resolve({ ok: false, fatal: String((error && error.message) || error), elapsed: Date.now() - started, ...snapshotState() });',
    '    }',
    '    if (ok) return resolve({ ok: true, elapsed: Date.now() - started, ...snapshotState() });',
    '    if (Date.now() >= deadline) return resolve({ ok: false, timedOut: true, elapsed: Date.now() - started, ...snapshotState() });',
    `    setTimeout(tick, ${poll});`,
    '  };',
    '  tick();',
    '})',
  ].join('\n');

  // The page can outlive its own promise (navigation cancels it), so leave a margin
  // for the transport instead of letting the CDP command time out first.
  const result = await evaluate(connection, expression, { timeoutMs: budget + 8000 });
  if (!result || typeof result !== 'object') {
    throw new Error('The wait never produced a result — the page probably navigated away mid-wait.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Navigation history
// ---------------------------------------------------------------------------

/** Reload the current page and wait for a *new* document, not the old one. */
export async function reload(connection, { timeoutMs = 30000, ignoreCache = false } = {}) {
  const before = await evaluate(connection, 'performance.timeOrigin', { timeoutMs: 4000 }).catch(() => null);
  await connection.send('Page.reload', { ignoreCache: Boolean(ignoreCache) }, { timeoutMs });
  if (before !== null) {
    // `performance.timeOrigin` belongs to the document, so a changed value is proof
    // that the reload actually replaced it — polling readyState alone would report
    // the stale document as "complete" before the new one even started.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = await evaluate(connection, 'performance.timeOrigin', { timeoutMs: 3000 }).catch(() => null);
      if (now !== null && now !== before) break;
      await sleep(120);
    }
  }
  const status = await waitForLoad(connection, timeoutMs);
  return { loaded: status.ok, readyState: status.state };
}

/**
 * Walk the tab's own history by `delta` entries (-1 back, +1 forward).
 *
 * `history.back()` returns before the load starts and gives no error when there is
 * nowhere to go; `Page.getNavigationHistory` knows both, so a dead end is reported
 * as a dead end instead of a mysterious unchanged page.
 */
export async function goHistory(connection, delta, { timeoutMs = 30000 } = {}) {
  const history = await connection.send('Page.getNavigationHistory', {}, { timeoutMs: 10000 });
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const index = Number(history?.currentIndex ?? -1);
  if (!Number.isFinite(index) || index < 0) throw new Error('Could not read the tab history.');
  const target = entries[index + delta];
  if (!target) {
    throw new Error(
      delta < 0
        ? `No page before this one in the tab history (${index + 1} entr${index === 0 ? 'y' : 'ies'}). Open one with browser_open.`
        : 'No page after this one — nothing has been navigated away from yet.',
    );
  }
  await connection.send('Page.navigateToHistoryEntry', { entryId: target.id }, { timeoutMs });
  await sleep(350); // history navigation may be same-document; let it commit
  const status = await waitForLoad(connection, timeoutMs);
  return { url: target.url, title: target.title ?? '', loaded: status.ok, readyState: status.state };
}

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

/**
 * Point a real `<input type="file">` at local files, without opening a picker.
 *
 * Element lookup goes through the DOM domain rather than the page: upload inputs are
 * routinely `display:none` behind a styled button, and `document.querySelector` +
 * `.click()` would open a native dialog there is no way to answer.
 */
export async function setFileInput(connection, { selector, files }) {
  const list = Array.isArray(files) ? files.map((file) => String(file)) : [];
  if (!selector) throw new Error('A selector is required to find the file input.');
  if (list.length === 0) throw new Error('files must contain at least one absolute path.');

  await connection.send('DOM.enable', {}, { timeoutMs: 5000 }).catch(() => {});
  // Required before requestNode: with no document tree the DOM agent answers nodeId 0,
  // which looks like success and then fails one call later.
  await connection.send('DOM.getDocument', { depth: 0, pierce: false }, { timeoutMs: 15000 });

  // Found from page JS, not DOM.querySelector: the DOM domain's query only ever looks
  // inside the main document, so a framed upload control (payment widgets, embedded
  // editors) is invisible to it while walkDocs sees it. The element is then handed
  // back as a RemoteObject and traded for a nodeId.
  const located = await connection.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        ${FRAME_WALK}
        const { docs } = walkDocs(document);
        const wanted = ${JSON.stringify(String(selector))};
        for (const entry of docs) {
          const el = entry.doc.querySelector(wanted);
          if (el) return el;
        }
        return null;
      })()`,
      returnByValue: false,
    },
    { timeoutMs: 15000 },
  );

  if (located?.exceptionDetails) {
    const detail = located.exceptionDetails.exception?.description || located.exceptionDetails.text || 'invalid selector';
    throw new Error(`"${selector}" is not a valid selector: ${String(detail).split('\n')[0]}`);
  }
  const objectId = located?.result?.objectId;
  if (!objectId) {
    throw new Error(
      `No element matches "${selector}". Take a fresh browser_snapshot: the upload control may not be in the DOM yet, or it may sit in a cross-origin frame, which cannot be read.`,
    );
  }

  const requested = await connection.send('DOM.requestNode', { objectId }, { timeoutMs: 15000 }).catch((error) => {
    throw new Error(`"${selector}" was found but could not be addressed as a DOM node: ${error.message}`);
  });
  const nodeId = requested?.nodeId;
  if (!nodeId) throw new Error(`"${selector}" was found but the browser returned no node id for it.`);
  const described = await connection.send('DOM.describeNode', { nodeId }, { timeoutMs: 10000 }).catch(() => null);
  const nodeName = String(described?.node?.nodeName ?? '').toLowerCase();
  const attributes = Array.isArray(described?.node?.attributes) ? described.node.attributes : [];
  const typeIndex = attributes.indexOf('type');
  const inputType = typeIndex >= 0 ? String(attributes[typeIndex + 1] ?? '').toLowerCase() : '';
  if (nodeName && nodeName !== 'input') {
    throw new Error(
      `"${selector}" points at <${nodeName}>, not a file input. Drop zones that only accept drag events are not supported yet — look for a real <input type="file"> near the button.`,
    );
  }
  if (inputType && inputType !== 'file') {
    throw new Error(`"${selector}" is <input type="${inputType}">, not a file input. Point it at the <input type="file"> instead.`);
  }

  await connection.send('DOM.setFileInputFiles', { nodeId, files: list }, { timeoutMs: 20000 });
  return { nodeName: nodeName || 'input', count: list.length };
}

