/**
 * Tool-level integration test: boots the plugin through `apply()` with a mock cordis
 * context and then calls the registered tools the way the host would.
 *
 * smoke.mjs proves the CDP layer works; this proves the wiring around it — that every
 * tool's declared output schema accepts what it really returns, that screenshots come
 * back as attachment references, and that an auto-answered dialog is reported.
 *
 * Run with: node tests/tools.mjs
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ATTR_BODY, startDownloadSite } from './download-fixture.mjs';
import { startIframeSites } from './iframe-fixture.mjs';
import { isRed, readPng } from './png.mjs';

const PORT = 9474;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>tool test</title>
<button id="go" aria-label="Go now" onclick="document.getElementById('out').textContent='went'">Go now</button>
<p id="out">idle</p>
<input id="file" type="file" style="display:none">
<div id="menu-host" style="position:relative;display:inline-block">
  <button id="mtrigger" aria-label="Open menu">Open menu</button>
  <div id="hmenu" role="menu" style="position:absolute;left:0;top:100%;background:#fff;border:1px solid #ccc;z-index:5">
    <button id="mp1" aria-label="Profile item" onclick="window.__profileClicked = true">Profile item</button>
    <button id="mp2" aria-label="Sign out item">Sign out item</button>
  </div>
</div>
<style>
  /* Table rule, not an inline style: inline display:none would outrank :hover and the
     test would then measure the CSS, not the gesture. */
  #hmenu { display: none; }
  #menu-host:hover #hmenu { display: block; }
</style>
<div id="cardx" draggable="true" role="button" aria-label="Draggable card" style="width:90px;height:36px;background:#cde">Card</div>
<div id="zonex" role="button" aria-label="Drop zone" style="width:180px;height:50px;background:#eee">Drop here</div>
<p id="dnd">none</p>
<script>
  (() => {
    const card = document.getElementById('cardx');
    const zone = document.getElementById('zonex');
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
      document.getElementById('dnd').textContent = 'dropped:' + event.dataTransfer.getData('text/plain');
    });
  })();
</script>
<p id="later"></p>
<script>
  setTimeout(() => {
    const ready = document.createElement('p');
    ready.id = 'late';
    ready.textContent = 'late content';
    document.getElementById('later').appendChild(ready);
  }, 900);
</script>
<a id="pop" href="popup.html" target="_blank" aria-label="Open popup">Open popup</a>
<!-- Below the fold on purpose: cropping and dropping happen after a scroll. -->
<div style="height:1400px;background:#fafafa"></div>
<div id="redbox" role="button" aria-label="Red box" style="width:120px;height:60px;margin-left:40px;background:#ff0000"></div>
<div id="zone" role="button" aria-label="File drop zone" style="width:240px;height:80px;background:#eef">Drop files here</div>
<p id="fv">none</p>
<script>
  (() => {
    const zone = document.getElementById('zone');
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      window.__files = Array.from(event.dataTransfer.files || []).map((f) => f.name + ':' + f.size);
      document.getElementById('fv').textContent = window.__files.join(',');
    });
  })();
</script>
`;

const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-tools-'));
const pageFile = join(dir, 'page.html');
writeFileSync(pageFile, PAGE, 'utf8');
const pageUrl = pathToFileURL(pageFile).href;
const popupFile = join(dir, 'popup.html');
writeFileSync(
  popupFile,
  '<!doctype html><meta charset="utf-8"><title>popup page</title><h1>Popup</h1><button aria-label="Popup button">Popup button</button>',
  'utf8',
);
const uploadFile = join(dir, 'note.txt');
writeFileSync(uploadFile, 'hello upload\n', 'utf8');

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- mock cordis ctx -------------------------------------------------------
const registered = new Map();
const disposers = [];
// The attachment store sees the real bytes, so the test can decode the image and
// check the pixels a cropped screenshot claims to contain.
const savedImages = [];
const services = {
  logger: { info() {}, warn() {}, error() {} },
  // The real host keeps the disposer and runs it on unload; collecting them here means
  // the desktop helper is actually shut down at the end instead of outliving the test.
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => {};
    },
  },
  // Shaped like the real attachment store's ref, so toAttachmentJson has something
  // honest to whitelist.
  attachments: {
    async saveImage({ data, mediaType, name }) {
      savedImages.push({ data, name, mediaType });
      return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType, bytes: data.length, width: 1440, height: 900, name };
    },
  },
};
const ctx = new Proxy(services, {
  get(target, prop) {
    // Mirrors cordis: ctx.get(name, force) is the soft lookup, a bare property read
    // is strict. Getting the lookup itself wrong would silently hide attachments.
    if (prop === 'get') return (name, force = true) => (name in target ? target[name] : force ? (() => { throw new Error(name); })() : undefined);
    if (prop in target) return target[prop];
    throw new Error(`ctx.${String(prop)} is not available`);
  },
});

const { apply } = await import('../lib/index.js');
apply(ctx, { port: PORT, headless: true, width: 1440, height: 900, idleMs: 0, downloadDir: join(dir, 'downloads') });

const call = async (name, args = {}) => {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  const value = await tool.execute(args);
  // The host validates every return value against the tool's own schema before the
  // model sees it; doing it here means a bad shape fails the test, not the user.
  const { validate } = await import('./schema.mjs');
  const violations = validate(tool.output.schema, value);
  if (violations.length > 0) throw new Error(`${name} returned a value its schema rejects: ${violations.join('; ')}`);
  return value;
};

try {
  console.log('1) doctor');
  const doctor = await call('computer_use_doctor');
  if (/status: OK/.test(doctor.text)) ok('doctor reports OK');
  else fail('doctor', doctor.text.split('\n').slice(-2).join(' | '));

  console.log('2) open + screenshot attachment');
  const opened = await call('browser_open', { url: pageUrl });
  if (opened.text.includes('Go now')) ok('elements listed');
  else fail('open elements', opened.text.slice(0, 120));
  if (opened.image?.attachmentId) ok('screenshot returned as attachment', `${opened.image.bytes} bytes, ${opened.image.width}x${opened.image.height}`);
  else fail('screenshot attachment', JSON.stringify(opened.image));

  console.log('3) wait');
  const waited = await call('browser_wait', { selector: '#late', timeoutMs: 5000 });
  if (waited.text.includes('Wait satisfied')) ok('wait satisfied');
  else fail('wait', waited.text.slice(0, 160));

  console.log('4) dialog is reported, not swallowed');
  // The note rides on the *next* tool result after the dialog was answered, which is
  // the eval that opened it — exactly where a caller would look.
  const asked = await call('browser_eval', { expression: "alert('from the tool test')" });
  if (asked.text.includes('dialog handled automatically') && asked.text.includes('from the tool test')) {
    ok('dialog note appended', asked.text.split('\n').pop().slice(0, 70));
  } else {
    fail('dialog note', asked.text.slice(-160));
  }
  const afterDialog = await call('browser_snapshot', { screenshot: false });
  if (!afterDialog.text.includes('dialog handled automatically')) ok('the note is not repeated on later calls');
  else fail('note repeated', afterDialog.text.slice(-120));

  console.log('5) upload');
  const uploaded = await call('browser_upload', { selector: '#file', files: [uploadFile] });
  if (uploaded.text.includes('Attached 1 file')) ok('upload reported');
  else fail('upload', uploaded.text.slice(0, 160));

  const missing = await call('browser_upload', { selector: '#file', files: [join(dir, 'nope.txt')] }).then(() => null).catch((error) => error.message);
  if (missing && missing.includes('do not exist')) ok('missing file is a clear error');
  else fail('missing file', String(missing));

  console.log('6) nav');
  const reloaded = await call('browser_nav', { action: 'reload', screenshot: false });
  if (reloaded.text.includes('Reloaded')) ok('reload');
  else fail('reload', reloaded.text.slice(0, 120));
  // History depth is whatever the earlier browser_open left behind, so the edge cases
  // live in smoke.mjs where the history is built deliberately. What belongs here is
  // that a nonsense action is rejected with a message the model can act on.
  const badAction = await call('browser_nav', { action: 'sideways', screenshot: false }).then(() => null).catch((error) => error.message);
  if (badAction && badAction.includes('reload / back / forward')) ok('bad action explained');
  else fail('bad action', String(badAction));

  console.log('7) hover reports only what the hover revealed');
  const hovered = await call('browser_hover', { text: 'Open menu', screenshot: false });
  if (hovered.text.includes('Appeared after hovering (2)')) ok('hover diff counted 2 new elements');
  else fail('hover diff', hovered.text.split('\n').slice(0, 6).join(' | '));
  if (hovered.text.includes('Profile item')) ok('revealed item is listed with a ref');
  else fail('revealed item listed', hovered.text.slice(0, 200));
  // The point of hovering is that the next click can land on the popup, so prove the
  // revealed element is actually clickable instead of just printed.
  const popupClick = await call('browser_click', { text: 'Profile item', screenshot: false });
  const clickedFlag = await call('browser_eval', { expression: 'window.__profileClicked === true' });
  if (popupClick.text.includes('Clicked') && clickedFlag.text.trim() === 'true') ok('clicking the revealed item works');
  else fail('click revealed item', `${popupClick.text.split('\n')[0]} / flag ${clickedFlag.text}`);

  console.log('8) hover on something with no popup says so');
  const idleHover = await call('browser_hover', { text: 'Go now', screenshot: false });
  if (idleHover.text.includes('Nothing new appeared')) ok('empty diff explained');
  else fail('empty diff', idleHover.text.split('\n').slice(0, 4).join(' | '));

  console.log('9) drag names the drag family it found');
  const dragged = await call('browser_drag', { text: 'Draggable card', toText: 'Drop zone', screenshot: false });
  if (dragged.text.includes('Native HTML5 drag and drop, and the drop landed')) ok('HTML5 drag recognised');
  else fail('drag verdict', dragged.text.split('\n').slice(0, 4).join(' | '));
  const dndResult = await call('browser_eval', { expression: "document.getElementById('dnd').textContent" });
  if (dndResult.text.trim() === 'dropped:card') ok('the page really received the drop');
  else fail('drop payload', dndResult.text.trim());

  console.log('10) snapshot output explains frames');
  const sites = await startIframeSites();
  try {
    await call('browser_open', { url: sites.outerUrl, screenshot: false });
    const framed = await call('browser_snapshot', { screenshot: false });
    if (framed.text.includes('(f0)') && framed.text.includes('Inner button')) ok('framed element tagged (f0)');
    else fail('framed tag', framed.text.split('\n').slice(0, 8).join(' | '));

    // Cross-origin frames used to end at "N frames cannot be read". They are read now,
    // and the header has to say so instead of warning about the opposite.
    if (/Read through \d+ cross-origin frame\(s\)/.test(framed.text) && framed.text.includes('own process')) {
      ok('cross-origin frames reported as read', framed.text.split('\n').find((row) => row.includes('Read through')).slice(0, 90));
    } else {
      fail('cross-origin header', framed.text.split('\n').slice(0, 8).join(' | '));
    }
    if (framed.text.includes('(fx0)')) ok('the separate-process frame is tagged (fx0)');
    else fail('fx0 tag', framed.text.split('\n').filter((row) => row.includes('Foreign button')).join(' | '));

    // A ref that lives in the frame must survive the whole chain: locate → translate
    // the coordinates → click → the child document seeing it.
    const line = framed.text.split('\n').find((row) => row.includes('Inner button'));
    const ref = line ? Number((line.match(/^#(\d+)/) || [])[1]) : NaN;
    if (!Number.isFinite(ref)) fail('parse framed ref', String(line));
    else {
      const clicked = await call('browser_click', { ref, screenshot: false });
      const flag = await call('browser_eval', {
        expression: `document.getElementById('same').contentDocument.defaultView.__innerClicked === true`,
      });
      if (clicked.text.includes('Clicked') && flag.text.trim() === 'true') ok('click by framed ref landed inside');
      else fail('click by framed ref', `${clicked.text.split('\n')[0]} / flag ${flag.text}`);
    }

    // Same flow for a ref that is not in this process at all: the number comes from the
    // cross-origin scan, so the click path has to find it in that frame's own document.
    const crossLine = framed.text.split('\n').find((row) => row.includes('(fx0)') && row.includes('Foreign button'));
    const crossRef = crossLine ? Number((crossLine.match(/^#(\d+)/) || [])[1]) : NaN;
    if (!Number.isFinite(crossRef)) fail('parse cross-frame ref', String(crossLine));
    else {
      const clicked = await call('browser_click', { ref: crossRef, screenshot: false });
      const after = await call('browser_snapshot', { screenshot: false });
      const landed = after.text.split('\n').find((row) => row.includes('(fx0)') && row.includes('clicked'));
      if (clicked.text.includes('Clicked') && landed) ok('click by cross-process ref landed in that frame');
      else fail('click by cross-process ref', `${clicked.text.split('\n')[0]} / ${after.text.split('\n').filter((r) => r.includes('(fx0)')).join(' | ')}`);
    }

    // Text has to include the frame bodies too, with a marker saying whose they are.
    const text = await call('browser_text', {});
    if (text.text.includes('[frame x0') && text.text.includes('Foreign button')) ok('browser_text reads cross-origin frames', `${text.text.length} chars`);
    else fail('text across frames', text.text.slice(0, 200));

    // And a wait whose condition only exists inside a frame must not burn the budget.
    const waited = await call('browser_wait', { text: 'Foreign button', timeoutMs: 5000 });
    if (/Wait satisfied/.test(waited.text)) ok('a wait matches inside a cross-origin frame', waited.text.split('\n')[0].slice(0, 80));
    else fail('wait across frames', waited.text.split('\n')[0]);
  } finally {
    sites.close();
  }

  console.log('11) a download click is reported where the model will look');
  const downloadSite = await startDownloadSite();
  try {
    await call('browser_open', { url: downloadSite.url, screenshot: false });
    const clicked = await call('browser_click', { text: 'Export report', screenshot: false });
    // The whole point: nothing changes on screen, so the note has to ride on the click
    // result itself. Waiting for a later call would mean the model already concluded
    // "nothing happened" and clicked again.
    if (/\(download:/.test(clicked.text) && /report\.csv/.test(clicked.text)) {
      ok('the click result carries the download note', clicked.text.split('\n').pop().slice(0, 90));
    } else {
      fail('download note on the click', clicked.text.split('\n').slice(-2).join(' | '));
    }

    const listed = await call('browser_download', { wait: true, timeoutMs: 15000 });
    if (listed.text.includes('report.csv') && listed.text.includes('completed')) {
      ok('browser_download reports state');
    } else {
      fail('browser_download', listed.text.split('\n').slice(0, 6).join(' | '));
    }
    const pathLine = listed.text.split('\n').find((row) => row.trim().startsWith('path:'));
    const target = pathLine ? pathLine.slice(pathLine.indexOf('path:') + 5).trim() : '';
    if (target && existsSync(target) && readFileSync(target, 'utf8') === ATTR_BODY) {
      ok('the listed path really holds the file', target.split(/[\\/]/).pop());
    } else {
      fail('downloaded file', target || '(no path line)');
    }

    // A name filter that matches nothing must be a clear answer, not a throw.
    const none = await call('browser_download', { filename: 'nothing-like-this' });
    if (none.text.includes('No download in this session matches')) ok('empty filter explained');
    else fail('empty filter', none.text.split('\n')[0]);
  } finally {
    downloadSite.close();
  }

  console.log('12) a cropped screenshot really contains the element');
  // Back to the fixture: the download step left the session on another site.
  await call('browser_open', { url: pageUrl, screenshot: false });
  const crop = await call('browser_screenshot', { selector: '#redbox', padding: 0 });
  const cropBytes = savedImages.filter((image) => image.name === 'crop.png').pop();
  if (/Captured/.test(crop.text) && /Image 120x60 px/.test(crop.text)) ok('crop reports the element size', crop.text.split('\n')[1]);
  else fail('crop text', crop.text.replace(/\n/g, ' | '));
  if (cropBytes?.data) {
    const decoded = readPng(cropBytes.data);
    const centre = decoded.pixel(decoded.width / 2, decoded.height / 2);
    // The tool scrolls first; if the clip used the wrong coordinate space this would be
    // a white block, which is precisely the bug the pixel check exists for.
    if (decoded.width === 120 && decoded.height === 60 && isRed(centre)) {
      ok('the returned bytes are the red element', `rgb(${centre.join(',')}) coverage ${decoded.coverage(isRed).toFixed(2)}`);
    } else {
      fail('crop pixels', `${decoded.width}x${decoded.height} rgb(${centre.join(',')})`);
    }
  } else {
    fail('crop attachment', 'saveImage was never called with crop.png');
  }
  if (/scrolled/.test(crop.text)) ok('the scroll is disclosed, so stale coordinates are expected');
  else fail('scroll disclosure', crop.text.replace(/\n/g, ' | '));

  const padded = await call('browser_screenshot', { selector: '#redbox', padding: 10, scale: 2 });
  if (/Image 280x160 px \(scale 2\)/.test(padded.text)) ok('padding and scale applied', '280x160');
  else fail('padding/scale', padded.text.replace(/\n/g, ' | '));

  console.log('13) files dropped from disk land in the drop zone');
  const dropFile = join(dir, 'drop-me.txt');
  writeFileSync(dropFile, 'dragged in\n', 'utf8');
  const dropped = await call('browser_drop_files', { text: 'File drop zone', files: [dropFile], screenshot: false });
  if (/The drop landed/.test(dropped.text)) ok('drop reported as landed', dropped.text.split('\n')[1]);
  else fail('drop verdict', dropped.text.split('\n').slice(0, 3).join(' | '));
  const seenByPage = await call('browser_eval', { expression: 'window.__files || null' });
  if (seenByPage.text.includes('drop-me.txt:11')) ok('the page received the real file', seenByPage.text.replace(/\s+/g, ' '));
  else fail('files at the page', seenByPage.text);

  const gone = await call('browser_drop_files', { text: 'File drop zone', files: [join(dir, 'not-here.txt')] }).then(() => null).catch((error) => error.message);
  if (gone && gone.includes('do not exist')) ok('a missing file is refused before any gesture');
  else fail('missing drop file', String(gone));

  console.log('14) a target=_blank click opens a tab, and the session follows it');
  await call('browser_eval', { expression: 'window.scrollTo(0, 0)' });
  const popClick = await call('browser_click', { text: 'Open popup', screenshot: false });
  await new Promise((resolve) => setTimeout(resolve, 700));
  const tabList = await call('browser_tabs', { action: 'list' });
  if (/new tab opened/.test(popClick.text)) ok('the click result says a tab opened', popClick.text.split('\n').pop().slice(0, 80));
  else fail('new tab note', popClick.text.split('\n').slice(-2).join(' | '));

  const popupLine = tabList.text.split('\n').find((line) => line.includes('popup.html'));
  if (popupLine) ok('the popup is its own tab', popupLine.trim().slice(0, 70));
  else fail('popup in list', tabList.text.replace(/\n/g, ' | ').slice(0, 300));

  // The list prints "id  title" then an indented URL line, so the URL has to be
  // attached to the entry above it rather than parsed on its own.
  const tabEntries = [];
  for (const line of tabList.text.split('\n')) {
    const head = line.match(/^(\*?)\s+([0-9a-f]{8,})\s{2,}(.*)$/i);
    if (head) tabEntries.push({ active: head[1] === '*', id: head[2], title: head[3], url: '' });
    else if (tabEntries.length > 0 && /^\s{4}\S/.test(line)) tabEntries[tabEntries.length - 1].url = line.trim();
  }
  const popupTab = tabEntries.find((entry) => entry.url.includes('popup.html'));
  if (popupTab) {
    if (popupTab.active) ok('the popup is the active tab, as the note said');
    else fail('popup active', JSON.stringify(tabEntries));

    const selected = await call('browser_tabs', { action: 'select', id: popupTab.id, screenshot: false });
    if (/Switched to tab/.test(selected.text) && /popup page/.test(selected.text)) ok('select switches to it', 'popup page');
    else fail('select tab', selected.text.split('\n').slice(0, 3).join(' | '));

    const closedPopup = await call('browser_tabs', { action: 'close', id: popupTab.id, screenshot: false });
    if (/Closed tab/.test(closedPopup.text)) ok('the popup can be closed again', closedPopup.text.split('\n')[0]);
    else fail('close popup', closedPopup.text.split('\n')[0]);
    // Closing the tab that was being driven must leave a working session behind.
    const stillAlive = await call('browser_eval', { expression: '1 + 1' });
    if (stillAlive.text.trim() === '2') ok('the session survived closing its own tab');
    else fail('session after close', stillAlive.text);
  } else {
    fail('popup entry', JSON.stringify(tabEntries));
  }

  console.log('15) close');
  const closed = await call('browser_close');
  if (closed.text.includes('shut down')) ok('close');
  else fail('close', closed.text.slice(0, 120));

  console.log('16) the desktop plane drives a native app through its tools');
  const notepad = 'C:\\Windows\\System32\\notepad.exe';
  let desktopName = '';
  let windowId = '';
  let pid = 0;
  try {
    const launched = await call('desktop_launch', { path: notepad, isolated: true, name: 'dsh-tools-test' });
    const launchedLine = launched.text.split('\n')[0];
    if (/on its own desktop/.test(launched.text) && /window is w/.test(launched.text)) ok('launched off-screen', launchedLine.slice(0, 90));
    else fail('desktop_launch', launched.text.slice(0, 200));
    desktopName = (launched.text.match(/desktop "([^"]+)"/) || [])[1] || '';
    windowId = (launched.text.match(/window is (w[0-9a-f]+)/) || [])[1] || '';
    pid = Number((launched.text.match(/pid (\d+)/) || [])[1] || 0);

    const list = await call('desktop_windows', {});
    if (list.text.includes(desktopName) && list.text.includes(windowId)) ok('desktop_windows shows it on its own desktop');
    else fail('desktop_windows', list.text.split('\n').slice(0, 6).join(' | '));

    const tree = await call('desktop_tree', { window: windowId, desktop: desktopName });
    const control = (tree.text.match(/^\s+(c[0-9a-f]+) text field/m) || [])[1];
    if (control) ok('desktop_tree found the text field', control);
    else fail('desktop_tree', tree.text.split('\n').slice(0, 6).join(' | '));

    const typed = 'tool layer desktop check';
    const wrote = await call('desktop_act', { action: 'type', target: control, text: typed, desktop: desktopName });
    if (/Typed \d+ character/.test(wrote.text)) ok('desktop_act typed into it', wrote.text.split('\n')[0].slice(0, 70));
    else fail('desktop_act type', wrote.text);

    // Reading it back is the only proof that typing went somewhere real.
    const read = await call('desktop_act', { action: 'read', target: control, desktop: desktopName });
    if (read.text.includes(typed)) ok('the control reads back exactly that');
    else fail('desktop_act read', read.text.slice(0, 160));

    const shot = await call('desktop_shot', { window: windowId, desktop: desktopName });
    if (shot.image?.attachmentId && /client area/.test(shot.text)) ok('desktop_shot returned an attachment', `${shot.image.width}x${shot.image.height}`);
    else fail('desktop_shot', shot.text.slice(0, 160));
  } finally {
    if (pid > 0) {
      const killed = await call('desktop_launch', { kill: pid }).catch((error) => ({ text: error.message }));
      if (/Ended pid/.test(killed.text)) ok('the app it started is gone again');
      else fail('desktop_launch kill', killed.text.slice(0, 120));
    }
  }

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await call('browser_close').catch(() => {});
  for (const dispose of disposers.splice(0)) {
    try {
      await dispose();
    } catch {
      /* a failing disposer must not hide the test result */
    }
  }
}
