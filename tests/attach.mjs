/**
 * Attach mode: drive a Chromium this plugin did *not* start.
 *
 * That is the answer to "an Electron app draws its own UI, so the desktop plane sees
 * no controls" — DSH, VS Code and Slack all expose every element over DevTools if they
 * were started with a debugging port.
 *
 * The assertions that matter are about not breaking somebody else's app:
 *  - the viewport is *not* emulated, so the window keeps its real size;
 *  - `shutdown()` closes our socket and nothing else — the browser must survive;
 *  - no tab is created just by attaching.
 *
 * Run with: node tests/attach.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost, resolveBrowser } from '../lib/cdp.js';
import { clickAt, evaluate, snapshot } from '../lib/page.js';

const PORT = 9455;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>foreign app</title>
<style>body { font: 16px sans-serif; padding: 24px; }</style>
<button id="toggle" onclick="this.textContent = 'pressed'; document.title = 'foreign pressed'">Press me</button>
<input id="field" aria-label="Field">
<div id="size"></div>
<script>
  document.getElementById('size').textContent = innerWidth + 'x' + innerHeight;
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'dsh-attach-'));
const pageFile = join(dir, 'page.html');
writeFileSync(pageFile, PAGE, 'utf8');
const pageUrl = pathToFileURL(pageFile).href;

const exe = resolveBrowser();
const profile = join(dir, 'profile');
const child = spawn(
  exe,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=900,640',
    pageUrl,
  ],
  { stdio: 'ignore', windowsHide: true },
);
child.unref();

const host = new BrowserHost({ attachUrl: `http://127.0.0.1:${PORT}`, width: 1440, height: 900 });
let conn = null;

try {
  console.log('1) a browser this plugin did not start is already running');
  let version = null;
  for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  if (version?.Browser) ok('foreign browser is up', `${version.Browser.split('/')[0]} on ${PORT}`);
  else fail('foreign browser', 'nothing answered /json/version');

  const tabsBefore = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const pagesBefore = tabsBefore.filter((t) => t.type === 'page').length;

  console.log('2) attaching does not open a tab and does not resize the window');
  conn = await host.ensure();
  if (host.foreign) ok('session is in attach mode', host.attachUrl);
  else fail('attach mode flag', String(host.foreign));

  const pagesAfter = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page').length;
  if (pagesAfter === pagesBefore) ok('no tab was created', `${pagesAfter} page(s)`);
  else fail('tab count changed', `${pagesBefore} -> ${pagesAfter}`);

  // The page records its own size on load. If this session had emulated a viewport,
  // innerWidth would now differ from what the page measured (and would equal the
  // 1440x900 this host was configured with — the whole point of the check).
  const view = await evaluate(conn, '({ w: innerWidth, h: innerHeight, atLoad: document.getElementById("size").textContent, title: document.title })');
  if (`${view.w}x${view.h}` === view.atLoad && view.w !== 1440) {
    ok('viewport is the window\'s own, untouched by this session', `${view.w}x${view.h} (host was configured 1440x900)`);
  } else {
    fail('viewport was emulated', `${JSON.stringify(view)} (host was configured 1440x900)`);
  }

  console.log('3) the page is driven normally, by ref');
  const snap = await snapshot(conn);
  const button = snap.elements.find((el) => el.name.includes('Press me'));
  if (button) ok('elements are readable', `${snap.elements.length} found, "${button.name}"`);
  else fail('snapshot', JSON.stringify(snap.elements.map((e) => e.name)));

  if (button) {
    await clickAt(conn, button.x, button.y);
    await sleep(250);
    const state = await evaluate(conn, '({ text: document.getElementById("toggle").textContent, title: document.title })');
    if (state.text === 'pressed' && state.title === 'foreign pressed') ok('the click landed', 'button says "pressed"');
    else fail('click', JSON.stringify(state));
  }

  console.log("4) accessibility can be switched on over this session");
  // This is the switch that turns an opaque Electron window into something UI
  // Automation can read, so it has to be reachable through the same session.
  const enabled = await conn.send('Accessibility.enable', {}, { timeoutMs: 10000 }).then(() => true).catch(() => false);
  if (enabled) ok('Accessibility.enable accepted');
  else fail('Accessibility.enable', 'the app refused it');

  const ax = await conn.send('Accessibility.getFullAXTree', {}, { timeoutMs: 20000 }).catch(() => null);
  const names = Array.isArray(ax?.nodes) ? ax.nodes.map((node) => node?.name?.value || '').filter(Boolean) : [];
  // The button was clicked in step 3, so its name is "pressed" by now — match either.
  const flat = names.join(' | ');
  if (Array.isArray(ax?.nodes) && /pressed|Press me/.test(flat) && /Field/.test(flat)) {
    ok('the tree has the page content in it', `${ax.nodes.length} nodes, button and field both named`);
  } else {
    fail('accessibility tree', `${ax?.nodes?.length ?? 'no'} nodes, names: ${flat.slice(0, 120)}`);
  }

  console.log("5) letting go does not close somebody else's browser");
  await host.shutdown();
  await sleep(400);
  const alive = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok).catch(() => false);
  if (alive) ok('it is still running after shutdown()', 'socket released, process untouched');
  else fail('shutdown killed the app', `${PORT} stopped answering`);

  const stillThere = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`], { encoding: 'utf8' }).stdout ?? '';
  if (stillThere.includes(String(child.pid))) ok('its process is still alive', `pid ${child.pid}`);
  else fail('process gone', `pid ${child.pid}`);

  console.log('6) detach goes back to owning a private browser');
  const detached = await host.detach();
  if (detached.detached && host.foreign === false) ok('detached', `was ${detached.was}`);
  else fail('detach', JSON.stringify(detached));
} catch (error) {
  failures += 1;
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 4).join('\n'));
} finally {
  await host.shutdown().catch(() => {});
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  await sleep(300);
  const leftover = spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { encoding: 'utf8' });
  void leftover;
  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  console.log(`artifacts: ${dir}`);
  if (failures > 0) process.exitCode = 1;
}
