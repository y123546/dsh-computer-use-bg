/**
 * End-to-end smoke test for the CDP plane. Run with: node tests/smoke.mjs
 * Starts a private browser, loads a local page, clicks a button, types into an
 * input, reads the result back and writes a screenshot.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost } from '../lib/cdp.js';
import { clickAt, evaluate, insertText, navigate, pressKey, screenshot, snapshot } from '../lib/page.js';

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>dsh bg cu smoke</title>
<script>
  window.__log = [];
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (e) => window.__log.push(type + ':' + (e.target.id || e.target.tagName)), true);
  }
</script>
<h1>Smoke test</h1>
<button id="press" aria-label="Press me" onclick="document.getElementById('out').textContent='clicked'">Press me</button>
<p id="out">idle</p>
<input id="name" aria-label="Name field" placeholder="Name">
<button id="submit" aria-label="Submit name" onclick="document.getElementById('echo').textContent='hi '+document.getElementById('name').value">Submit name</button>
<p id="echo"></p>
`;

const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-cu-'));
const file = join(dir, 'smoke.html');
writeFileSync(file, HTML, 'utf8');
const url = pathToFileURL(file).href;

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const host = new BrowserHost({ port: 9472, headless: true, width: 1280, height: 800 });

try {
  console.log('1) start private browser');
  const started = Date.now();
  const conn = await host.page();
  ok('cdp session', `${Date.now() - started}ms`);

  console.log('2) navigate');
  const nav = await navigate(conn, url, { timeoutMs: 30000 });
  ok('navigate', `${nav.readyState} ${nav.url.slice(-24)}`);

  console.log('3) snapshot');
  const snap = await snapshot(conn);
  ok('snapshot', `${snap.elements.length} elements`);
  for (const el of snap.elements) console.log(`        #${el.ref} ${el.tag} "${el.name}" @${el.x},${el.y}`);
  if (snap.elements.length < 3) fail('element count', `expected >= 3, got ${snap.elements.length}`);

  console.log('4) click by text');
  const press = snap.elements.find((el) => el.name.includes('Press me'));
  if (!press) fail('find "Press me"');
  else {
    const hit = await evaluate(
      conn,
      `(() => { const el = document.elementFromPoint(${press.x}, ${press.y}); return el ? (el.id || el.tagName) : 'null'; })()`,
    );
    console.log(`        hit test @${press.x},${press.y} -> ${hit}`);
    await evaluate(conn, 'window.__log = []');
    await clickAt(conn, press.x, press.y);
    await new Promise((r) => setTimeout(r, 400));
    const out = await evaluate(conn, 'document.getElementById("out").textContent');
    const log = await evaluate(conn, 'window.__log.join(",")');
    console.log(`        events: ${log || '(none)'}`);
    if (out === 'clicked') ok('button onclick fired');
    else fail('button onclick', `#out = ${JSON.stringify(out)}`);
  }

  console.log('5) type into input then submit');
  const field = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Name field')));
  if (!field) fail('find name input');
  else {
    await clickAt(conn, field.x, field.y);
    await insertText(conn, '小伙');
    const typed = await evaluate(conn, 'document.getElementById("name").value');
    if (typed === '小伙') ok('unicode insert', JSON.stringify(typed));
    else fail('unicode insert', `value = ${JSON.stringify(typed)}`);

    const submit = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Submit name')));
    if (!submit) fail('find submit');
    else {
      await clickAt(conn, submit.x, submit.y);
      await new Promise((r) => setTimeout(r, 400));
      const echo = await evaluate(conn, 'document.getElementById("echo").textContent');
      if (echo === 'hi 小伙') ok('typed value reached the handler', JSON.stringify(echo));
      else fail('echo', JSON.stringify(echo));
    }
  }

  console.log('6) keyboard');
  await pressKey(conn, 'tab');
  ok('pressKey(tab) did not throw');

  console.log('7) screenshot');
  const buffer = await screenshot(conn);
  const shotPath = join(dir, 'smoke.png');
  writeFileSync(shotPath, buffer);
  ok('screenshot', `${buffer.length} bytes -> ${shotPath}`);

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  console.log(`artifacts: ${dir}`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await host.shutdown().catch(() => {});
}
