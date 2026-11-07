/**
 * dsh-computer-use-bg — background computer use for DeepSeek Harness.
 *
 * The agent drives a private Chromium instance over CDP. Nothing here moves the
 * real cursor, presses real keys or steals foreground focus, so the user can keep
 * working while the agent browses.
 */

import { BrowserHost, resolveBrowser } from './cdp.js';
import {
  clickAt,
  evaluate,
  insertText,
  navigate,
  pageText,
  pressKey,
  screenshot,
  scrollBy,
  snapshot,
} from './page.js';

export const name = 'dsh-computer-use-bg';
export const inject = ['tools', 'attachments'];

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;

function readSettings(config = {}) {
  return {
    enabled: config.enabled !== false,
    browserPath: typeof config.browserPath === 'string' && config.browserPath.trim() ? config.browserPath.trim() : undefined,
    port: Number.isFinite(Number(config.port)) ? Number(config.port) : 9411,
    headless: config.headless === true,
    width: Number.isFinite(Number(config.width)) && Number(config.width) >= 320 ? Number(config.width) : DEFAULT_WIDTH,
    height: Number.isFinite(Number(config.height)) && Number(config.height) >= 240 ? Number(config.height) : DEFAULT_HEIGHT,
    profileDir: typeof config.profileDir === 'string' && config.profileDir.trim() ? config.profileDir.trim() : undefined,
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 25000,
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

async function attachImage(ctx, text, buffer, fileName = 'browser.png') {
  if (!buffer) return { text };
  try {
    const ref = await ctx.attachments.saveImage({
      data: buffer,
      mediaType: 'image/png',
      name: fileName,
    });
    return {
      text: `${text}\nScreenshot attached (${buffer.length} bytes). It matches the viewport 1:1, so the coordinates above are valid pixels in it.`,
      image: JSON.parse(JSON.stringify(ref)),
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

  const close = {
    name: 'browser_close',
    description:
      'Shut down the private browser. Use it when the task is done to release memory; the next browser_* call starts a fresh one.',
    parameters: {},
    timeoutMs: 30000,
    async execute() {
      await host.shutdown();
      return { text: 'Private browser shut down. Its profile (cookies, logins) is kept on disk for the next run.' };
    },
  };

  return [doctor, open, snapTool, click, type, key, scroll, textTool, evalTool, close];
}

export function apply(ctx, config = {}) {
  const settings = readSettings(config);
  if (!settings.enabled) {
    ctx.logger?.info?.('dsh-computer-use-bg: disabled by config (enabled: false) — no browser tools registered.');
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
  });

  const tools = createTools(ctx, settings, host);
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-computer-use-bg: tool ${tool.name}`);
  }

  ctx.effect(
    () => () => {
      host.release();
    },
    'dsh-computer-use-bg: release cdp session',
  );

  ctx.logger?.info?.(
    `dsh-computer-use-bg: ${tools.length} tools registered (port ${settings.port}, viewport ${settings.width}x${settings.height})`,
  );
}
