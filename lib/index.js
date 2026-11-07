/**
 * dsh-computer-use-bg — background computer use for DeepSeek Harness.
 *
 * The agent drives a private Chromium instance over CDP. Nothing here moves the
 * real cursor, presses real keys or steals foreground focus, so the user can keep
 * working while the agent browses.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BrowserHost, resolveBrowser } from './cdp.js';
import { DesktopHost, findPython, helperPath } from './desktop.js';
import { locateInFrames, readText, snapshotAll, uploadInFrames, waitAcrossFrames } from './frames.js';
import {
  FRAME_WALK,
  clickAt,
  dragBetween,
  dragProbe,
  dropFilesAt,
  elementBox,
  evaluate,
  goHistory,
  hoverAt,
  insertText,
  navigate,
  pngSize,
  pressKey,
  reload,
  screenshot,
  screenshotRegion,
  scrollBy,
  setFileInput,
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
    downloadDir: typeof config.downloadDir === 'string' && config.downloadDir.trim() ? config.downloadDir.trim() : undefined,
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 25000,
    dialogBehavior: config.dialogBehavior === 'dismiss' ? 'dismiss' : 'accept',
    dialogPromptText: typeof config.dialogPromptText === 'string' ? config.dialogPromptText : '',
    // A link that opens a new tab is, for the person clicking it, a navigation. Staying
    // on the old tab would show a page that did not change, which reads as "the click
    // did nothing". Following it matches what the user would see.
    followNewTabs: config.followNewTabs !== false,
    // The desktop plane (native windows) is opt-out: it needs Python 3, which not every
    // machine has, and a plugin that cannot load is worse than one that does less.
    desktop: config.desktop !== false,
    pythonPath: typeof config.pythonPath === 'string' && config.pythonPath.trim() ? config.pythonPath.trim() : undefined,
    desktopIsolated: config.desktopIsolated !== false,
    // Attach mode: drive an app that is already running instead of the private browser.
    attachUrl: typeof config.attachUrl === 'string' && config.attachUrl.trim() ? config.attachUrl.trim() : undefined,
    shotDir: typeof config.shotDir === 'string' && config.shotDir.trim() ? config.shotDir.trim() : undefined,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Report downloads that changed state since the last tool call.
 *
 * A click that fetches a file changes nothing on screen: without this note the honest
 * conclusion from a snapshot is "nothing happened", right after an export that worked
 * perfectly. It rides along like the dialog note — once per state change, on the next
 * result — so no extra call is needed to notice it.
 */
function drainDownloads(host) {
  const list = typeof host.downloads === 'function' ? host.downloads() : [];
  const parts = [];
  for (const item of list) {
    if (item.reportedState === item.state) continue;
    item.reportedState = item.state;
    const name = item.suggestedFilename || 'download';
    if (item.state === 'completed') {
      const size = formatBytes(item.bytes ?? item.receivedBytes);
      parts.push(`"${name}" finished${size ? ` (${size})` : ''} — ${item.path ?? `see ${host.downloadDir}`}`);
    } else if (item.state === 'canceled') {
      parts.push(`"${name}" was cancelled`);
    } else {
      parts.push(`"${name}" is downloading — browser_download with wait: true blocks until it lands`);
    }
  }
  if (parts.length === 0) return '';
  return `\n(download: ${parts.join('; ')})`;
}

/**
 * Notice tabs that appeared since the last tool call — and move to them.
 *
 * `target="_blank"`, OAuth windows and "open in a new tab" buttons all create a new
 * target. The page session stays on the old tab, so the click looks like it did
 * nothing at all and the model keeps re-clicking. Chrome emits no event about it on a
 * page-level socket, so the tab set is compared instead: ids that were not there
 * before are exactly the ones a click just opened.
 *
 * Following is the default because it is what the user sees. The result text has to
 * say so plainly: the element list attached to the call that opened the tab describes
 * the page that was left, and those refs are now meaningless.
 */
async function drainTabs(host, settings) {
  if (typeof host.listTabs !== 'function') return '';
  const tabs = await host.listTabs().catch(() => null);
  if (!tabs) return '';
  const fresh = tabs.filter((tab) => !host.knownTabs.has(tab.id));
  for (const tab of tabs) host.knownTabs.add(tab.id);
  if (fresh.length === 0) return '';

  const first = fresh[0];
  const label = `"${first.title || '(untitled)'}" — ${String(first.url).slice(0, 120)}`;
  const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';

  if (!settings.followNewTabs) {
    return `\n(new tab opened: ${label}${extra}, id ${first.id}. These tools are still on the previous tab — browser_tabs with action "select" switches.)`;
  }
  try {
    await host.useTab(first.id);
  } catch (error) {
    return `\n(new tab opened: ${label}${extra}, id ${first.id}, but switching to it failed: ${error.message}. Use browser_tabs with action "select".)`;
  }
  return (
    `\n(new tab opened and is now the active tab: ${label}${extra}, id ${first.id}. ` +
    'The element list above belongs to the page you just left — those refs are stale now, so call browser_snapshot to read this tab.)'
  );
}

/** Compact one-line-per-element rendering: cheaper in tokens than JSON. */function formatElements(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`Title: ${snap.title}`);
  lines.push(
    `Viewport ${snap.viewport.width}x${snap.viewport.height}, scrollY ${snap.scroll.y} of ${snap.scroll.height}. ` +
      `${snap.elements.length} interactive element(s) in view.`,
  );

  const frames = snap.frames || { scanned: 0, blocked: [] };
  if (frames.scanned > 0) {
    lines.push(
      `Same-origin frames scanned: ${frames.scanned}. Elements marked (f0.1) live inside frame 0.1; ` +
        'their coordinates are already translated into this viewport, so clicking them works normally.',
    );
  }
  const cross = Array.isArray(frames.cross) ? frames.cross : [];
  if (cross.length > 0) {
    const shown = cross
      .slice(0, 4)
      .map((frame) => `${frame.path}${frame.process ? ' (own process)' : ''}${frame.url ? ` ${String(frame.url).slice(0, 60)}` : ''}`);
    lines.push(
      `Read through ${cross.length} cross-origin frame(s): ${shown.join('; ')}${cross.length > 4 ? '; …' : ''}. ` +
        'Their elements are numbered like everything else, and their coordinates are already in this viewport, so clicking and typing reach them normally.',
    );
    if (snap.hiddenInFrames > 0) {
      lines.push(
        `${snap.hiddenInFrames} more element(s) inside those frames are scrolled out of the frame and were left out — ` +
          'a click at their coordinates would land on whatever covers the frame, so scroll the page first.',
      );
    }
  }
  const unread = Array.isArray(frames.unread) ? frames.unread : [];
  if (unread.length > 0) {
    const shown = unread
      .slice(0, 3)
      .map((frame) => `${frame.path}${frame.url ? ` ${String(frame.url).slice(0, 55)}` : ''} — ${frame.reason}`);
    lines.push(
      `${unread.length} cross-origin frame(s) still cannot be read: ${shown.join('; ')}${unread.length > 3 ? '; …' : ''}. ` +
        'Nothing inside those can be listed; x/y coordinates could still reach them, but the result could not be read back.',
    );
  } else if (cross.length === 0 && Array.isArray(frames.blocked) && frames.blocked.length > 0) {
    const shown = frames.blocked.slice(0, 3).map((src) => (src ? String(src).slice(0, 70) : '(inline)'));
    lines.push(
      `${frames.blocked.length} cross-origin frame(s) could not be read: ${shown.join(', ')}` +
        `${frames.blocked.length > 3 ? ', …' : ''}. Nothing inside them can appear in this list. ` +
        'If the page looks empty, what you want is probably there — only x/y coordinates can reach it, and the result cannot be read back.',
    );
  }

  if (snap.elements.length === 0) {
    lines.push('No interactive elements in view. Scroll, or read the page with browser_text.');
  }
  for (const el of snap.elements) {
    const role = el.role ? `${el.role}` : el.tag;
    const type = el.type ? `[${el.type}]` : '';
    const label = el.name ? ` "${el.name}"` : '';
    const flag = el.disabled ? ' (disabled)' : '';
    const where = el.frame ? `(f${el.frame})` : '';
    lines.push(`#${el.ref}${where} ${role}${type}${label} @${el.x},${el.y} ${el.w}x${el.h}${flag}`);
  }
  return lines.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Elements present in `after` with no counterpart in `before`.
 *
 * Matching is by `tag|role|name` because refs are renumbered by every snapshot and
 * therefore useless for comparing two of them. The budget map makes duplicates work:
 * three identical "Delete" buttons that stay put match three times, so a fourth one
 * that really did appear is still reported.
 */
function appearedSince(before, after) {
  const keyOf = (el) => `${el.tag}|${el.role}|${el.name}`;
  const budget = new Map();
  for (const el of before.elements) {
    const key = keyOf(el);
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  return after.elements.filter((el) => {
    const key = keyOf(el);
    const left = budget.get(key) ?? 0;
    if (left === 0) return true;
    budget.set(key, left - 1);
    return false;
  });
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

async function attachImage(ctx, text, buffer, options = {}) {
  if (!buffer) return { text };
  const attachments = optionalService(ctx, 'attachments');
  const size = formatBytes(buffer.length);
  if (!attachments?.saveImage) {
    // No attachment service: keep the tool useful and say why the image is missing.
    return { text: `${text}\n(screenshot captured, ${buffer.length} bytes, but this host exposes no attachment service to return it through)` };
  }
  try {
    const ref = await attachments.saveImage({
      data: buffer,
      mediaType: 'image/png',
      name: options.fileName ?? 'browser.png',
    });
    const note =
      options.note ?? 'Screenshot attached. It matches the viewport 1:1, so the coordinates above are valid pixels in it.';
    return {
      text: `${text}\n${note}${size ? ` (${size})` : ''}`,
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
        ${FRAME_WALK}
        const { docs } = walkDocs(document);
        const wanted = '[data-dsh-bg-ref="' + ${Number(ref)} + '"]';
        for (const entry of docs) {
          const el = entry.doc.querySelector(wanted);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return null;
          return {
            x: Math.round(rect.left + rect.width / 2 + entry.dx),
            y: Math.round(rect.top + rect.height / 2 + entry.dy),
            label: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
            frame: entry.path
          };
        }
        return null;
      })()`,
    );
    if (!position) {
      // Ref numbering is global, so a number from a cross-origin frame cannot be found
      // in this document — look there before declaring it gone.
      const framed = await locateInFrames(connection, { ref }).catch(() => null);
      if (framed) {
        return { x: framed.x, y: framed.y, label: framed.label, frame: framed.frame, ref: Number(ref), matchedBy: 'ref' };
      }
      throw new Error(
        `Element #${Number(ref)} is gone. Take a fresh browser_snapshot and use the new ref numbers.`,
      );
    }
    return { ...position, ref: Number(ref), matchedBy: 'ref' };
  }

  const needle = String(text ?? '').trim();
  if (!needle) throw new Error('Provide either ref or text.');

  const snap = await snapshotAll(connection);
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
  return { x: hits[0].x, y: hits[0].y, label: hits[0].name, frame: hits[0].frame, ref: hits[0].ref, matchedBy: 'text' };
}

function createTools(ctx, settings, host, desk) {
  const connection = () => host.page();
  // Native window captures are written once and attached, the same way browser crops
  // are: the image is the deliverable, the path is only a handover.
  const shotDir =
    settings.shotDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-computer-use-bg', 'shots');

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
      lines.push(
        host.foreign
          ? `mode: attached to ${host.attachUrl} (not a browser this plugin started — nothing will be closed)`
          : 'mode: private browser',
      );
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
        const armed = host.browserConnection
          ? `armed — ${host.browserConnection.downloads?.length ?? 0} this session`
          : `NOT armed${host.downloadError ? ` — ${host.downloadError.message}` : ''}`;
        lines.push(`downloads: ${host.downloadDir} (${armed})`);
        lines.push('status: OK. The private browser is up and answers CDP.');
      } catch (error) {
        lines.push(`status: FAILED — ${error?.message ?? String(error)}`);
      }

      // The desktop plane has its own dependency (a python 3 with ctypes) and its own
      // failure mode, so it is diagnosed even when the browser answers fine.
      if (!settings.desktop) {
        lines.push('desktop: disabled by config (desktop: false)');
        return { text: lines.join('\n') };
      }
      try {
        const python = await findPython({ explicit: settings.pythonPath });
        lines.push(`desktop python: ${python.version} ${python.bits}-bit — ${python.exe}${python.args.length ? ` ${python.args.join(' ')}` : ''}`);
        lines.push(`desktop helper: ${helperPath()} (${desk.running ? 'running' : 'not started yet'})`);
        const desktops = desk.running ? await desk.desktops().catch(() => []) : [];
        lines.push(`isolated desktops: ${desktops.length === 0 ? 'none yet (desktop_launch creates one)' : desktops.map((item) => item.name).join(', ')}`);
      } catch (error) {
        lines.push(`desktop: NOT AVAILABLE — ${error.message}`);
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
      const snap = await snapshotAll(conn).catch((error) => {
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
      const snap = await snapshotAll(conn);
      let text = formatElements(snap);
      if (args?.text) {
        const body = await readText(conn, Number(args.limit) || 6000).catch(() => '');
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
      const snap = await snapshotAll(conn).catch(() => null);
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
      const snap = await snapshotAll(conn).catch(() => null);
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
      const snap = await snapshotAll(conn).catch(() => null);
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
      const snap = await snapshotAll(conn).catch(() => null);
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
      const body = await readText(conn, limit);
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

      const result = await waitAcrossFrames(conn, condition);
      const seconds = (Number(result.elapsed) / 1000).toFixed(1);

      if (result.ok) {
        const where = result.inFrame ? ` (matched inside cross-origin frame ${result.frame})` : '';
        const head = `Wait satisfied after ${seconds}s — ${label}${where}.\nAt ${result.url} (${result.readyState})`;
        if (args?.screenshot !== true) return { text: head };
        const shot = await screenshot(conn).catch(() => null);
        return attachImage(ctx, head, shot);
      }

      // A miss is the interesting case: show what is there instead of just "timed out".
      const reason = result.fatal
        ? `The selector is not usable: ${result.fatal}`
        : `Timed out after ${seconds}s waiting for ${label}. Still at ${result.url} (${result.readyState}).`;
      const snap = await snapshotAll(conn).catch(() => null);
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

      const snap = await snapshotAll(conn).catch(() => null);
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

      // A payment widget or an embedded editor keeps its file input in its own document;
      // the page-side lookup cannot see it, so the frames are tried before giving up.
      let result;
      try {
        result = await setFileInput(conn, { selector, files });
      } catch (error) {
        const framed = await uploadInFrames(conn, { selector, files }).catch(() => null);
        if (!framed) throw error;
        result = framed;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snap = await snapshotAll(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      const head =
        `Attached ${result.count} file(s) to ${selector}` +
        `${result.frame ? ` inside cross-origin frame ${result.frame}` : ''} ` +
        `(${files.map((file) => file.split(/[\\\\/]/).pop()).join(', ')}). ` +
        'Most uploads do not start by themselves — click the submit control next if the page still shows the old state.';
      if (!snap) return { text: head };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const downloadTool = {
    name: 'browser_download',
    description:
      'See what the page downloaded, its size, and the absolute path on disk. Clicks that fetch a file change nothing on screen, so reach for this after clicking an export, "download", invoice or PDF control. `wait: true` blocks until the transfer finishes. Files are saved to the plugin\'s own download folder, not the user\'s.',
    parameters: {
      wait: { type: 'boolean', description: 'Wait for in-progress downloads to finish (default false).' },
      timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (default 30000, max 180000).' },
      filename: { type: 'string', description: 'Only report downloads whose suggested name contains this text.' },
    },
    output: toolOutput(),
    timeoutMs: 190000,
    async execute(args) {
      // Ensures the browser — and with it the download session — is up before asking.
      await connection();
      const budget = Math.min(180000, Math.max(1000, Number(args?.timeoutMs) || 30000));
      if (args?.wait) {
        // A click a few milliseconds ago may not have been announced yet; waiting on an
        // empty list would return instantly and look like nothing was downloaded.
        await sleep(400);
      }
      const all = args?.wait ? await host.waitForDownloads(budget) : host.downloads();
      const needle = typeof args?.filename === 'string' ? args.filename.trim().toLowerCase() : '';
      const list = needle
        ? all.filter((item) => String(item.suggestedFilename || '').toLowerCase().includes(needle))
        : all;

      if (list.length === 0) {
        const recent = host.recentDownloads(5);
        const lines = [
          needle
            ? `No download in this session matches "${needle}".`
            : 'Nothing has been downloaded in this session yet.',
        ];
        if (host.downloadError) lines.push(`Download control is NOT armed: ${host.downloadError.message}`);
        lines.push(`Download folder: ${host.downloadDir}`);
        if (recent.length > 0) {
          lines.push('Files already in that folder, newest first (they may be from an earlier session):');
          for (const item of recent) lines.push(`  ${item.name} — ${formatBytes(item.bytes) || '0 B'} — ${item.path}`);
        } else {
          lines.push(
            'The folder is empty. If a click was meant to fetch a file, it may have opened a page instead — ' +
              'or the control needs a different target, e.g. the link itself rather than the text next to it.',
          );
        }
        return { text: lines.join('\n') };
      }

      const lines = [`${list.length} download(s)${needle ? ` matching "${needle}"` : ''} in this session.`];
      for (const item of list) {
        const state =
          item.state === 'completed' ? 'completed' : item.state === 'canceled' ? 'cancelled' : 'in progress';
        const size = formatBytes(item.bytes ?? item.receivedBytes);
        const total = formatBytes(item.totalBytes);
        lines.push(
          `- "${item.suggestedFilename}" — ${state}` +
            `${size ? ` — ${size}${item.state === 'inProgress' && total ? ` of ${total}` : ''}` : ''}`,
        );
        lines.push(`  path: ${item.path ?? '(not resolved yet — the file is in the download folder above)'}`);
        if (item.url) lines.push(`  from: ${String(item.url).slice(0, 120)}`);
        if (item.state === 'inProgress') {
          lines.push('  still downloading — call browser_download with wait: true to block until it lands');
        }
      }
      return { text: lines.join('\n') };
    },
  };

  const hoverTool = {
    name: 'browser_hover',
    description:
      'Move the pointer onto an element and report what appeared because of it. Use it for menus and tooltips that only open on hover: the new refs are what you click next. The pointer stays there, so hovering then clicking a child works.',
    parameters: {
      ref: { type: 'number', description: 'Element number from the latest browser_snapshot.' },
      text: { type: 'string', description: 'Visible label of the element to hover.' },
      x: { type: 'number', description: 'Viewport x in pixels (only with y, when ref/text are not usable).' },
      y: { type: 'number', description: 'Viewport y in pixels.' },
      settleMs: { type: 'number', description: 'How long to wait for the reveal (default 500).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      // Resolve first, then read the baseline: a baseline snapshot renumbers refs, so
      // taking it before `locate` would move the target out from under the ref the
      // caller passed in.
      let point;
      if (Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))) {
        point = { x: Number(args.x), y: Number(args.y), label: '(coordinates)', matchedBy: 'coords' };
      } else {
        point = await locate(conn, { ref: args?.ref, text: args?.text });
      }

      const before = await snapshotAll(conn).catch(() => null);
      await hoverAt(conn, point.x, point.y);
      const settle = Math.max(0, Math.min(8000, Number(args?.settleMs ?? 500)));
      await sleep(settle);
      const after = await snapshotAll(conn).catch(() => null);

      const head = `Hovered ${point.matchedBy === 'coords' ? `(${point.x}, ${point.y})` : `${point.matchedBy}${point.label ? ` "${point.label}"` : ''}`} at (${point.x}, ${point.y}) and waited ${settle}ms.`;
      if (!after) return { text: `${head} The page did not answer a snapshot — take browser_snapshot to see its state.` };

      const appeared = before ? appearedSince(before, after) : [];
      const lines = [head];
      if (!before) {
        lines.push('No baseline could be read before hovering, so only the current page is listed below.');
      } else if (appeared.length === 0) {
        lines.push(
          `Nothing new appeared (${before.elements.length} element(s) before, ${after.elements.length} now). ` +
            'The popup may already have been open, may need a click instead of a hover, or may draw itself on a canvas that has no elements to find.',
        );
      } else {
        lines.push(`Appeared after hovering (${appeared.length}):`);
        for (const el of appeared) {
          const role = el.role || el.tag;
          lines.push(`  #${el.ref} ${role}${el.name ? ` "${el.name}"` : ''} @${el.x},${el.y} ${el.w}x${el.h}`);
        }
        lines.push('Refs below are the post-hover numbering — click from this list, not from an older snapshot.');
      }

      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${lines.join('\n')}\n${formatElements(after)}`, shot);
    },
  };

  const dragTool = {
    name: 'browser_drag',
    description:
      'Drag one element onto another (or from x/y to toX/toY): sliders, sortable lists, kanban boards, file drops. Works for pointer-driven drag libraries and for native HTML5 drag; the result says which kind the page used, so a drop that did not take is explainable instead of mysterious.',
    parameters: {
      ref: { type: 'number', description: 'Element to pick up, from the latest snapshot.' },
      text: { type: 'string', description: 'Visible label of the element to pick up.' },
      x: { type: 'number', description: 'Pick-up x in viewport pixels (with y).' },
      y: { type: 'number', description: 'Pick-up y in viewport pixels.' },
      toRef: { type: 'number', description: 'Element to drop onto.' },
      toText: { type: 'string', description: 'Visible label of the drop target.' },
      toX: { type: 'number', description: 'Drop x in viewport pixels (with toY).' },
      toY: { type: 'number', description: 'Drop y in viewport pixels.' },
      steps: { type: 'number', description: 'Intermediate moves (default 14). Raise it if a drag library ignores the gesture.' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 120000,
    async execute(args) {
      const conn = await connection();
      const coord = (ax, ay) =>
        Number.isFinite(Number(ax)) && Number.isFinite(Number(ay))
          ? { x: Number(ax), y: Number(ay), label: '(coordinates)', matchedBy: 'coords' }
          : null;

      const source = coord(args?.x, args?.y) ?? (await locate(conn, { ref: args?.ref, text: args?.text }));
      // Resolving the source may have renumbered refs, so read the target afterwards
      // only when it was given as a label; a target ref refers to the caller's snapshot.
      const target = coord(args?.toX, args?.toY) ?? (await locate(conn, { ref: args?.toRef, text: args?.toText }));

      const steps = Number.isFinite(Number(args?.steps)) ? Math.max(3, Math.min(60, Number(args.steps))) : 14;
      await dragProbe(conn);
      await dragBetween(conn, source, target, { steps });
      await sleep(450);
      const seen = await dragProbe(conn);
      const after = await snapshotAll(conn).catch(() => null);

      const describe = (p) => (p.matchedBy === 'coords' ? `(${p.x}, ${p.y})` : `${p.matchedBy}${p.label ? ` "${p.label}"` : ''}`);
      const head = `Dragged ${describe(source)} to ${describe(target)} in ${steps} steps.`;

      const lines = [head];
      if (!seen) {
        lines.push('The page did not report drag events, so the result is whatever the snapshot below shows.');
      } else if (seen.dragstart > 0 && seen.drop === 0) {
        lines.push(
          `The page started a native HTML5 drag (dragstart ${seen.dragstart}, dragenter ${seen.dragenter}) but no drop landed — the item is most likely back where it started. ` +
            'The drop target needs a dragover handler, or the gesture released outside it. Try more `steps`, or a target ref from a fresh browser_snapshot.',
        );
      } else if (seen.drop > 0) {
        lines.push(`Native HTML5 drag and drop, and the drop landed (drop ${seen.drop}, dragenter ${seen.dragenter}).`);
      } else {
        lines.push(
          `No native drag events (pointermove ${seen.pointermove}): the page drives this with pointer/mouse handlers, which the gesture satisfies. ` +
            'Whether the move took effect is what the snapshot below shows — read it rather than assuming.',
        );
      }

      if (!after) return { text: lines.join('\n') };
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${lines.join('\n')}\n${formatElements(after)}`, shot);
    },
  };

  const tabsTool = {
    name: 'browser_tabs',
    description:
      'Work with tabs. "list" shows every open tab and its id; "new" opens a tab (optionally at a url) and switches to it; "select" switches to an existing tab id; "close" closes one (the current tab when no id is given). Clicks that open target=_blank or OAuth popups are followed automatically — use this to go back to an earlier tab or to tidy up.',
    parameters: {
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'What to do (default list).' },
      id: { type: 'string', description: 'Tab id from action "list" — needed by select, optional for close.' },
      url: { type: 'string', description: 'action "new": URL to open (default about:blank).' },
      screenshot: { type: 'boolean', description: 'Attach a screenshot (default true for new/select/close, false for list).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const action = String(args?.action ?? 'list').toLowerCase();
      const id = args?.id ? String(args.id).trim() : '';

      if (action === 'list' || action === '') {
        const tabs = await host.listTabs();
        const lines = [`${tabs.length} tab(s) open (* = the tab these tools drive).`];
        if (tabs.length === 0) lines.push('No page target at all — browser_open creates one.');
        for (const tab of tabs) {
          lines.push(`${tab.active ? '*' : ' '} ${tab.id}  ${tab.title || '(untitled)'}`);
          lines.push(`    ${String(tab.url).slice(0, 160)}`);
        }
        if (tabs.length > 1) lines.push('Pass an id to action "select" to drive another one.');
        // Listing changes nothing on screen, so it stays image-free unless asked: the
        // whole point of this tool is to be cheap.
        const shot = args?.screenshot === true ? await screenshot(await connection()).catch(() => null) : null;
        return attachImage(ctx, lines.join('\n'), shot);
      }

      let head;
      if (action === 'new') {
        const url = args?.url ? String(args.url) : 'about:blank';
        const created = await host.newTab(url);
        head = `Opened tab ${created.id}${url === 'about:blank' ? '' : ` at ${url}`} and switched to it.`;
      } else if (action === 'select') {
        if (!id) throw new Error('action "select" needs an id — call browser_tabs with action "list" first.');
        await host.useTab(id);
        head = `Switched to tab ${id}.`;
      } else if (action === 'close') {
        const target = id || host.pageTargetId;
        if (!target) throw new Error('There is no tab to close — the private browser is not running. browser_open starts it.');
        const result = await host.closeTab(target);
        head = `Closed tab ${result.closed}. ${result.remaining} tab(s) left.`;
      } else {
        throw new Error(`action must be one of list / new / select / close (got "${args?.action}").`);
      }

      const conn = await connection();
      // A brand-new tab is often still on about:blank for a moment; waiting for
      // readyState keeps the snapshot below from describing the wrong document.
      await waitFor(conn, { timeoutMs: 12000 }).catch(() => {});
      const snap = await snapshotAll(conn).catch(() => null);
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      if (!snap) return { text: `${head} The page did not answer a snapshot yet — take browser_snapshot in a moment.` };
      return attachImage(ctx, `${head}\n${formatElements(snap)}`, shot);
    },
  };

  const dropFilesTool = {
    name: 'browser_drop_files',
    description:
      'Drag local files from disk into a drop zone on the page — the "drop files here" area that a plain file input cannot serve. Paths must be absolute. The zone has to be a real drop target: without a dragover handler calling preventDefault the browser refuses the drop, and the result says so. When a real <input type="file"> exists, browser_upload is more reliable.',
    parameters: {
      ref: { type: 'number', description: 'Drop target from the latest snapshot.' },
      text: { type: 'string', description: 'Visible label of the drop target.' },
      x: { type: 'number', description: 'Drop x in viewport pixels (with y).' },
      y: { type: 'number', description: 'Drop y in viewport pixels.' },
      files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Absolute paths of the files to drop, e.g. ["C:\\\\Users\\\\me\\\\Desktop\\\\a.png"].',
      },
      screenshot: { type: 'boolean', description: 'Attach a screenshot afterwards (default true).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      const conn = await connection();
      const files = Array.isArray(args?.files) ? args.files.map((file) => String(file).trim()).filter(Boolean) : [];
      if (files.length === 0) throw new Error('files must be a non-empty array of absolute paths.');
      const missing = files.filter((file) => !existsSync(file));
      if (missing.length > 0) throw new Error(`These files do not exist, so nothing was dropped:\n${missing.join('\n')}`);

      const point =
        Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))
          ? { x: Number(args.x), y: Number(args.y), label: '(coordinates)', matchedBy: 'coords' }
          : await locate(conn, { ref: args?.ref, text: args?.text });

      await dragProbe(conn);
      await dropFilesAt(conn, point, files);
      const seen = await dragProbe(conn);
      const after = await snapshotAll(conn).catch(() => null);

      const where =
        point.matchedBy === 'coords' ? `(${point.x}, ${point.y})` : `${point.matchedBy}${point.label ? ` "${point.label}"` : ''}`;
      const names = files.map((file) => file.split(/[\\/]/).pop()).join(', ');
      const lines = [`Dropped ${files.length} file(s) on ${where}: ${names}.`];
      if (!seen) {
        lines.push('The page did not report drag events, so the snapshot below is the only evidence of what happened.');
      } else if (seen.drop > 0) {
        lines.push(`The drop landed (drop ${seen.drop}, dragenter ${seen.dragenter}). What the page did with the files is what the snapshot below shows.`);
      } else {
        lines.push(
          `No drop event reached the page (dragenter ${seen.dragenter}, drop 0): the zone most likely never called preventDefault on dragover, ` +
            'so Chrome refused the drop. Try the element that actually carries the handler, or fall back to its <input type="file"> with browser_upload. ' +
            'A drop zone inside a frame would not be counted here either.',
        );
      }

      if (!after) return { text: lines.join('\n') };
      const shot = args?.screenshot === false ? null : await screenshot(conn).catch(() => null);
      return attachImage(ctx, `${lines.join('\n')}\n${formatElements(after)}`, shot);
    },
  };

  const screenshotTool = {
    name: 'browser_screenshot',
    description:
      'Capture one part of the page instead of the whole viewport: an element by ref/selector, or an x/y/width/height region. Far cheaper in image tokens, and sharp enough to read small print, a chart or a table cell. It scrolls the element into view first, so coordinates move — take a fresh browser_snapshot afterwards if you still need to click something.',
    parameters: {
      ref: { type: 'number', description: 'Element to capture, from the latest snapshot.' },
      text: { type: 'string', description: 'Visible label of the element to capture.' },
      selector: { type: 'string', description: 'CSS selector, for something that is not in the snapshot (a chart div, a table).' },
      x: { type: 'number', description: 'Region x in viewport pixels (with y).' },
      y: { type: 'number', description: 'Region y in viewport pixels.' },
      width: { type: 'number', description: 'Region width in pixels (default 400 with x/y).' },
      height: { type: 'number', description: 'Region height in pixels (default 300 with x/y).' },
      padding: { type: 'number', description: 'Pixels of surrounding context to include (default 8, max 120).' },
      scale: { type: 'number', description: 'Pixel density of the output, 0.25–3 (default 1; 2 helps with tiny text).' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      const conn = await connection();
      const pad = Math.max(0, Math.min(120, Number(args?.padding ?? 8)));
      const scale = Math.min(3, Math.max(0.25, Number(args?.scale) || 1));

      let box;
      let label;
      if (Number.isFinite(Number(args?.x)) && Number.isFinite(Number(args?.y))) {
        const viewport = await evaluate(
          conn,
          '({ width: innerWidth, height: innerHeight, x: Math.round(scrollX), y: Math.round(scrollY) })',
        ).catch(() => null);
        const width = Math.max(1, Number.isFinite(Number(args?.width)) ? Number(args.width) : 400);
        const height = Math.max(1, Number.isFinite(Number(args?.height)) ? Number(args.height) : 300);
        box = {
          x: Number(args.x),
          y: Number(args.y),
          width,
          height,
          viewport: viewport ?? { width: settings.width, height: settings.height, x: 0, y: 0 },
          scrolled: { before: { x: viewport?.x ?? 0, y: viewport?.y ?? 0 }, after: { x: viewport?.x ?? 0, y: viewport?.y ?? 0 } },
        };
        label = `region ${Math.round(width)}x${Math.round(height)} at (${Math.round(box.x)}, ${Math.round(box.y)})`;
      } else {
        let selector;
        if (typeof args?.selector === 'string' && args.selector.trim()) selector = args.selector.trim();
        else {
          // Going through locate keeps "which element did the label mean" in one place —
          // including the loud failure when several elements match.
          const point = await locate(conn, { ref: args?.ref, text: args?.text });
          selector = `[data-dsh-bg-ref="${point.ref}"]`;
        }
        try {
          box = await elementBox(conn, selector);
        } catch (error) {
          // Elements inside a cross-origin frame belong to another document, so the
          // page-side measurement cannot reach them. The frame path already knows the
          // viewport position, so only the scroll bridge is added here.
          const framed = await locateInFrames(conn, { selector }).catch(() => null);
          if (!framed) throw error;
          const scroll = await evaluate(conn, '({ x: Math.round(scrollX), y: Math.round(scrollY) })').catch(() => ({ x: 0, y: 0 }));
          box = {
            x: framed.left,
            y: framed.top,
            width: framed.width,
            height: framed.height,
            label: framed.label,
            frame: framed.frame,
            viewport: { width: settings.width, height: settings.height },
            scrolled: { before: scroll, after: scroll },
          };
        }
        const what = box.label ? `"${box.label}"` : selector;
        label =
          `${what} — ${Math.round(box.width)}x${Math.round(box.height)} at ` +
          `${Math.round(box.x)},${Math.round(box.y)}${box.frame ? ` (inside frame ${box.frame})` : ''}`;
      }

      const vw = box.viewport?.width ?? settings.width;
      const vh = box.viewport?.height ?? settings.height;
      // The clip is in document pixels (see screenshotRegion); elementBox reports
      // viewport pixels, so the current scroll is what bridges the two.
      const scroll = box.scrolled?.after ?? { x: 0, y: 0 };
      const wantX = box.x + scroll.x - pad;
      const wantY = box.y + scroll.y - pad;
      const wantW = box.width + pad * 2;
      const wantH = box.height + pad * 2;
      // Chrome paints grey for a clip outside the visible area instead of failing, and
      // a grey image reads as "the page is broken". Clamping to the viewport keeps it
      // honest, and the caller is told the rest was cut off.
      const x = Math.max(scroll.x, Math.round(wantX));
      const y = Math.max(scroll.y, Math.round(wantY));
      const width = Math.max(1, Math.min(scroll.x + vw, Math.round(wantX + wantW)) - x);
      const height = Math.max(1, Math.min(scroll.y + vh, Math.round(wantY + wantH)) - y);
      const clipped = width < Math.round(wantW) || height < Math.round(wantH);

      const buffer = await screenshotRegion(conn, { x, y, width, height, scale });
      const size = pngSize(buffer);
      const lines = [`Captured ${label}${pad ? ` with ${pad}px padding` : ''}.`];
      if (size) lines.push(`Image ${size.width}x${size.height} px${scale !== 1 ? ` (scale ${scale})` : ''}.`);
      if (clipped) {
        const fits = box.width <= vw + 0.5 && box.height <= vh + 0.5;
        lines.push(
          `Clamped to the ${vw}x${vh} viewport: ${Math.round(wantW)}x${Math.round(wantH)} was asked for, ` +
            `${Math.round(width)}x${Math.round(height)} was captured. ` +
            (fits
              ? 'The element itself is fully in the image — what was cut off is padding that fell outside the screen because it sits close to the edge.'
              : 'The element is larger than the screen — capture it in pieces, or read it with browser_text.'),
        );
      }
      const moved = box.scrolled && (box.scrolled.before.x !== box.scrolled.after.x || box.scrolled.before.y !== box.scrolled.after.y);
      if (moved) {
        lines.push(
          `The page scrolled from (${box.scrolled.before.x},${box.scrolled.before.y}) to ` +
            `(${box.scrolled.after.x},${box.scrolled.after.y}) to bring it into view, so element coordinates have shifted.`,
        );
      }
      return attachImage(ctx, lines.join('\n'), buffer, {
        fileName: 'crop.png',
        note: 'Cropped screenshot attached.',
      });
    },
  };

  // --- desktop plane -------------------------------------------------------
  // Native windows are driven through a separate helper (helpers/desktop-agent.py)
  // because Win32 has no DOM: windows, child controls and posted messages are the
  // only handle, and none of that needs the foreground.

  const ensureDesktop = async () => {
    if (!settings.desktop) throw new Error('the desktop plane is switched off by config (desktop: false)');
    await desk.ensure();
  };

  const desktopLabel = (window) =>
    window.desktop && window.desktop !== 'user' && window.desktop !== 'worker' ? ` on desktop "${window.desktop}"` : '';

  const formatWindow = (window) =>
    `${window.id}  ${window.title || '(no title)'} — ${window.process} (pid ${window.pid}) ` +
    `${window.rect.width}x${window.rect.height}${window.minimized ? ' (minimised)' : ''}${desktopLabel(window)}`;

  const formatControls = (window, controls) => {
    const lines = [
      `Window ${window.id} "${window.title || '(no title)'}" — ${window.class} (${window.process}, pid ${window.pid}) ` +
        `${window.rect.width}x${window.rect.height}${window.minimized ? ', minimised' : ''}${desktopLabel(window)}`,
    ];
    if (controls.length === 0) {
      lines.push(
        'This window has no visible child controls: it draws itself instead — Chromium, WPF and most modern apps do. ' +
          'Use desktop_shot to look at it, then desktop_act with x/y to click.',
      );
      return lines.join('\n');
    }
    lines.push(`${controls.length} control(s), outermost first:`);
    for (const control of controls) {
      const indent = '  '.repeat(Math.min(4, Number(control.depth) || 0) + 1);
      const kind = control.kind || control.class;
      const label = control.text ? ` "${control.text}"` : '';
      const id = control.controlId ? ` ctrl ${control.controlId}` : '';
      lines.push(
        `${indent}${control.id} ${kind}${label}${id} ${control.rect.width}x${control.rect.height}` +
          `${control.enabled ? '' : ' (disabled)'}`,
      );
    }
    return lines.join('\n');
  };

  const desktopWindows = {
    name: 'desktop_windows',
    description:
      'List native (non-browser) windows with their process, pid and size — your own desktop plus any isolated desktops this plugin started. This is the entry point for driving a desktop app: find the window here, read its controls with desktop_tree, then act on it. Nothing here needs a browser.',
    parameters: {
      process: { type: 'string', description: 'Only windows whose process name contains this text, e.g. "notepad".' },
      desktop: { type: 'string', description: 'Read one named isolated desktop instead of both lists.' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      await ensureDesktop();
      const filter = typeof args?.process === 'string' ? args.process.trim() : '';
      const only = typeof args?.desktop === 'string' ? args.desktop.trim() : '';
      const tracked = await desk.desktops().catch(() => []);
      const names = only ? [only] : ['user', ...tracked.map((item) => item.name)];

      const groups = [];
      for (const name of names) {
        try {
          const list = await desk.windows({ process: filter || undefined, desktop: name === 'user' ? undefined : name });
          groups.push({ name, windows: list.windows });
        } catch (error) {
          groups.push({ name, windows: [], error: error?.message ?? String(error) });
        }
      }

      const lines = [];
      const local = groups.find((group) => group.name === 'user');
      if (local) {
        if (local.error) lines.push(`Could not read your desktop: ${local.error}`);
        else if (local.windows.length === 0) lines.push('No windows on your desktop match.');
        else {
          lines.push(`${local.windows.length} window(s) on your desktop:`);
          for (const window of local.windows) lines.push(`  ${formatWindow(window)}`);
        }
      }
      const isolated = groups.filter((group) => group.name !== 'user');
      for (const group of isolated) {
        lines.push('');
        if (group.error) {
          lines.push(`Could not read isolated desktop "${group.name}": ${group.error}`);
          continue;
        }
        const where = only ? `desktop "${group.name}"` : `isolated desktop "${group.name}" (not on your screen)`;
        if (group.windows.length === 0) lines.push(`No windows on ${where}.`);
        else {
          lines.push(`${group.windows.length} window(s) on ${where}:`);
          for (const window of group.windows) lines.push(`  ${formatWindow(window)}`);
        }
      }
      if (lines.length === 0) lines.push('Nothing found.');
      lines.push('Next: desktop_tree with a window id to see its controls.');
      return { text: lines.join('\n') };
    },
  };

  const desktopTree = {
    name: 'desktop_tree',
    description:
      'Read the controls inside a native window: buttons, text fields, lists, labels, with their ids and sizes. Use the ids with desktop_act (click / type). A modern self-drawn window has no child controls — the answer says so instead of pretending it is empty.',
    parameters: {
      window: { type: 'string', required: true, description: 'Window id from desktop_windows, e.g. w004e0592.' },
      desktop: { type: 'string', description: 'The isolated desktop the window lives on, when desktop_windows said so.' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      await ensureDesktop();
      const windowId = String(args?.window ?? '').trim();
      if (!windowId) throw new Error('window is required — take an id from desktop_windows.');
      const desktop = typeof args?.desktop === 'string' && args.desktop.trim() ? args.desktop.trim() : undefined;
      const result = await desk.tree({ window: windowId, desktop });
      return { text: formatControls(result.window, Array.isArray(result.controls) ? result.controls : []) };
    },
  };

  const desktopAct = {
    name: 'desktop_act',
    description:
      'Act on a native window without touching your mouse, keyboard or focus. click / type / key / scroll / read / close. Give `target` (a control id from desktop_tree) whenever possible — that is exact; x/y are pixels inside the window\'s client area, i.e. the same pixels desktop_shot returns. `read` returns the text of a text control, which is how you confirm typing worked.',
    parameters: {
      action: {
        type: 'string',
        enum: ['click', 'type', 'key', 'scroll', 'read', 'close'],
        required: true,
        description: 'What to do.',
      },
      window: { type: 'string', description: 'Window id from desktop_windows (needed for click by x/y, key, scroll, close).' },
      target: { type: 'string', description: 'Control id from desktop_tree — preferred over x/y for clicks, required for type and read.' },
      x: { type: 'number', description: 'X in client-area pixels (with y), for a click without a target.' },
      y: { type: 'number', description: 'Y in client-area pixels.' },
      text: { type: 'string', description: 'action "type": the text to put into the target control.' },
      keys: { type: 'string', description: 'action "key": one chord, e.g. "Enter", "ctrl+a", "F5".' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button for click (default left).' },
      count: { type: 'number', description: 'Click count (default 1, use 2 to double-click).' },
      delta: { type: 'number', description: 'action "scroll": wheel delta, negative scrolls down (default -120).' },
      desktop: { type: 'string', description: 'The isolated desktop the window lives on.' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      await ensureDesktop();
      const action = String(args?.action ?? '').trim().toLowerCase();
      if (!['click', 'type', 'key', 'scroll', 'read', 'close'].includes(action)) {
        throw new Error(`action must be one of click / type / key / scroll / read / close (got "${args?.action}").`);
      }
      const desktop = typeof args?.desktop === 'string' && args.desktop.trim() ? args.desktop.trim() : undefined;
      const target = typeof args?.target === 'string' && args.target.trim() ? args.target.trim() : undefined;
      const windowId = typeof args?.window === 'string' && args.window.trim() ? args.window.trim() : undefined;

      // Fail here, in the model's terms, rather than letting the helper complain about
      // a missing window: which argument is missing is the useful half of the message.
      if ((action === 'type' || action === 'read') && !target) {
        throw new Error(`action "${action}" needs a target — a control id from desktop_tree.`);
      }
      if (action === 'click' && !target && !windowId) {
        throw new Error('action "click" needs either target (a control id) or window plus x/y.');
      }
      if ((action === 'key' || action === 'close') && !windowId && !target) {
        throw new Error(`action "${action}" needs a window (or a target control).`);
      }
      if (action === 'type' && args?.text === undefined) {
        throw new Error('action "type" needs text.');
      }
      if (action === 'key' && !args?.keys) {
        throw new Error('action "key" needs keys, e.g. "Enter" or "ctrl+a".');
      }

      if (action === 'read') {
        if (!target) throw new Error('action "read" needs a target (a text control id from desktop_tree).');
        const result = await desk.read({ target, desktop });
        const text = String(result?.text ?? '');
        return {
          text: text
            ? `${target} contains ${text.length} character(s):\n${text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text}`
            : `${target} is empty (0 characters).`,
        };
      }

      const payload = { action };
      if (target) payload.target = target;
      if (windowId) payload.window = windowId;
      if (Number.isFinite(Number(args?.x))) payload.x = Number(args.x);
      if (Number.isFinite(Number(args?.y))) payload.y = Number(args.y);
      if (args?.text !== undefined) payload.text = String(args.text);
      if (args?.keys !== undefined) payload.keys = String(args.keys);
      if (args?.button === 'right') payload.button = 'right';
      if (Number.isFinite(Number(args?.count))) payload.count = Math.max(1, Math.min(3, Number(args.count)));
      if (Number.isFinite(Number(args?.delta))) payload.delta = Number(args.delta);

      const result = await desk.act(payload, { desktop });
      if (action === 'click') {
        const where = target ? `control ${target}` : `(${result?.x ?? args?.x}, ${result?.y ?? args?.y})`;
        return {
          text:
            `Clicked ${where}${result?.count > 1 ? ` ${result.count} times` : ''} by posting the mouse messages — the cursor did not move and no focus was taken.\n` +
            'Apps that only react to real input ignore posted clicks; if nothing changed, confirm with desktop_shot before trying another target.',
        };
      }
      if (action === 'type') {
        return {
          text:
            `Typed ${result?.chars ?? 0} character(s) into ${target}${result?.via ? ` via ${result.via}` : ''}.\n` +
            'Verify with desktop_act action "read" on the same target — typing that silently went nowhere looks exactly like success.',
        };
      }
      if (action === 'key') return { text: `Pressed ${args?.keys} in ${target || windowId}.` };
      if (action === 'scroll') return { text: `Scrolled ${target || windowId} by ${result?.delta ?? args?.delta ?? -120}.` };
      return { text: `Asked ${target || windowId} to close (WM_CLOSE). It may ask a question first — check desktop_windows.` };
    },
  };

  const desktopShot = {
    name: 'desktop_shot',
    description:
      'Capture a native window as an image, without bringing it to the front and even when it is behind other windows. The image is the window\'s client area, so its pixels are exactly the x/y that desktop_act expects.',
    parameters: {
      window: { type: 'string', required: true, description: 'Window id from desktop_windows.' },
      desktop: { type: 'string', description: 'The isolated desktop the window lives on.' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      await ensureDesktop();
      const windowId = String(args?.window ?? '').trim();
      if (!windowId) throw new Error('window is required — take an id from desktop_windows.');
      const desktop = typeof args?.desktop === 'string' && args.desktop.trim() ? args.desktop.trim() : undefined;
      mkdirSync(shotDir, { recursive: true });
      const file = join(shotDir, `desktop-${windowId}-${Date.now()}.png`);
      const shot = await desk.shot({ window: windowId, path: file, desktop });
      const buffer = readFileSync(file);
      const notes = [`Captured ${windowId} at ${shot.width}x${shot.height} px (client area).`];
      if (!shot.painted) {
        notes.push(
          'The app refused to paint into the capture (PrintWindow returned false), so this image may be blank — ' +
            'some GPU-composited apps do that. Read it with desktop_tree instead.',
        );
      }
      if (!shot.clientOnly) notes.push('This window reports no client area, so the whole window (with its frame) was captured.');
      notes.push('Coordinates from this image are what desktop_act x/y expects.');
      return attachImage(ctx, notes.join('\n'), buffer, {
        fileName: 'desktop.png',
        note: 'Window screenshot attached.',
      });
    },
  };

  const desktopLaunch = {
    name: 'desktop_launch',
    description:
      'Start a native program, by default on an isolated desktop: it runs normally but its windows never appear on your screen and never take focus. Returns the window id once the window exists, so desktop_tree / desktop_shot work straight away. Use kill with a pid to stop something this started.',
    parameters: {
      path: { type: 'string', description: 'Absolute path of the executable, e.g. C:\\\\Windows\\\\System32\\\\notepad.exe.' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command-line arguments for the program.',
      },
      isolated: {
        type: 'boolean',
        description: 'Run it on its own invisible desktop (default true). Set false when the app refuses to start there — installers and some store apps do.',
      },
      name: { type: 'string', description: 'Name for the isolated desktop, so later calls can pass desktop: "…". Default auto.' },
      kill: { type: 'number', description: 'Instead of starting anything: end this pid (from desktop_windows).' },
    },
    output: toolOutput(),
    timeoutMs: 90000,
    async execute(args) {
      await ensureDesktop();
      if (Number.isFinite(Number(args?.kill)) && Number(args.kill) > 0) {
        const pid = Number(args.kill);
        const result = await desk.kill({ pid });
        return { text: `Ended pid ${result?.killed ?? pid}. Its windows are gone from desktop_windows.` };
      }

      const path = typeof args?.path === 'string' ? args.path.trim() : '';
      if (!path) throw new Error('path is required — the full path of the executable to start.');
      if (!existsSync(path)) throw new Error(`There is no file at ${path}.`);

      const isolated = args?.isolated !== false && settings.desktopIsolated;
      const launched = await desk.launch({
        path,
        args: Array.isArray(args?.args) ? args.args.map((item) => String(item)) : [],
        isolated,
        name: typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : undefined,
      });

      const window = await desk
        .waitForWindow({ pid: launched.pid, desktop: launched.desktop, timeoutMs: 15000 })
        .catch(() => null);

      const lines = [
        `Started ${path.split(/[\\/]/).pop()} (pid ${launched.pid})` +
          `${launched.isolated ? ` on its own desktop "${launched.desktop}" — it is not on your screen and cannot take focus` : ' on your desktop'}.`,
      ];
      if (window) {
        lines.push(`Its window is ${window.id} — "${window.title || '(no title)'}", ${window.rect.width}x${window.rect.height}.`);
        lines.push(`Read it with desktop_tree (window "${window.id}"${launched.isolated ? `, desktop "${launched.desktop}"` : ''}).`);
      } else {
        lines.push(
          'No window appeared within 15s. Some programs need longer, and some refuse to run on a desktop that is not yours — ' +
            `call desktop_launch again with isolated: false, or look for its window in desktop_windows.`,
        );
      }
      return { text: lines.join('\n') };
    },
  };

  /** Where DSH itself listens, if it was started by StartDSH.bat. */
  const dshDevtools = `http://127.0.0.1:${Number(process.env.DSH_DEBUG_PORT) || 9333}`;

  const attach = {
    name: 'browser_attach',
    description:
      'Drive an app that is already running — DSH itself, Chrome, VS Code, Slack — instead of the private browser. ' +
      'Use this when the thing you need to click is not a web page you can open, but the window in front of the user: ' +
      'an Electron app draws its whole UI itself, so desktop_tree has no controls to list, while DevTools sees every element. ' +
      "The address is that app's DevTools port (DSH: " + dshDevtools + ', started by StartDSH.bat, no token needed). ' +
      'Nothing is launched, resized or closed: browser_close only stops driving it.',
    parameters: {
      url: {
        type: 'string',
        description: `DevTools endpoint of the running app, e.g. ${dshDevtools}. Default: DSH's own port.`,
      },
      target: { type: 'string', description: "Only drive this tab id (from browser_tabs). Default: the app's first page." },
      focus: {
        type: 'boolean',
        description: 'Bring that window to the front while working (default false — it leaves your focus alone).',
      },
      detach: { type: 'boolean', description: 'Instead of attaching: stop driving that app and go back to the private browser.' },
    },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args) {
      if (args?.detach === true) {
        const result = await host.detach();
        return {
          text: result.detached
            ? `Let go of ${result.was}. It was not closed — only this session's socket was dropped.`
            : `${result.reason}. browser_open still uses the private browser.`,
        };
      }

      const url = typeof args?.url === 'string' && args.url.trim() ? args.url.trim() : settings.attachUrl || dshDevtools;
      const conn = await host.attach(url, {
        focus: args?.focus === true,
        target: typeof args?.target === 'string' && args.target.trim() ? args.target.trim() : null,
      });

      const page = await evaluate(conn, '({ url: location.href, title: document.title, width: innerWidth, height: innerHeight })');
      const tabs = await host.listTabs().catch(() => []);
      const snap = await snapshotAll(conn).catch((error) => ({ error: error?.message ?? String(error) }));
      const head = [
        `Attached to ${url} — now driving "${page?.title ?? ''}" (${page?.url ?? ''}), ${page?.width ?? '?'}x${page?.height ?? '?'} px.`,
        'Nothing was launched and nothing will be closed: browser_close only stops driving this app.',
        tabs.length > 1 ? `${tabs.length} pages are open there; browser_tabs lists them and browser_attach { target } picks another.` : '',
      ].filter(Boolean);

      if (snap?.error) return { text: `${head.join('\n')}\nCould not read the page yet: ${snap.error}` };
      return { text: `${head.join('\n')}\n\n${formatElements(snap)}` };
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
      if (host.foreign) {
        const result = await host.detach();
        return {
          text:
            `Stopped driving ${result.was ?? 'that app'}; nothing of its own was closed or changed. ` +
            'The next browser_* call starts the private browser again.',
        };
      }
      await host.shutdown();
      return { text: 'Private browser shut down. Its profile (cookies, logins) is kept on disk for the next run.' };
    },
  };

  return [
    doctor,
    open,
    snapTool,
    click,
    type,
    key,
    scroll,
    textTool,
    evalTool,
    waitTool,
    navTool,
    tabsTool,
    uploadTool,
    dropFilesTool,
    downloadTool,
    hoverTool,
    dragTool,
    screenshotTool,
    attach,
    desktopWindows,
    desktopTree,
    desktopAct,
    desktopShot,
    desktopLaunch,
    close,
  ];
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
    downloadDir: settings.downloadDir,
    timeoutMs: settings.timeoutMs,
    idleMs: settings.idleMs,
    dialogBehavior: settings.dialogBehavior,
    dialogPromptText: settings.dialogPromptText,
    attachUrl: settings.attachUrl,
  });

  // The browser is not started here — only the first browser_* call does that. Same
  // for the desktop helper: spawning python at plugin load would make every startup
  // pay for a feature the session may never use.
  const desk = new DesktopHost({
    pythonPath: settings.pythonPath,
    timeoutMs: Math.max(10000, settings.timeoutMs),
  });

  const tools = createTools(ctx, settings, host, desk);
  for (const tool of tools) {
    // Every browser call is activity: keep the browser warm while the agent is working,
    // and let the idle timer reclaim it once the run is over. Desktop tools are not
    // browser activity — they must not keep a Chromium process alive.
    const run = tool.execute.bind(tool);
    const isBrowserTool = tool.name.startsWith('browser_');
    const warmsBrowser = isBrowserTool && tool.name !== 'browser_close';
    tool.execute = async (...args) => {
      if (warmsBrowser) host.touch();
      try {
        const result = await run(...args);
        // Dialogs are answered the moment they open, but the model still has to know:
        // silently accepting a confirm() would look like the action was cancelled.
        // Downloads are the same story — a successful export looks like a no-op.
        // Tabs too: a click that opens a popup leaves the session on a page that did
        // not change, which is why the tab set is compared after every call.
        if (!isBrowserTool) return result;
        const notes = `${drainDialogs(host.connection)}${drainDownloads(host)}${await drainTabs(host, settings)}`;
        if (notes && result && typeof result.text === 'string') return { ...result, text: `${result.text}${notes}` };
        return result;
      } finally {
        if (warmsBrowser) host.touch();
      }
    };
    ctx.effect(() => ctx.tools.register(tool), `dsh-computer-use-bg: tool ${tool.name}`);
  }

  ctx.effect(
    () => () => {
      host.release();
      desk.stop().catch(() => {});
    },
    'dsh-computer-use-bg: release cdp session and desktop helper',
  );

  log(
    ctx,
    `dsh-computer-use-bg: ${tools.length} tools registered (port ${settings.port}, viewport ${settings.width}x${settings.height})`,
  );
}
