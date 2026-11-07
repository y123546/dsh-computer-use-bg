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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
`;

const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-tools-'));
const pageFile = join(dir, 'page.html');
writeFileSync(pageFile, PAGE, 'utf8');
const pageUrl = pathToFileURL(pageFile).href;
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
const services = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
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
apply(ctx, { port: PORT, headless: true, width: 1440, height: 900, idleMs: 0 });

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

  console.log('10) close');
  const closed = await call('browser_close');
  if (closed.text.includes('shut down')) ok('close');
  else fail('close', closed.text.slice(0, 120));

  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await call('browser_close').catch(() => {});
}
