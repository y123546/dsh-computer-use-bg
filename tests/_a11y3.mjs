/** Does Accessibility.enable make Chromium publish its native (UIA) tree? */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost } from '../lib/cdp.js';
import { DesktopHost } from '../lib/desktop.js';

const PORT = 9467;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'dsh-a11y-'));
const pageFile = join(dir, 'page.html');
writeFileSync(pageFile, `<!doctype html><meta charset="utf-8"><title>a11y probe</title>
<button id="one">First button</button> <button id="two">Second button</button>
<input aria-label="A field">`, 'utf8');

// A real, visible window: UIA can only see what exists on screen.
const owner = new BrowserHost({ port: PORT, headless: false, width: 900, height: 640, profileDir: join(dir, 'p'), idleMs: 0 });
const reader = new BrowserHost({ attachUrl: `http://127.0.0.1:${PORT}` });
const desk = new DesktopHost({});
try {
  await owner.ensure();
  await owner.page();
  await owner.page().then((c) => c.send('Page.navigate', { url: pathToFileURL(pageFile).href }));
  await sleep(1800);

  await desk.ensure();
  const all = (await desk.windows({})).windows;
  const win = all.find((w) => /a11y probe/i.test(w.title));
  console.log('windows:', all.map((w) => `${w.process}/${String(w.title).slice(0, 14)}`).join(' | '));
  if (!win) throw new Error('no window titled "a11y probe"');

  const before = await desk.tree({ window: win.id });
  console.log('BEFORE engine:', before.engine, '| controls:', before.controls.length, '| note:', before.uiaNote);
  console.log('   names:', before.controls.map((c) => `${c.kind}/${(c.name || '').slice(0, 14)}`).join(' | '));

  const conn = await reader.ensure();
  await conn.send('Accessibility.enable', {}, { timeoutMs: 10000 });
  const ax = await conn.send('Accessibility.getFullAXTree', {}, { timeoutMs: 20000 }).catch(() => null);
  console.log('CDP AX nodes:', Array.isArray(ax?.nodes) ? ax.nodes.length : 'none');

  await sleep(1800);
  const after = await desk.tree({ window: win.id });
  console.log('AFTER  engine:', after.engine, '| controls:', after.controls.length, '| note:', after.uiaNote);
  console.log('   names:', after.controls.map((c) => `${c.kind}/${(c.name || '').slice(0, 14)}`).join(' | '));
} catch (error) {
  console.log('ERROR', error.message);
} finally {
  await reader.shutdown().catch(() => {});
  await desk.stop().catch(() => {});
  await owner.shutdown().catch(() => {});
}
