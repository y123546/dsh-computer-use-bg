/**
 * dsh-computer-use-bg — background computer use for DeepSeek Harness.
 *
 * The agent drives a private Chromium instance over CDP. Nothing here moves the
 * real cursor, presses real keys or steals foreground focus, so the user can keep
 * working while the agent browses.
 */

import { existsSync } from 'node:fs';

import { BrowserHost, resolveBrowser } from './cdp.js';
import {
  clickAt,
  evaluate,
  goHistory,
  insertText,
  navigate,
  pageText,
  pressKey,
  reload,
  screenshot,
  scrollBy,
  setFileInput,
  snapshot,
  waitFor,
} from './page.js';

export const name = 'dsh-computer-use-bg';
// `attachments` is a real host service (the same pair @copylee uses to return
// screenshots), so declaring it is correct. The soft lookup in optionalService is
// belt-and-braces for hosts that ship without it.
export const inject = ['tools', 'attachments'];

/**
 * Read a host service without declaring a hard dependency on it.
 *
 * `ctx.get(name, false)` is cordis' own optional lookup: the second argument says
 * "do not throw when it is missing". Reading `ctx[name]` directly is not equivalent —
 * DSH's ctx is a strict getter, so an undeclared service throws instead of yielding
 * undefined. (Pattern taken from dsh-pet, which treats `attachments` the same way.)
 */
function optionalService(ctx, service) {
  try {
    const get = ctx.get;
    if (typeof get === 'function') return get.call(ctx, service, false);
    return ctx[service];
  } catch {
    return undefined;
  }
}

function log(ctx, message) {
  try {
    ctx.logger?.info?.(message);
  } catch {
    /* logging is never worth failing a plugin load over */
  }
}

/**
 * Drain the dialogs that opened since the last tool call into one readable line.
 *
 * They are answered automatically (see BrowserHost#watchDialogs), but silently
 * accepting a `confirm()` would let the model believe a deletion was cancelled when
 * it was not — so every result carries what was said and how it was answered.
 */
function drainDialogs(connection) {
  const queue = connection?.dialogs;
  if (!Array.isArray(queue) || queue.length === 0) return '';
  const items = queue.splice(0, queue.length);
  const parts = items.map((dialog) => {
    if (dialog.type === 'beforeunload') {
      return `a "leave this page?" prompt (${dialog.message || 'no message'}) — ${dialog.accepted ? 'accepted' : 'stayed'}`;
    }
    return `${dialog.type}("${dialog.message}") — ${dialog.accepted ? 'accepted' : 'dismissed'}`;
  });
  return `\n(dialog handled automatically: ${parts.join('; ')})`;
}

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;

function readSettings(config = {}) {
  return {
    enabled: config.enabled !== false,
    browserPath: typeof config.browserPath === 'string' && config.browserPath.trim() ? config.browserPath.trim() : undefined,
    port: Number.isFinite(Number(config.port)) ? Number(config.port) : 9411,
    headless: config.headless !== false,
    idleMs: Number.isFinite(Number(config.idleMs)) ? Number(config.idleMs) : 300000,
    width: Number.isFinite(Number(config.width)) && Number(config.width) >= 320 ? Number(config.width) : DEFAULT_WIDTH,
    height: Number.isFinite(Number(config.height)) && Number(config.height) >= 240 ? Number(config.height) : DEFAULT_HEIGHT,
    profileDir: typeof config.profileDir === 'string' && config.profileDir.trim() ? config.profileDir.trim() : undefined,
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 25000,
    dialogBehavior: config.dialogBehavior === 'dismiss' ? 'dismiss' : 'accept',
    dialogPromptText: typeof config.dialogPromptText === 'string' ? config.dialogPromptText : '',
  };
}

/** Compact one-line-per-element rendering: cheaper in tokens than JSON. */
function formatElements(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`Title: ${snap.title}`);
  lines.push(
    `Viewport ${snap.viewport.width}x${snap.viewport.height}, scrollY ${snap.scroll.y} of ${snap.scroll.height}. ` +
      `${snap.elements.length} interactive element(s) in view.`,
  );
  if (snap.elements.length === 0) {
    lines.push('No interactive elements in view. Scroll, or read the page with browser_text.');
  }
  for (const el of snap.elements) {
    const role = el.role ? `${el.role}` : el.tag;
    const type = el.type ? `[${el.type}]` : '';
    const label = el.name ? ` "${el.name}"` : '';
    const flag = el.disabled ? ' (disabled)' : '';
    lines.push(`#${el.ref} ${role}${type}${label} @${el.x},${el.y} ${el.w}x${el.h}${flag}`);
  }
  return lines.join('\n');
}

/**
 * Attachment reference as DSH serialises it.
 *
 * Two host rules shape this:
 *  1. `output.schema` is validated against a strict subset of JSON Schema at register
 *     time — `required` is an object-level array of names, never a boolean on a
 *     property (`schema.properties.text.required is not supported on type "string"`).
 *  2. The same schema is used at call time to validate what the tool actually returns
 *     (`validateJsonSchemaValue`), so a field declared here must really be present.
 *     That is why the image reference keeps `additionalProperties: true`: the store may
 *     add display fields over time, and a strict object would fail the call instead.
 */
function attachmentSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['attachmentId'],
    properties: {
      attachmentId: { type: 'string', description: 'Opaque content-addressed id, e.g. sha256:...' },
      mediaType: { type: 'string' },
      bytes: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      name: { type: 'string' },
      originalDimensions: {
        type: 'object',
        additionalProperties: true,
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
      },
    },
  };
}

/**
 * Every tool must declare `output: { schema, render }` — the host rejects the whole
 * plugin otherwise, with `tool "<name>" must declare output { schema, render }`.
 * `render` turns the tool's return value into the content blocks the model sees.
 */
function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
        image: attachmentSchema(),
      },
    },
    render: (_args, value) => {
      const text = typeof value?.text === 'string' ? value.text : String(value ?? '');
      if (value?.image === undefined) return [{ type: 'text', text }];
      return [
        { type: 'text', text },
        { type: 'image', attachment: value.image },
      ];
    },
  };
}

/**
 * Keep only the fields the attachment schema declares. The host validates the tool's
 * return value against `output.schema`, which is `additionalProperties: false`, so an
 * extra key on the reference would fail the call.
 */
function toAttachmentJson(ref) {
  const json = {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  };
  if (ref.name !== undefined) json.name = ref.name;
  if (ref.originalDimensions !== undefined) {
    json.originalDimensions = {
      width: ref.originalDimensions.width,
      height: ref.originalDimensions.height,
    };
  }
  return json;
}

async function attachImage(ctx, text, buffer, fileName = 'browser.png') {
  if (!buffer) return { text };
  const attachments = optionalService(ctx, 'attachments');
  if (!attachments?.saveImage) {
    // No attachment service: keep the tool useful and say why the image is missing.
    return { text: `${text}\n(screenshot captured, ${buffer.length} bytes, but this host exposes no attachment service to return it through)` };
  }
  try {
    const ref = await attachments.saveImage({
      data: buffer,
      mediaType: 'image/png',
      name: fileName,
    });
    return {
      text: `${text}\nScreenshot attached (${buffer.length} bytes). It matches the viewport 1:1, so the coordinates above are valid pixels in it.`,
      image: toAttachmentJson(ref),
    };
  } catch (error) {
    return { text: `${text}\n(screenshot could not be attached: ${error?.message ?? String(error)})` };
  }
}

/** Resolve a ref or a visible-name match into viewport coordinates. */
async function locate(connection, { ref, text }) {
  if (Number.isFinite(Number(ref)) && Number(ref) > 0) {
    const position = await evaluate(
      connection,
      `(() => {
        const el = document.querySelector('[data-dsh-bg-ref="${Number(ref)}"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          label: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80)
        };
      })()`,
    );
    if (!position) {
      throw new Error(
        `Element #${Number(ref)} is gone. Take a fresh browser_snapshot and use the new ref numbers.`,
      );
    }
    return { ...position, matchedBy: 'ref' };
  }

  const needle = String(text ?? '').trim();
  if (!needle) throw new Error('Provide either ref or text.');

  const snap = await snapshot(connection);
  const lowered = needle.toLowerCase();
  const hits = snap.elements.filter((el) => el.name.toLowerCase().includes(lowered));
  if (hits.length === 0) {
    throw new Error(
      `No visible element contains "${needle}". Visible elements:\n${formatElements(snap)}`,
    );
  }
  if (hits.length > 1) {
    const list = hits.map((el) => `#${el.ref} ${el.tag} "${el.name}"`).join('\n');
    throw new Error(
      `"${needle}" matches ${hits.length} elements — pick one by ref instead of guessing:\n${list}`,
    );
  }
  return { x: hits[0].x, y: hits[0].y, label: hits[0].name, matchedBy: 'text' };
}

function createTools(ctx, settings, host) {
  const connection = () => host.page();

  const doctor = {
    name: 'computer_use_doctor',
    description:
      'Diagnose the background computer-use plugin: Node version, browser path, CDP port, profile directory and whether the private browser answers. Run this first when browser_* tools fail.',
    parameters: {
      restart: {
        type: 'boolean',
        description: 'Shut the private browser down before probing, to test a cold start.',
      },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const lines = [];
      lines.push(`node: ${process.version} (need >= 22.19 for native WebSocket)`);
      lines.push(
        `runtime: WebSocket ${typeof WebSocket === 'function' ? 'builtin' : 'MISSING'}, fetch ${
          typeof fetch === 'function' ? 'builtin' : 'MISSING'
        }`,
      );
      lines.push(`plugin enabled: ${settings.enabled}`);
      lines.push(`port: ${settings.port}, headless: ${settings.headless}, viewport: ${settings.width}x${settings.height}`);
      lines.push(`dialogs: ${settings.dialogBehavior}${settings.dialogBehavior === 'accept' && settings.dialogPromptText ? ' (prompt text supplied)' : ''}`);
      lines.push(`profile: ${host.profileDir}`);

      let exe;
      try {
        exe = resolveBrowser(settings.browserPath);
        lines.push(`browser: ${exe}`);
      } catch (error) {
        lines.push(`browser: NOT FOUND — ${error.message}`);
        return { text: lines.join('\n') };
      }

      if (args?.restart) {
        await host.shutdown().catch(() => {});
        lines.push('browser shut down for a cold-start test.');
      }

      try {
        const conn = await connection();
        const info = await evaluate(conn, '({url: location.href, title: document.title})');
        lines.push(`port in use: ${host.port}${host.port !== settings.port ? ` (configured ${settings.port} was busy, moved over)` : ''}`);
        lines.push(`live page: ${info.url} — "${info.title}"`);
        lines.push('status: OK. The private browser is up and answers CDP.');
      } catch (error) {
        lines.push(`status: FAILED — ${error?.message ?? String(error)}`);
      }
      return { text: lines.join('\n') };
    },
  };

  const open = {
    name: 'browser_open',
    description:
      'Open a URL in the private browser (a separate Chromium instance that does not touch the user\'s windows or focus). Returns the interactive elements and a screenshot.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Absolute URL, e.g. https://github.com. A bare domain gets https:// prepended.',
      },
      screenshot: {
        type: 'boolean',
        description: 'Attach a screenshot (default true). Set false to save image tokens.',
      },
    },
    output: toolOutput(),
    timeoutMs: 120000,
    async execute(args) {
      const conn = await connection();
      const result = await navigate(conn, args.url, { timeoutMs: 45000 });
      const snap = await snapshot(conn).catch((error) => {
        throw new Error(`Opened ${result.url} but could not read the page: ${error.message}`);
      });
      const wantShot = args.screenshot !== false;
      const shot = wantShot ? await screenshot(conn).catch(() => null) : null;
      const note = result.loaded ? '' : `\n(readyState was "${result.readyState}" after 45s — the page may still be loading.)`;
      return attachImage(ctx, `${formatElements(snap)}${note}`, shot);
    },
  };

  const snapTool = {
    name: 'browser_snapshot',
    description:
      'Re-read the current page: interactive elements with stable ref numbers, plus the URL, title and scroll position. Call this after the page changes (navigation, a menu opened, results loaded), because ref numbers are renumbered on every snapshot.',
    parameters: {
      screenshot: { type: 'boolean', description: 'Attach a screenshot (default true).' },
      text: {
        type: 'boolean',
        description: 'Also return the page text (default false). Cheaper than a screenshot when you only need the words.',
      },
      limit: { type: 'number', description: 'Max characters of page text when text is true (default 6000).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      const snap = await snapshot(conn);
      let text = formatElements(snap);
      if (args?.text) {
        const body = await pageText(conn, Number(args.limit) || 6000).catch(() => '');
        if (body) text += `\n\n--- page text ---\n${body}`;
      }
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, text, shot);
    },
  };

  const click = {
    name: 'browser_click',
    description:
      'Click an element in the private browser. Prefer `ref` from the latest snapshot; `text` matches a visible label (and fails loudly when several match, listing them); `x`/`y` are viewport pixels as a last resort. Does not move the real cursor.',
    parameters: {
      ref: { type: 'number', description: 'Element number from the latest browser_snapshot.' },
      text: { type: 'string', description: 'Visible label to click, e.g. "Sign in".' },
      x: { type: 'number', description: 'Viewport x in pixels (only with y, when ref/text are not usable).' },
      y: { type: 'number', description: 'Viewport y in pixels.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      clickCount: { type: 'number', description: '1 = single click (default), 2 = double click.' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot after clicking (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      let point;
      if (Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))) {
        point = { x: Number(args.x), y: Number(args.y), label: '(coordinates)', matchedBy: 'coords' };
      } else {
        point = await locate(conn, { ref: args?.ref, text: args?.text });
      }
      await clickAt(conn, point.x, point.y, {
        button: args?.button === 'right' ? 'right' : args?.button === 'middle' ? 'middle' : 'left',
        clickCount: Number(args?.clickCount) === 2 ? 2 : 1,
      });
      // Give the page a moment to react before re-reading it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snap = await snapshot(conn).catch(() => null);
      const head = `Clicked ${point.matchedBy === 'coords' ? `(${point.x}, ${point.y})` : `${point.matchedBy} ${point.label ? `"${point.label}"` : ''}`} at (${point.x}, ${point.y}).`;
      if (!snap) return { text: `${head} The page did not respond to a snapshot — take browser_snapshot to see its state.` };
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const type = {
    name: 'browser_type',
    description:
      'Type text into the private browser. With `ref` (or `text`) the element is clicked first to focus it; without either, text goes to whatever is focused. `submit` presses Enter afterwards.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to insert.' },
      ref: { type: 'number', description: 'Element to focus before typing.' },
      target: { type: 'string', description: 'Visible label of the element to focus, when ref is unknown.' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      let focusNote = 'typed into the focused element';
      if (args?.ref !== undefined || args?.target !== undefined) {
        const point = await locate(conn, { ref: args?.ref, text: args?.target });
        await clickAt(conn, point.x, point.y);
        focusNote = `typed into ${point.label ? `"${point.label}"` : 'the target element'}`;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await insertText(conn, args.text);
      if (args?.submit) {
        await pressKey(conn, 'enter');
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const snap = await snapshot(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      const head = `Inserted ${String(args.text).length} character(s), ${focusNote}${args?.submit ? ', then pressed Enter' : ''}.`;
      if (!snap) return { text: head };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const key = {
    name: 'browser_key',
    description:
      'Press a key or shortcut in the private browser, e.g. "Enter", "Tab", "Escape", "ctrl+a", "ctrl+l", "PageDown".',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or chord, e.g. "Enter" or "ctrl+a".' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      await pressKey(conn, args.key);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snap = await snapshot(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      const head = `Pressed ${args.key}.`;
      if (!snap) return { text: head };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const scroll = {
    name: 'browser_scroll',
    description: 'Scroll the private browser viewport. Positive deltaY scrolls down.',
    parameters: {
      deltaY: { type: 'number', description: 'Vertical pixels (default 600).' },
      deltaX: { type: 'number', description: 'Horizontal pixels (default 0).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      const deltaY = Number.isFinite(Number(args?.deltaY)) ? Number(args.deltaY) : 600;
      const deltaX = Number.isFinite(Number(args?.deltaX)) ? Number(args.deltaX) : 0;
      await scrollBy(conn, { deltaY, deltaX });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const snap = await snapshot(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      const head = `Scrolled by (${deltaX}, ${deltaY}).`;
      if (!snap) return { text: head };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const textTool = {
    name: 'browser_text',
    description:
      'Read the visible text of the private browser page as plain text. Cheaper than a screenshot when you only need the words (article bodies, search results, table contents).',
    parameters: {
      limit: { type: 'number', description: 'Max characters to return (default 6000, hard cap 20000).' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      const limit = Math.min(20000, Math.max(500, Number(args?.limit) || 6000));
      const body = await pageText(conn, limit);
      return { text: body || '(the page has no readable text — try browser_snapshot with a screenshot)' };
    },
  };

  const evalTool = {
    name: 'browser_eval',
    description:
      'Run JavaScript in the private browser page and return the result (JSON-serialisable). Escape hatch for reading structured data (tables, JSON in the page) or setting a value. The result is capped at 20000 characters.',
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: 'An expression or IIFE. Must return a JSON-serialisable value.',
      },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      const value = await evaluate(conn, String(args.expression));
      let rendered;
      try {
        rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      } catch {
        rendered = String(value);
      }
      const out = rendered ?? 'undefined';
      return { text: out.length > 20000 ? `${out.slice(0, 20000)}\n…[truncated]` : out };
    },
  };

  const waitTool = {
    name: 'browser_wait',
    description:
      'Wait until the page is ready: an element matching a CSS `selector` exists, some visible `text` appears, a `selector` in `gone` disappears, or (with no condition) the document finishes loading. Use this instead of a fixed pause after clicking something that loads results. Returns as soon as the condition holds; on timeout it reports what the page actually looks like so you can recover.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector that must exist, e.g. ".results" or "#login-form".' },
      text: { type: 'string', description: 'Visible text that must appear, e.g. "Sign in".' },
      gone: { type: 'string', description: 'CSS selector that must disappear, e.g. ".loading".' },
      timeoutMs: { type: 'number', description: 'Budget in milliseconds (default 15000, max 120000).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot when the condition holds (default false — waits are cheap on purpose).' },
    },
    output: toolOutput(),
    timeoutMs: 130000,
    async execute(args) {
      const conn = await connection();
      const condition = {
        selector: args?.selector,
        text: args?.text,
        gone: args?.gone,
        timeoutMs: Number(args?.timeoutMs) || 15000,
      };
      const label =
        condition.selector !== undefined && condition.selector !== ''
          ? `selector "${condition.selector}"`
          : condition.gone !== undefined && condition.gone !== ''
            ? `"${condition.gone}" disappearing`
            : condition.text !== undefined && condition.text !== ''
              ? `text "${condition.text}"`
              : 'the document to finish loading';

      const result = await waitFor(conn, condition);
      const seconds = (Number(result.elapsed) / 1000).toFixed(1);

      if (result.ok) {
        const head = `Wait satisfied after ${seconds}s — ${label}.\nAt ${result.url} (${result.readyState})`;
        if (args?.screenshot !== true) return { text: head };
        const shot = await screenshot(conn).catch(() => null);
        return attachImage(ctx, head, shot);
      }

      // A miss is the interesting case: show what is there instead of just "timed out".
      const reason = result.fatal
        ? `The selector is not usable: ${result.fatal}`
        : `Timed out after ${seconds}s waiting for ${label}. Still at ${result.url} (${result.readyState}).`;
      const snap = await snapshot(conn).catch(() => null);
      const detail = snap ? `\n${formatElements(snap)}` : '\n(The page did not answer a snapshot — it may be navigating.)';
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${reason}${detail}`, shot);
    },
  };

  const navTool = {
    name: 'browser_nav',
    description:
      'Navigate the current tab: `reload` re-fetches this page, `back` / `forward` walk the tab history. Use this instead of browser_open when you just need to retry or step back.',
    parameters: {
      action: { type: 'string', enum: ['reload', 'back', 'forward'], required: true, description: 'What to do.' },
      ignoreCache: { type: 'boolean', description: 'reload only: bypass the cache (default false).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      const action = String(args?.action ?? '').toLowerCase();
      if (!['reload', 'back', 'forward'].includes(action)) {
        throw new Error(`action must be one of reload / back / forward (got "${args?.action}").`);
      }

      let head;
      if (action === 'reload') {
        const result = await reload(conn, { ignoreCache: args?.ignoreCache === true });
        head = result.loaded ? 'Reloaded the page.' : `Reload started, but the document was still "${result.readyState}" — it may still be loading.`;
      } else {
        const result = await goHistory(conn, action === 'back' ? -1 : 1);
        head = `${action === 'back' ? 'Went back' : 'Went forward'} to ${result.url}${result.loaded ? '' : ' (still loading)'}.`;
      }

      const snap = await snapshot(conn).catch(() => null);
      if (!snap) return { text: `${head} The page did not answer a snapshot — take browser_snapshot once it settles.` };
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const uploadTool = {
    name: 'browser_upload',
    description:
      'Attach local files to a file input without opening the native picker. Point it at the actual <input type="file"> (often hidden behind a styled button) by `ref` or CSS `selector`. Paths must be absolute.',
    parameters: {
      ref: { type: 'number', description: 'Element number from the latest snapshot, if the file input is in it.' },
      selector: { type: 'string', description: 'CSS selector for the <input type="file">, when ref is not usable.' },
      files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Absolute paths of the files to attach, e.g. ["C:\\\\Users\\\\me\\\\Desktop\\\\a.png"].',
      },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      const files = Array.isArray(args?.files) ? args.files.map((file) => String(file).trim()).filter(Boolean) : [];
      if (files.length === 0) throw new Error('files must be a non-empty array of absolute paths.');

      const missing = files.filter((file) => !existsSync(file));
      if (missing.length > 0) {
        throw new Error(`These files do not exist, so nothing was uploaded:\n${missing.join('\n')}`);
      }

      let selector = typeof args?.selector === 'string' && args.selector.trim() ? args.selector.trim() : '';
      if (!selector) {
        if (!Number.isFinite(Number(args?.ref))) {
          throw new Error('Provide either ref (from browser_snapshot) or a CSS selector for the file input.');
        }
        // The snapshot tags every element it numbered, so a ref is addressable in CSS.
        selector = `[data-dsh-bg-ref="${Number(args.ref)}"]`;
      }

      const result = await setFileInput(conn, { selector, files });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snap = await snapshot(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      const head =
        `Attached ${result.count} file(s) to ${selector} ` +
        `(${files.map((file) => file.split(/[\\\\/]/).pop()).join(', ')}). ` +
        'Most uploads do not start by themselves — click the submit control next if the page still shows the old state.';
      if (!snap) return { text: head };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const close = {
    name: 'browser_close',
    description:
      'Shut down the private browser. Use it when the task is done to release memory; the next browser_* call starts a fresh one.',
    parameters: {},
    output: toolOutput(),
    timeoutMs: 30000,
    async execute() {
      await host.shutdown();
      return { text: 'Private browser shut down. Its profile (cookies, logins) is kept on disk for the next run.' };
    },
  };

  return [doctor, open, snapTool, click, type, key, scroll, textTool, evalTool, waitTool, navTool, uploadTool, close];
}

export function apply(ctx, config = {}) {
  const settings = readSettings(config);
  if (!settings.enabled) {
    log(ctx, 'dsh-computer-use-bg: disabled by config (enabled: false) — no browser tools registered.');
    return;
  }

  const host = new BrowserHost({
    exePath: settings.browserPath,
    port: settings.port,
    headless: settings.headless,
    width: settings.width,
    height: settings.height,
    profileDir: settings.profileDir,
    timeoutMs: settings.timeoutMs,
    idleMs: settings.idleMs,
    dialogBehavior: settings.dialogBehavior,
    dialogPromptText: settings.dialogPromptText,
  });

  const tools = createTools(ctx, settings, host);
  for (const tool of tools) {
    // Every call is activity: keep the browser warm while the agent is working, and
    // let the idle timer reclaim it once the run is over.
    const run = tool.execute.bind(tool);
    const keepsBrowser = tool.name !== 'browser_close';
    tool.execute = async (...args) => {
      if (keepsBrowser) host.touch();
      try {
        const result = await run(...args);
        // Dialogs are answered the moment they open, but the model still has to know:
        // silently accepting a confirm() would look like the action was cancelled.
        const note = drainDialogs(host.connection);
        if (note && result && typeof result.text === 'string') return { ...result, text: `${result.text}${note}` };
        return result;
      } finally {
        if (keepsBrowser) host.touch();
      }
    };
    ctx.effect(() => ctx.tools.register(tool), `dsh-computer-use-bg: tool ${tool.name}`);
  }

  ctx.effect(
    () => () => {
      host.release();
    },
    'dsh-computer-use-bg: release cdp session',
  );

  log(
    ctx,
    `dsh-computer-use-bg: ${tools.length} tools registered (port ${settings.port}, viewport ${settings.width}x${settings.height})`,
  );
}
