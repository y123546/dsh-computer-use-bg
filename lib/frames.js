/**
 * Frames the page-side walk cannot reach.
 *
 * `walkDocs` in page.js sees a frame only when `iframe.contentDocument` is readable,
 * which same-origin policy allows for same-origin children. Everything else — payment
 * widgets, embedded editors, video players, comment boxes — was reported as "N frames
 * cannot be read" and left at that, so a login form inside one was unreachable even
 * though a click at the right pixel went through.
 *
 * Two different mechanisms are needed, because Chrome splits frames across two worlds:
 *
 *  - **Different origin, same site** (another port, another subdomain): the frame runs
 *    in the page's own renderer process and is listed in `Page.getFrameTree`. A world
 *    created with `Page.createIsolatedWorld` can read and query it.
 *  - **Different site** (an actual third party): site isolation moves the frame into
 *    its own process. It is *absent* from `Page.getFrameTree` entirely — the only sign
 *    of it is a `Target.attachedToTarget` event, and commands for it must carry that
 *    `sessionId`. Its own `Page.getFrameTree` describes its children.
 *
 * Geometry comes from `DOM.getBoxModel` on the frame's owner element, which reports the
 * content box **already flattened into the top-level viewport** and already corrected
 * for scrolling (verified: after scrolling 120px the box followed exactly). That is why
 * an element measured inside a frame only needs the frame's origin added — no ancestor
 * chain to walk, no scroll bookkeeping.
 */

import { evaluate, pageText, setFileInput, snapshot, snapshotDocument, waitFor } from './page.js';

const WORLD = '__dsh_bg';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enable auto-attach once per page session and remember which frame got which session.
 *
 * `setAutoAttach` also reports child targets that already exist, so enabling it lazily
 * (on the first snapshot that finds a blocked frame) still finds frames that loaded
 * seconds ago — verified, not assumed.
 */
export async function iframeSessions(connection) {
  if (connection.iframeSessions) return connection.iframeSessions;
  const sessions = new Map();
  connection.iframeSessions = sessions;
  connection.on('Target.attachedToTarget', (params) => {
    if (params?.targetInfo?.type !== 'iframe' || !params.sessionId) return;
    sessions.set(String(params.targetInfo.targetId), String(params.sessionId));
  });
  connection.on('Target.detachedFromTarget', (params) => {
    const gone = String(params?.sessionId ?? '');
    if (!gone) return;
    for (const [frameId, sessionId] of [...sessions]) {
      if (sessionId === gone) sessions.delete(frameId);
    }
  });
  await connection
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, { timeoutMs: 8000 })
    .catch(() => {});
  return sessions;
}

/**
 * Every frame of the page, flattened, with `reachable` telling whether the page-side
 * walk already covers it (same origin all the way up, and in this process).
 */
export async function collectFrames(connection) {
  const sessions = await iframeSessions(connection);
  const tree = await connection.send('Page.getFrameTree', {}, { timeoutMs: 10000 }).catch(() => null);
  const root = tree?.frameTree;
  if (!root?.frame) return { top: null, frames: [] };

  const topOrigin = String(root.frame.securityOrigin ?? '');
  const frames = [];
  const walk = (node, parentId, path, sessionId, reachable) => {
    const frame = node.frame ?? {};
    const id = String(frame.id ?? '');
    const origin = String(frame.securityOrigin ?? '');
    const mine = reachable && sessionId === null && origin === topOrigin;
    frames.push({
      frameId: id,
      parentId,
      path,
      url: String(frame.url ?? ''),
      origin,
      sessionId,
      reachable: mine,
    });
    (node.childFrames ?? []).forEach((child, index) =>
      walk(child, id, path ? `${path}.${index}` : String(index), sessionId, mine),
    );
  };
  walk(root, null, '', null, true);

  // Cross-site frames are not in that tree at all: each one arrives on its own session
  // and describes its own children.
  let extra = 0;
  for (const [frameId, sessionId] of sessions) {
    if (frames.some((frame) => frame.frameId === frameId)) continue;
    const label = `x${extra}`;
    extra += 1;
    const sub = await connection.send('Page.getFrameTree', {}, { timeoutMs: 8000, sessionId }).catch(() => null);
    const subRoot = sub?.frameTree;
    if (!subRoot?.frame) {
      frames.push({ frameId, parentId: null, path: label, url: '', origin: '', sessionId, reachable: false });
      continue;
    }
    const id = String(subRoot.frame.id ?? frameId);
    frames.push({
      frameId: id,
      parentId: null,
      path: label,
      url: String(subRoot.frame.url ?? ''),
      origin: String(subRoot.frame.securityOrigin ?? ''),
      sessionId,
      reachable: false,
    });
    (subRoot.childFrames ?? []).forEach((child, index) =>
      walk(child, id, `${label}.${index}`, sessionId, false),
    );
  }

  return { top: { frameId: String(root.frame.id), origin: topOrigin }, frames };
}

/** Frames the page-side walk does not cover. */
export async function crossFrames(connection) {
  const { top, frames } = await collectFrames(connection).catch(() => ({ top: null, frames: [] }));
  return { top, frames, cross: frames.filter((frame) => !frame.reachable) };
}

/**
 * A scriptable handle for one frame.
 *
 * An isolated world is a separate JS context that shares the DOM: page globals stay
 * untouched (so reading a frame cannot break the app in it), and the browser reuses the
 * world by name, so asking again per snapshot costs one round-trip and leaks nothing.
 */
export async function frameContext(connection, frame) {
  const sessionId = frame.sessionId ?? null;
  const world = await connection
    .send(
      'Page.createIsolatedWorld',
      { frameId: frame.frameId, worldName: WORLD, grantUniveralAccess: true },
      { timeoutMs: 10000, sessionId },
    )
    .catch(() => null);
  if (!world?.executionContextId) return null;
  return { contextId: world.executionContextId, sessionId };
}

/**
 * The frame's content box in top-level viewport pixels.
 *
 * Read from the owner element, so it exists even for a cross-site frame that this
 * session cannot otherwise see. Borders are excluded (`content` quad), which is exactly
 * where the frame's own `getBoundingClientRect` origin sits.
 */
export async function frameBox(connection, frameId) {
  const owner = await connection.send('DOM.getFrameOwner', { frameId }, { timeoutMs: 8000 }).catch(() => null);
  const backendNodeId = owner?.backendNodeId;
  if (!backendNodeId) return null;
  const box = await connection.send('DOM.getBoxModel', { backendNodeId }, { timeoutMs: 8000 }).catch(() => null);
  const quad = box?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) return null;
  return { x: quad[0], y: quad[1], width: box.model.width, height: box.model.height };
}

/**
 * The full snapshot: main document, same-origin frames (page-side walk), then every
 * frame the walk could not reach, each read in its own world.
 *
 * Gated on the page-side walk reporting a blocked frame, so a page without third-party
 * frames pays nothing at all for this.
 */
export async function snapshotAll(connection, { maxElements = 220 } = {}) {
  const base = await snapshot(connection);
  const blocked = Array.isArray(base.frames?.blocked) ? base.frames.blocked : [];
  base.frames = { scanned: base.frames?.scanned ?? 0, blocked, cross: [], unread: [] };
  if (blocked.length === 0) return base;

  const { cross } = await crossFrames(connection);
  if (cross.length === 0) return base;

  const elements = base.elements.slice();
  let hidden = 0;
  for (const frame of cross) {
    if (elements.length >= maxElements) break;
    const ctx = await frameContext(connection, frame);
    if (!ctx) {
      base.frames.unread.push({ path: frame.path, url: frame.url, reason: 'the browser gave no scriptable context for it' });
      continue;
    }
    const box = await frameBox(connection, frame.frameId);
    try {
      const part = await snapshotDocument(connection, ctx, {
        max: maxElements - elements.length,
        dx: box?.x ?? 0,
        dy: box?.y ?? 0,
        path: frame.path,
        startRef: elements.length + 1,
        clip: box,
      });
      elements.push(...part.elements);
      hidden += part.hidden ?? 0;
      base.frames.cross.push({
        path: frame.path,
        url: frame.url || part.url || '',
        process: Boolean(frame.sessionId),
        count: part.elements.length,
        hidden: part.hidden ?? 0,
      });
    } catch (error) {
      base.frames.unread.push({ path: frame.path, url: frame.url, reason: String(error?.message ?? error) });
    }
  }
  base.elements = elements;
  base.hiddenInFrames = hidden;
  return base;
}

/** Page text that includes the frames the page-side walk cannot reach. */
export async function readText(connection, limit = 6000) {
  const base = await pageText(connection, limit, { noteBlocked: false });
  const { cross } = await crossFrames(connection);
  if (cross.length === 0) return base;

  const parts = base ? [base] : [];
  for (const frame of cross) {
    const ctx = await frameContext(connection, frame);
    if (!ctx) {
      parts.push(`[frame ${frame.path}${frame.url ? ` ${frame.url}` : ''}: not readable]`);
      continue;
    }
    const raw = await evaluate(
      connection,
      `(() => { const main = document.querySelector('main,article,[role="main"]') || document.body; return main ? (main.innerText || '') : ''; })()`,
      { timeoutMs: 12000, ...ctx },
    ).catch(() => '');
    const body = String(raw ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (body) parts.push(`[frame ${frame.path}${frame.sessionId ? ', own process' : ''}]\n${body}`);
  }
  const joined = parts.filter(Boolean).join('\n\n');
  return joined.length > limit ? `${joined.slice(0, limit)}\n…[truncated ${joined.length - limit} chars]` : joined;
}

/**
 * Find a ref (or a CSS selector) inside the unreachable frames.
 *
 * Refs are global numbers, so the caller only has to say which one; the search walks
 * the frames until one has it.
 */
export async function locateInFrames(connection, { ref, selector } = {}) {
  const wanted = Number.isFinite(Number(ref)) && Number(ref) > 0 ? `[data-dsh-bg-ref="${Number(ref)}"]` : String(selector ?? '').trim();
  if (!wanted) return null;
  const { cross } = await crossFrames(connection);
  if (cross.length === 0) return null;

  for (const frame of cross) {
    const ctx = await frameContext(connection, frame);
    if (!ctx) continue;
    const hit = await evaluate(
      connection,
      `(() => {
        let el = null;
        try { el = document.querySelector(${JSON.stringify(wanted)}); } catch (error) { return { invalid: String((error && error.message) || error) }; }
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          label: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
        };
      })()`,
      { timeoutMs: 10000, ...ctx },
    ).catch(() => null);
    if (!hit) continue;
    if (hit.invalid) throw new Error(`"${wanted}" is not a valid selector: ${hit.invalid}`);
    const box = await frameBox(connection, frame.frameId);
    const dx = box?.x ?? 0;
    const dy = box?.y ?? 0;
    return {
      // Centre first: that is what a click needs.
      x: Math.round(hit.x + dx),
      y: Math.round(hit.y + dy),
      // Top-left as well, for callers that crop (a screenshot clip is a rectangle).
      left: Math.round(hit.x - hit.width / 2 + dx),
      top: Math.round(hit.y - hit.height / 2 + dy),
      width: hit.width,
      height: hit.height,
      label: hit.label,
      frame: frame.path,
      process: Boolean(frame.sessionId),
      ref: Number.isFinite(Number(ref)) ? Number(ref) : undefined,
    };
  }
  return null;
}

/** True/false for one wait condition inside one frame; null when it cannot tell. */
async function probeCondition(connection, ctx, spec) {
  const expression = `(() => {
    const selector = ${JSON.stringify(spec.selector ?? null)};
    const text = ${JSON.stringify(spec.text ?? null)};
    const gone = ${JSON.stringify(spec.gone ?? null)};
    try {
      if (selector !== null) return !!document.querySelector(selector);
      if (gone !== null) return !document.querySelector(gone);
      if (text !== null) { const body = document.body; return !!body && (body.innerText || '').includes(text); }
      return document.readyState !== 'loading';
    } catch (error) { return null; }
  })()`;
  return evaluate(connection, expression, { timeoutMs: 8000, ...ctx });
}

/**
 * Wait for a condition in the page *or* in any unreachable frame.
 *
 * The page-side wait stays the fast path: it polls inside the renderer in one call and
 * survives navigations. Cross-origin frames cannot be polled from there, so they get a
 * slower Node-side loop running alongside it — as soon as either side matches, the call
 * returns. On the miss path both budgets expire together, so a timeout still costs one
 * budget and not two.
 */
export async function waitAcrossFrames(connection, spec) {
  const started = Date.now();
  const page = waitFor(connection, spec);
  const { cross } = await crossFrames(connection).catch(() => ({ cross: [] }));
  if (cross.length === 0) return page;

  const budget = Math.max(200, Math.min(120000, Number(spec.timeoutMs) || 15000));
  const deadline = started + budget;
  const contexts = [];
  for (const frame of cross) {
    const ctx = await frameContext(connection, frame).catch(() => null);
    if (ctx) contexts.push({ frame, ctx });
  }
  if (contexts.length === 0) return page;

  const stop = { done: false };
  let matched = null;
  const scanner = (async () => {
    while (!stop.done && Date.now() < deadline) {
      for (const item of contexts) {
        const hit = await probeCondition(connection, item.ctx, spec).catch(() => null);
        if (hit === true) {
          matched = { frame: item.frame, at: Date.now() - started };
          return matched;
        }
      }
      if (stop.done) return null;
      await sleep(400);
    }
    return null;
  })();

  // Whichever side answers first wins. The page-side wait runs *inside* the renderer, so
  // it costs nothing to leave it running; without this race a frame match would still
  // take the whole budget, because the page-side call only returns on its own timeout.
  const pageWait = page.then((result) => ({ page: result }));
  const race = await Promise.race([pageWait, scanner.then((hit) => ({ hit }))]);

  const framed = async (hit) => {
    const state = await evaluate(connection, '({ url: location.href, readyState: document.readyState })').catch(() => null);
    return {
      ok: true,
      elapsed: hit.at,
      url: state?.url ?? '',
      readyState: state?.readyState ?? '',
      frame: hit.frame.path,
      inFrame: true,
    };
  };

  if (race.hit) {
    stop.done = true;
    return framed(race.hit);
  }

  const pageResult = race.page;
  stop.done = true;
  if (pageResult?.ok || pageResult?.fatal) return pageResult;

  // The page side gave up (timed out). The frame scan has the same deadline, so its
  // answer — if any — is already in hand or a moment away.
  const late = matched ?? (await scanner.catch(() => null));
  if (late) return framed(late);
  return pageResult;
}

/** Attach files to a file input living in an unreachable frame. */
export async function uploadInFrames(connection, { selector, files }) {
  const wanted = String(selector ?? '').trim();
  if (!wanted) return null;
  const { cross } = await crossFrames(connection);
  for (const frame of cross) {
    const ctx = await frameContext(connection, frame);
    if (!ctx) continue;
    const present = await evaluate(
      connection,
      `(() => { try { return !!document.querySelector(${JSON.stringify(wanted)}); } catch (error) { return false; } })()`,
      { timeoutMs: 8000, ...ctx },
    ).catch(() => false);
    if (!present) continue;
    const result = await setFileInput(connection, { selector: wanted, files, ctx });
    return { ...result, frame: frame.path };
  }
  return null;
}
