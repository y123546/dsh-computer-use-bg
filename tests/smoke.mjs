/**
 * End-to-end smoke test for the CDP plane. Run with: node tests/smoke.mjs
 * Starts a private browser, loads a local page, clicks a button, types into an
 * input, reads the result back and writes a screenshot.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost } from '../lib/cdp.js';
import { readText, snapshotAll, uploadInFrames, waitAcrossFrames } from '../lib/frames.js';
import { ATTR_BODY, HEADER_BODY, SLOW_BYTES, startDownloadSite } from './download-fixture.mjs';
import { startIframeSites } from './iframe-fixture.mjs';
import {
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
  pageText,
  pressKey,
  reload,
  screenshot,
  screenshotRegion,
  setFileInput,
  snapshot,
  waitFor,
} from '../lib/page.js';
import { isRed, readPng } from './png.mjs';

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
<div id="ctx-zone" role="button" aria-label="Right-click area" style="width:200px;height:40px;background:#eef;line-height:40px">Right-click area</div>
<div id="ctx-menu" style="display:none">
  <button id="ctx-delete" aria-label="Delete row">Delete row</button>
</div>
<div id="slider-track" style="width:300px;height:40px;background:#eee;position:relative;margin:8px 0">
  <div id="slider-thumb" role="button" aria-label="Thumb" style="width:40px;height:40px;background:#333;position:absolute;left:0;top:0"></div>
</div>
<p id="slider-out">0</p>
<div id="card" draggable="true" role="button" aria-label="Draggable card" style="width:100px;height:40px;background:#cde">Card</div>
<div id="dropzone" role="button" aria-label="Drop zone" style="width:200px;height:60px;background:#eee">Drop here</div>
<p id="dnd-out">none</p>
<script>
  // Right-click: a page-owned context menu, the way web apps replace the native one.
  document.getElementById('ctx-zone').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.__ctxFired = (window.__ctxFired || 0) + 1;
    document.getElementById('ctx-menu').style.display = 'block';
  });
  document.getElementById('ctx-delete').addEventListener('click', () => { window.__ctxDeleted = true; });

  // Pointer-driven drag: what dnd-kit / SortableJS / every slider looks like to CDP.
  (() => {
    const track = document.getElementById('slider-track');
    const thumb = document.getElementById('slider-thumb');
    let dragging = false;
    thumb.addEventListener('pointerdown', () => { dragging = true; });
    track.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const rect = track.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.width - 40, event.clientX - rect.left - 20));
      thumb.style.left = left + 'px';
      document.getElementById('slider-out').textContent = String(Math.round(left));
    });
    track.addEventListener('pointerup', () => { if (dragging) window.__pointerDropped = true; dragging = false; });
  })();

  // Native HTML5 drag: a different event family entirely, so it needs its own check.
  (() => {
    const card = document.getElementById('card');
    const zone = document.getElementById('dropzone');
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', 'card');
      event.dataTransfer.effectAllowed = 'move';
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      document.getElementById('dnd-out').textContent = 'dropped:' + event.dataTransfer.getData('text/plain');
    });
  })();
</script>
<button id="press" aria-label="Press me" onclick="document.getElementById('out').textContent='clicked'">Press me</button>
<p id="out">idle</p>
<input id="name" aria-label="Name field" placeholder="Name">
<button id="submit" aria-label="Submit name" onclick="document.getElementById('echo').textContent='hi '+document.getElementById('name').value">Submit name</button>
<p id="echo"></p>
<button id="alert" aria-label="Show alert" onclick="alert('hello from smoke')">Show alert</button>
<button id="confirm" aria-label="Ask confirm" onclick="window.__confirmed = confirm('sure?')">Ask confirm</button>
<input id="file" type="file" style="display:none" aria-label="Hidden file input">
<div id="menu-host" style="position:relative;display:inline-block;margin-top:8px">
  <button id="hover-trigger" aria-label="Open menu">Open menu</button>
  <div id="hover-menu" role="menu" style="position:absolute;left:0;top:100%;background:#fff;border:1px solid #ccc;z-index:10">
    <button id="menu-profile" aria-label="Profile item">Profile item</button>
    <button id="menu-signout" aria-label="Sign out item">Sign out item</button>
  </div>
</div>
<style>
  /* Not inline: an inline display:none outranks any :hover rule, which would make
     this test pass or fail for a reason that has nothing to do with the gesture. */
  #hover-menu { display: none; }
  #menu-host:hover #hover-menu { display: block; }
</style>
<div id="late"></div>
<script>
  setTimeout(() => {
    const ready = document.createElement('div');
    ready.id = 'late-ready';
    ready.textContent = 'ready';
    document.getElementById('late').appendChild(ready);
  }, 1200);
</script>
<!-- Everything below is deliberately far down the page: cropping and dropping have to
     work after a real scroll, not only for whatever happens to be at the top. -->
<div style="height:1200px;background:#fafafa"></div>
<div id="red-box" role="button" aria-label="Red box" style="width:120px;height:60px;background:#ff0000"></div>
<div id="file-zone" role="button" aria-label="File drop zone" style="width:240px;height:80px;background:#eef">Drop files here</div>
<p id="file-out">none</p>
<script>
  // A drop zone that actually accepts files: without preventDefault on dragover the
  // browser refuses the drop, which is exactly the state the tool has to explain.
  (() => {
    const zone = document.getElementById('file-zone');
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files || []);
      window.__droppedFiles = files.map((f) => f.name + ':' + f.size);
      window.__droppedTypes = Array.from(event.dataTransfer.types || []);
      document.getElementById('file-out').textContent = window.__droppedFiles.join(',') || 'none';
    });
  })();
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
const secondDropFile = join(dir, 'second-drop.txt');
writeFileSync(secondDropFile, 'second file contents\n', 'utf8');

// Frames need real HTTP: see tests/iframe-fixture.mjs for why file:// cannot do it.
const sites = await startIframeSites();
// Downloads need it for the same reason: only a real response carries the headers and
// the slow body that make a download observable.
const downloadSite = await startDownloadSite();

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const host = new BrowserHost({
  port: 9472,
  headless: true,
  width: 1280,
  height: 800,
  // Keep the test's downloads out of the real plugin folder.
  downloadDir: join(dir, 'downloads'),
});

try {
  console.log('1) start private browser');
  const started = Date.now();
  // `let`: switching tabs replaces the page session under us.
  let conn = await host.page();
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

  console.log('13) hover opens a menu that is display:none before it');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const trigger = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Open menu')));
  if (!trigger) fail('find hover trigger');
  else {
    const hidden = await evaluate(conn, `getComputedStyle(document.getElementById('hover-menu')).display`);
    const before = await snapshot(conn);
    await hoverAt(conn, trigger.x, trigger.y);
    await sleep(400);
    const shown = await evaluate(conn, `getComputedStyle(document.getElementById('hover-menu')).display`);
    const after = await snapshot(conn);
    const appeared = after.elements.filter(
      (el) => el.name.includes('Profile item') || el.name.includes('Sign out item'),
    );
    if (hidden === 'none' && shown === 'block' && appeared.length === 2) {
      ok('hover revealed the menu', `${before.elements.length} -> ${after.elements.length} elements`);
    } else {
      fail('hover revealed the menu', `display ${hidden} -> ${shown}, appeared ${appeared.length}`);
    }
    // Move away again so the open menu cannot cover the blocks tested below.
    await hoverAt(conn, 2, 2);
    const closed = await evaluate(conn, `getComputedStyle(document.getElementById('hover-menu')).display`);
    if (closed === 'none') ok('menu closes when the pointer leaves');
    else fail('menu closes', `still ${closed}`);
  }

  console.log('14) right click fires contextmenu');
  const zone = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Right-click area')));
  if (!zone) fail('find right-click area');
  else {
    await clickAt(conn, zone.x, zone.y, { button: 'right' });
    await sleep(350);
    const fired = await evaluate(conn, 'window.__ctxFired || 0');
    const menu = await evaluate(conn, `getComputedStyle(document.getElementById('ctx-menu')).display`);
    if (fired >= 1 && menu === 'block') ok('right click opened the page menu', `contextmenu x${fired}`);
    else fail('right click', `contextmenu x${fired}, menu ${menu}`);

    const del = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Delete row')));
    if (!del) fail('find context menu item');
    else {
      await clickAt(conn, del.x, del.y);
      await sleep(300);
      const deleted = await evaluate(conn, 'window.__ctxDeleted === true');
      if (deleted) ok('clicking the context menu item works');
      else fail('context menu item click');
      await evaluate(conn, `document.getElementById('ctx-menu').style.display = 'none'`);
    }
  }

  console.log('15) pointer drag moves a slider thumb');
  const thumb = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Thumb')));
  if (!thumb) fail('find slider thumb');
  else {
    const right = await evaluate(
      conn,
      `(() => { const r = document.getElementById('slider-track').getBoundingClientRect(); return { x: Math.round(r.right - 25), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await dragProbe(conn);
    await dragBetween(conn, { x: thumb.x, y: thumb.y }, right, { steps: 16 });
    await sleep(300);
    const left = await evaluate(conn, `document.getElementById('slider-thumb').style.left`);
    const dropped = await evaluate(conn, 'window.__pointerDropped === true');
    if (parseInt(left, 10) > 100 && dropped) ok('thumb moved', `left ${left}`);
    else fail('pointer drag', `left ${left}, pointerup seen: ${dropped}`);
  }

  console.log('16) native HTML5 drag and drop');
  const card = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Draggable card')));
  const dropzone = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Drop zone')));
  if (!card || !dropzone) fail('find drag pair');
  else {
    await dragProbe(conn);
    await dragBetween(conn, { x: card.x, y: card.y }, { x: dropzone.x, y: dropzone.y }, { steps: 20 });
    await sleep(400);
    const seen = await dragProbe(conn);
    const result = await evaluate(conn, `document.getElementById('dnd-out').textContent`);
    if (result === 'dropped:card') {
      ok('HTML5 drop landed', `dragstart ${seen.dragstart}, drop ${seen.drop}, dragenter ${seen.dragenter}`);
    } else {
      fail('HTML5 drop', `dnd-out=${JSON.stringify(result)} probe=${JSON.stringify(seen)}`);
    }
  }

  console.log('17) same-origin frame is scanned, cross-origin one is reported');
  await navigate(conn, sites.outerUrl, { timeoutMs: 20000 });

  // waitFor has to pierce the frame too, so this doubles as its own assertion.
  const innerReady = await waitFor(conn, { selector: '#inner-btn', timeoutMs: 8000 });
  if (innerReady.ok) ok('waitFor found an element inside a same-origin frame', `${innerReady.elapsed}ms`);
  else fail('waitFor through iframe', JSON.stringify(innerReady));

  const framed = await snapshot(conn);
  const innerBtn = framed.elements.find((el) => el.name.includes('Inner button'));
  const innerField = framed.elements.find((el) => el.name.includes('Inner name'));
  const outerBtn = framed.elements.find((el) => el.name.includes('Outer button'));
  if (innerBtn && innerField && outerBtn) {
    ok('framed and top-level elements listed together', `${framed.elements.length} total`);
  } else {
    fail('snapshot of framed page', JSON.stringify(framed.elements.map((e) => `${e.ref}:${e.name}@${e.frame}`)));
  }
  if (innerBtn?.frame === '0' && !outerBtn?.frame) ok('frame path recorded', `inner=${innerBtn?.frame}, outer=top`);
  else fail('frame path', `inner=${JSON.stringify(innerBtn?.frame)} outer=${JSON.stringify(outerBtn?.frame)}`);

  const blocked = framed.frames?.blocked || [];
  // Three frames resist the page-side walk now: another port (cross-origin, same
  // process), another host (cross-site, own process) and the nested pair.
  if (framed.frames?.scanned === 1 && blocked.length === 3) ok('cross-origin frames reported, not thrown', `${blocked.length} blocked`);
  else fail('cross-origin report', JSON.stringify(framed.frames));

  console.log('18) clicks and typing land inside the frame');
  if (!innerBtn || !innerField) fail('skip: framed elements missing');
  else {
    // Coordinates were translated per frame; the browser's own hit test is what has to
    // land inside, so reading the flag back out of the child document is the real proof.
    await clickAt(conn, innerBtn.x, innerBtn.y);
    await sleep(350);
    const hit = await evaluate(
      conn,
      `document.getElementById('same').contentDocument.defaultView.__innerClicked === true`,
    );
    if (hit === true) ok('click landed inside the frame');
    else fail('click inside frame', JSON.stringify(hit));

    await clickAt(conn, innerField.x, innerField.y);
    await insertText(conn, 'framed text');
    const value = await evaluate(
      conn,
      `document.getElementById('same').contentDocument.getElementById('inner-name').value`,
    );
    if (value === 'framed text') ok('typing reached the framed input', JSON.stringify(value));
    else fail('typing in frame', JSON.stringify(value));
  }

  console.log('19) page text spans documents');
  const spanned = await pageText(conn);
  if (spanned.includes('[frame 0]') && spanned.includes('Inner heading') && spanned.includes('Outer button')) {
    ok('text includes the framed document', `${spanned.length} chars`);
  } else {
    fail('text spans documents', spanned.slice(0, 200));
  }

  console.log('20) upload reaches a file input that only exists inside the frame');
  try {
    // The selector cannot be resolved from the main document at all, so this only
    // works if the element is found through the frame walk and then handed to the DOM
    // agent as a RemoteObject.
    await setFileInput(conn, { selector: '#inner-file', files: [uploadFile] });
    const names = await evaluate(
      conn,
      `(() => {
         const el = document.getElementById('same').contentDocument.getElementById('inner-file');
         return el && el.files ? Array.from(el.files).map((f) => f.name) : null;
       })()`,
    );
    if (Array.isArray(names) && names[0] === 'upload-me.txt') ok('framed file input accepted the file', names.join(', '));
    else fail('framed file input', JSON.stringify(names));
  } catch (error) {
    fail('framed file input', error.message);
  }

  console.log('21) a download click lands on disk');
  const waitForNewDownload = async (countBefore, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (host.downloads().length > countBefore) break;
      await sleep(100);
    }
    return host.waitForDownloads(10000);
  };

  let recorded = 0;
  try {
    await navigate(conn, downloadSite.url, { timeoutMs: 30000 });
    const attrLink = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Export report')));
    if (!attrLink) {
      fail('find download link', (await snapshot(conn)).elements.map((el) => el.name).join(' | '));
    } else {
      await clickAt(conn, attrLink.x, attrLink.y);
      const list = await waitForNewDownload(recorded);
      recorded = list.length;
      const hit = list.find((d) => d.suggestedFilename === 'report.csv');
      if (!hit) {
        fail('download recorded', JSON.stringify(list.map((d) => d.suggestedFilename)));
      } else {
        if (hit.state === 'completed') ok('download reported completed', hit.suggestedFilename);
        else fail('download state', hit.state);
        const onDisk = hit.path && existsSync(hit.path) ? readFileSync(hit.path, 'utf8') : null;
        if (onDisk === ATTR_BODY) ok('file on disk matches the response', hit.path.split(/[\\/]/).pop());
        else fail('file content', `${hit.path} -> ${onDisk === null ? 'missing' : JSON.stringify(onDisk)}`);
      }
    }
  } catch (error) {
    fail('download click', error.message);
  }

  console.log('22) a second identical download gets its own copy');
  try {
    const again = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Export report')));
    await clickAt(conn, again.x, again.y);
    const list = await waitForNewDownload(recorded);
    recorded = list.length;
    const copies = list.filter((d) => d.suggestedFilename === 'report.csv');
    const paths = copies.map((d) => d.path).filter(Boolean);
    if (copies.length === 2 && new Set(paths).size === 2 && paths.every((p) => existsSync(p))) {
      ok('collision resolved to two distinct files', paths.map((p) => p.split(/[\\/]/).pop()).join(' + '));
    } else {
      fail('collision', JSON.stringify({ records: copies.length, paths }));
    }
  } catch (error) {
    fail('second download', error.message);
  }

  console.log('23) content-disposition decides the file name');
  try {
    const headerLink = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('Download Q3')));
    await clickAt(conn, headerLink.x, headerLink.y);
    const list = await waitForNewDownload(recorded);
    recorded = list.length;
    const hit = list.find((d) => d.suggestedFilename === 'q3-report.csv');
    const body = hit?.path && existsSync(hit.path) ? readFileSync(hit.path, 'utf8') : null;
    if (body === HEADER_BODY) ok('response header named the file', hit.path.split(/[\\/]/).pop());
    else fail('content-disposition name', JSON.stringify({ suggested: hit?.suggestedFilename, path: hit?.path }));
  } catch (error) {
    fail('header download', error.message);
  }

  console.log('24) a slow download is visible while it runs, then completes');
  try {
    const slowLink = await snapshot(conn).then((s) => s.elements.find((el) => el.name.includes('big dataset')));
    await clickAt(conn, slowLink.x, slowLink.y);
    let during = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      during = host.downloads().find((d) => d.suggestedFilename === 'slow.bin');
      if (during) break;
      await sleep(50);
    }
    if (during?.state === 'inProgress') {
      ok('reported as in progress', `${during.receivedBytes}/${during.totalBytes || '?'} bytes`);
    } else if (during?.state === 'completed') {
      ok('in-progress state was too brief to observe, but the record exists');
    } else {
      fail('slow download recorded', JSON.stringify(during ?? null));
    }

    const settled = await host.waitForDownloads(20000);
    const slow = settled.find((d) => d.suggestedFilename === 'slow.bin');
    const size = slow?.path && existsSync(slow.path) ? statSync(slow.path).size : -1;
    if (slow?.state === 'completed' && size === SLOW_BYTES) {
      ok('waitForDownloads returned a complete file', `${slow.path.split(/[\\/]/).pop()} ${size} bytes`);
    } else {
      fail('slow download completion', JSON.stringify({ state: slow?.state, size, path: slow?.path }));
    }
    recorded = settled.length;
  } catch (error) {
    fail('slow download', error.message);
  }

  console.log('25) files dragged in from disk reach the drop zone');
  try {
    await navigate(conn, url, { timeoutMs: 20000 });
    await evaluate(conn, 'window.scrollTo(0, 0)');
    const zone = await elementBox(conn, '#file-zone');
    ok('drop zone scrolled into view', `@${Math.round(zone.x)},${Math.round(zone.y)} ${Math.round(zone.width)}x${Math.round(zone.height)}`);

    await evaluate(conn, 'window.__droppedFiles = null');
    await dragProbe(conn);
    await dropFilesAt(conn, { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 }, [uploadFile, secondDropFile]);
    const seen = await dragProbe(conn);

    const dropped = await evaluate(conn, 'window.__droppedFiles');
    const types = await evaluate(conn, 'window.__droppedTypes');
    const expected = [
      `upload-me.txt:${readFileSync(uploadFile).length}`,
      `second-drop.txt:${readFileSync(secondDropFile).length}`,
    ];
    if (JSON.stringify(dropped) === JSON.stringify(expected)) ok('DataTransfer.files carried both paths', dropped.join(', '));
    else fail('drag files', JSON.stringify({ dropped, expected }));
    if (Array.isArray(types) && types.includes('Files')) ok('the page sees a file drag', types.join(','));
    else fail('file drag types', JSON.stringify(types));
    if (seen?.drop > 0) ok('drop event counted', `drop ${seen.drop}`);
    else fail('drop event', JSON.stringify(seen));
  } catch (error) {
    fail('drag files', error.message);
  }

  console.log('26) a cropped screenshot is the region asked for, not a blank block');
  try {
    const box = await elementBox(conn, '#red-box');
    // The clip is in document pixels. Passing the viewport coordinates straight
    // through produced a blank white 120x60 image while this was being written —
    // which is exactly the failure this step exists to catch, so keep the scroll.
    const scroll = await evaluate(conn, '({ x: Math.round(scrollX), y: Math.round(scrollY) })');
    const patch = { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height };

    const crop = readPng(await screenshotRegion(conn, patch));
    const centre = crop.pixel(crop.width / 2, crop.height / 2);
    if (crop.width === 120 && crop.height === 60) ok('crop is the element size', `${crop.width}x${crop.height}`);
    else fail('crop size', `${crop.width}x${crop.height}`);
    if (isRed(centre) && crop.coverage(isRed) > 0.9) {
      ok('crop pixels are the element', `rgb(${centre.join(',')}), coverage ${crop.coverage(isRed).toFixed(2)}`);
    } else {
      fail('crop pixels', `centre rgb(${centre.join(',')}) coverage ${crop.coverage(isRed).toFixed(2)}`);
    }

    const full = readPng(await screenshot(conn));
    if (full.width === 1280 && full.height === 800) ok('the full screenshot is still the viewport');
    else fail('full screenshot size', `${full.width}x${full.height}`);

    const doubled = readPng(await screenshotRegion(conn, { ...patch, scale: 2 }));
    if (doubled.width === 240 && doubled.height === 120) ok('scale doubles the pixels', `${doubled.width}x${doubled.height}`);
    else fail('scale', `${doubled.width}x${doubled.height}`);
  } catch (error) {
    fail('crop screenshot', error.message);
  }

  console.log('27) tabs: create, switch, close');
  try {
    const before = await host.listTabs();
    const created = await host.newTab(secondUrl);
    const afterCreate = await host.listTabs();
    const active = afterCreate.find((tab) => tab.active);
    if (afterCreate.length === before.length + 1 && active?.id === created.id) {
      ok('new tab opened and became active', `${before.length} -> ${afterCreate.length}`);
    } else {
      fail('new tab', JSON.stringify({ before: before.length, after: afterCreate.length, active: active?.id, created }));
    }

    conn = await host.page();
    const title = await evaluate(conn, 'document.title');
    if (title === 'dsh bg cu smoke 2') ok('the session moved to the new tab', title);
    else fail('tab content', JSON.stringify(title));

    const oldTab = before.find((tab) => tab.url === url) ?? before[0];
    conn = await host.useTab(oldTab.id);
    const backTitle = await evaluate(conn, 'document.title');
    if (backTitle === 'dsh bg cu smoke') ok('switched back to the first tab', backTitle);
    else fail('switch back', JSON.stringify(backTitle));

    const closed = await host.closeTab(created.id);
    const afterClose = await host.listTabs();
    if (afterClose.length === afterCreate.length - 1) ok('tab closed', `${afterClose.length} left`);
    else fail('close tab', JSON.stringify({ closed, remaining: afterClose.length }));

    // Closing the tab currently being driven must hand the session to another one
    // instead of leaving every later call on a dead socket.
    const handedOver = await host.closeTab(host.pageTargetId);
    conn = await host.page();
    const alive = await evaluate(conn, '1 + 1');
    if (alive === 2) ok('closing the active tab hands the session over', `${handedOver.remaining} tab(s) were already open`);
    else fail('close active tab', JSON.stringify({ alive, handedOver }));
  } catch (error) {
    fail('tabs', error.message);
  }

  console.log('28) cross-origin frames are read through isolated worlds');
  try {
    await navigate(conn, sites.outerUrl, { timeoutMs: 20000 });
    const crossSnap = await snapshotAll(conn);
    const foreignAll = crossSnap.elements.filter((el) => el.name === 'Foreign button');
    const framePaths = [...new Set(foreignAll.map((el) => el.frame))].sort();
    // Three regimes, one button each: another port (same process), the nested one, and
    // `localhost` vs `127.0.0.1`, which Chrome puts in a process of its own.
    if (framePaths.length === 3) ok('all three cross-origin regimes listed', framePaths.join(', '));
    else fail('cross-origin frames in snapshot', JSON.stringify(crossSnap.elements.map((e) => `${e.name}@${e.frame}`)));

    const reported = crossSnap.frames?.cross ?? [];
    // The nested host frame is listed too (it has no controls of its own, only a child),
    // so the assertion is about the three documents that do hold elements.
    const withElements = reported.filter((frame) => frame.count > 0).map((frame) => frame.path).sort();
    if (withElements.join(',') === '1,2.0,x0') ok('each one reported as read', reported.map((f) => `${f.path}:${f.count}${f.process ? '(own process)' : ''}`).join(' '));
    else fail('frame report', JSON.stringify(crossSnap.frames));

    const ownProcess = reported.filter((f) => f.process);
    if (ownProcess.length === 1 && ownProcess[0].path === 'x0') ok('the cross-site frame runs in its own process', ownProcess[0].url);
    else fail('own-process frame', JSON.stringify(reported));

    console.log('29) clicks and typing reach a frame in its own process');
    for (const path of framePaths) {
      const btn = (await snapshotAll(conn)).elements.find(
        (el) => el.frame === path && (el.name === 'Foreign button' || el.name === 'clicked'),
      );
      if (!btn) {
        fail(`button in frame ${path}`, 'not found');
        continue;
      }
      if (btn.name === 'clicked') {
        ok(`click landed in frame ${path}`, 'already clicked');
        continue;
      }
      await clickAt(conn, btn.x, btn.y);
      await sleep(320);
      const now = (await snapshotAll(conn)).elements.find((el) => el.frame === path && el.name === 'clicked');
      if (now) ok(`click landed in frame ${path}`, `(${btn.x}, ${btn.y})`);
      else fail(`click in frame ${path}`, `still "${btn.name}" at (${btn.x}, ${btn.y})`);
    }

    // Typing is the other half of input: focus by click, then insert text.
    const field = (await snapshotAll(conn)).elements.find((el) => el.frame === 'x0' && el.name === 'Foreign name');
    if (!field) fail('framed input', 'not found');
    else {
      await clickAt(conn, field.x, field.y);
      await insertText(conn, 'typed through a frame boundary');
      await sleep(250);
      const echoed = await readText(conn, 6000);
      if (echoed.includes('typed: typed through a frame boundary')) ok('typing reached a cross-process frame');
      else fail('typing through frame', echoed.slice(0, 200));
      await evaluate(conn, `document.querySelector('#site').blur()`);
    }

    console.log('30) text, waiting and uploads cross frame boundaries too');
    const spannedText = await readText(conn, 8000);
    if (spannedText.includes('[frame 1') && spannedText.includes('[frame x0')) {
      ok('page text includes the cross-origin frames', `${spannedText.length} chars`);
    } else {
      fail('text across frames', spannedText.slice(0, 240));
    }

    const uploaded = await uploadInFrames(conn, { selector: '#foreign-file', files: [uploadFile] }).catch((error) => ({ error: error.message }));
    if (uploaded?.count === 1) ok('upload reached a framed file input', `frame ${uploaded.frame}`);
    else fail('upload through frame', JSON.stringify(uploaded));

    // The condition only becomes true inside the frame, so this is the frame-side wait
    // doing the work, not the page-side one.
    const waited = await waitAcrossFrames(conn, { text: 'file: upload-me.txt', timeoutMs: 6000 });
    if (waited?.ok && waited.inFrame) ok('a wait matched inside a cross-origin frame', `${waited.elapsed}ms, frame ${waited.frame}`);
    else fail('wait across frames', JSON.stringify(waited));
  } catch (error) {
    fail('cross-origin frames', error.message);
  }

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  console.log(`artifacts: ${dir}`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await host.shutdown().catch(() => {});
  sites.close();
  downloadSite.close();
}
