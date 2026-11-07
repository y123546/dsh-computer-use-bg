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
import {
  clickAt,
  evaluate,
  goHistory,
  insertText,
  navigate,
  pressKey,
  reload,
  screenshot,
  setFileInput,
  snapshot,
  waitFor,
} from '../lib/page.js';

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
<button id="alert" aria-label="Show alert" onclick="alert('hello from smoke')">Show alert</button>
<button id="confirm" aria-label="Ask confirm" onclick="window.__confirmed = confirm('sure?')">Ask confirm</button>
<input id="file" type="file" style="display:none" aria-label="Hidden file input">
<div id="late"></div>
<script>
  setTimeout(() => {
    const ready = document.createElement('div');
    ready.id = 'late-ready';
    ready.textContent = 'ready';
    document.getElementById('late').appendChild(ready);
  }, 1200);
</script>
`;

const SECOND_HTML = `<!doctype html>
<meta charset="utf-8">
<title>dsh bg cu smoke 2</title>
<h1>Second page</h1>
`;

const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-cu-'));
const file = join(dir, 'smoke.html');
writeFileSync(file, HTML, 'utf8');
const url = pathToFileURL(file).href;

const secondFile = join(dir, 'second.html');
writeFileSync(secondFile, SECOND_HTML, 'utf8');
const secondUrl = pathToFileURL(secondFile).href;

const uploadFile = join(dir, 'upload-me.txt');
writeFileSync(uploadFile, 'uploaded by the smoke test\n', 'utf8');

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

  console.log('8) wait for an element that appears late');
  // The page's own 1200ms timer already fired during the steps above, so schedule a
  // fresh one and wait for it immediately: elapsed must then be ~1200ms, which is what
  // proves the wait actually waited instead of finding the element already there.
  await evaluate(
    conn,
    `(() => {
       const late = document.createElement('div');
       late.id = 'brand-new';
       setTimeout(() => document.body.appendChild(late), 1200);
       return true;
     })()`,
  );
  const arrived = await waitFor(conn, { selector: '#brand-new', timeoutMs: 6000 });
  if (arrived.ok && arrived.elapsed >= 900) ok('wait satisfied', `${arrived.elapsed}ms`);
  else fail('wait for #brand-new', JSON.stringify(arrived));

  const missed = await waitFor(conn, { selector: '#never-appears', timeoutMs: 600 });
  if (missed.ok === false && missed.timedOut === true) ok('wait reports a timeout instead of throwing');
  else fail('wait timeout', JSON.stringify(missed));

  const bad = await waitFor(conn, { selector: ':::not a selector', timeoutMs: 5000 });
  if (bad.ok === false && bad.fatal) ok('invalid selector fails fast', bad.fatal.slice(0, 40));
  else fail('invalid selector', JSON.stringify(bad));

  console.log('9) javascript dialogs are answered, not left hanging');
  const t0 = Date.now();
  await evaluate(conn, "alert('hello from smoke')", { timeoutMs: 10000 });
  const alertRecord = Array.isArray(conn.dialogs) ? conn.dialogs.find((d) => d.message === 'hello from smoke') : null;
  if (alertRecord?.accepted === true) ok('alert auto-accepted', `${Date.now() - t0}ms`);
  else fail('alert auto-accept', JSON.stringify(conn.dialogs));

  const confirmed = await evaluate(conn, "confirm('sure?')", { timeoutMs: 10000 });
  if (confirmed === true) ok('confirm() returned true');
  else fail('confirm()', JSON.stringify(confirmed));

  console.log('10) file upload into a hidden input');
  try {
    await setFileInput(conn, { selector: '#file', files: [uploadFile] });
    const files = await evaluate(
      conn,
      `(() => { const el = document.getElementById('file'); return el && el.files ? Array.from(el.files).map((f) => f.name + ':' + f.size) : null; })()`,
    );
    if (Array.isArray(files) && files.length === 1 && files[0].startsWith('upload-me.txt')) ok('file attached', files.join(', '));
    else fail('file attached', JSON.stringify(files));
  } catch (error) {
    fail('file attached', error.message);
  }

  console.log('11) reload replaces the document');
  const originBefore = await evaluate(conn, 'performance.timeOrigin');
  const reloaded = await reload(conn, { timeoutMs: 20000 });
  const originAfter = await evaluate(conn, 'performance.timeOrigin');
  if (reloaded.loaded && originAfter !== originBefore) ok('reload', `${reloaded.readyState}, new document`);
  else fail('reload', `${JSON.stringify(reloaded)} origin ${originBefore} -> ${originAfter}`);

  console.log('12) back / forward');
  await navigate(conn, secondUrl, { timeoutMs: 20000 });
  const back = await goHistory(conn, -1);
  if (back.url === url) ok('back', back.url.slice(-24));
  else fail('back', `${back.url} !== ${url}`);
  const forward = await goHistory(conn, 1);
  if (forward.url === secondUrl) ok('forward', forward.url.slice(-24));
  else fail('forward', `${forward.url} !== ${secondUrl}`);

  const nothingLeft = await goHistory(conn, 1).then(() => null).catch((error) => error.message);
  if (nothingLeft) ok('forward at the end is a clear error', nothingLeft.slice(0, 60));
  else fail('forward past the end should have thrown');

  await navigate(conn, url, { timeoutMs: 20000 });

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
