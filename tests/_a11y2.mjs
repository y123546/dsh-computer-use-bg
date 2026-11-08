/**
 * Does forcing Chromium's accessibility over CDP make its *native* (UIA) tree appear?
 * That is the difference between "only CDP can read it" and "any UIA tool can".
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost, resolveBrowser } from '../lib/cdp.js';
import { DesktopHost } from '../lib/desktop.js';

const PORT = 9466;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'dsh-a11y-'));
const pageFile = join(dir, 'page.html');
writeFileSync(
  pageFile,
  `<!doctype html><meta charset="utf-8"><title>a11y probe</title>
   <button id="one">First button</button> <button id="two">Second button</button>
   <input aria-label="A field">`,
  'utf8',
);

const child = spawn(
  resolveBrowser(),
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${join(dir, 'p')}`, '--no-first-run',
   '--window-size=900,650', '--window-position=-2000,-2000', pathToFileURL(pageFile).href],
  { stdio: 'ignore', windowsHide: true },
);
child.unref();

const desk = new DesktopHost({});
const browser = new BrowserHost({ attachUrl: `http://127.0.0.1:${PORT}` });
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    await sleep(250);
    up = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok).catch(() => false);
  }
  console.log('edge up:', up);
  await desk.ensure();
  await sleep(1500);
  const all = (await desk.windows({})).windows;
  const win = all.find((w) => /a11y probe/i.test(w.title));
  console.log('windows:', all.map((w) => `${w.process}/${String(w.title).slice(0, 18)}`).join(' | '));
  console.log('window:', win ? `${win.id} "${win.title}" ${win.rect.width}x${win.rect.height}` : 'not found');
  if (!win) throw new Error('no native window');

  const before = await desk.tree({ window: win.id });
  console.log('BEFORE  engine:', before.engine, '| controls:', before.controls.length, '| note:', before.uiaNote);
  console.log('        names:', before.controls.map((c) => `${c.kind}/${(c.name || '').slice(0, 16)}`).join(' | '));

  const conn = await browser.ensure();
  await conn.send('Accessibility.enable', {}, { timeoutMs: 10000 });
  const ax = await conn.send('Accessibility.getFullAXTree', {}, { timeoutMs: 20000 });
  console.log('CDP AX nodes:', Array.isArray(ax?.nodes) ? ax.nodes.length : 'none');

  await sleep(1500);
  const after = await desk.tree({ window: win.id });
  console.log('AFTER   engine:', after.engine, '| controls:', after.controls.length, '| note:', after.uiaNote);
  console.log('        names:', after.controls.map((c) => `${c.kind}/${(c.name || '').slice(0, 16)}`).join(' | '));
} catch (error) {
  console.log('ERROR', error.message);
} finally {
  await browser.shutdown().catch(() => {});
  await desk.stop().catch(() => {});
  try { child.kill(); } catch { /* gone */ }
}
