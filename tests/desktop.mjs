/**
 * Desktop plane test: an app started on an isolated desktop, driven, and read back.
 *
 * Run with: node tests/desktop.mjs
 *
 * Nothing here touches the user's screen: the app is launched onto its own desktop,
 * and every assertion comes back as data (window lists, control text) rather than
 * from a screenshot a human has to look at.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DesktopHost } from '../lib/desktop.js';
import { readPng } from './png.mjs';

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const WINVER = 'C:\\Windows\\System32\\winver.exe';

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-'));
mkdirSync(dir, { recursive: true });

const host = new DesktopHost({});
let notepad = null;
let verifier = null;

try {
  console.log('1) the helper starts and can reach Win32');
  const info = await host.ensure();
  if (info.ping?.platform === 'win32') ok('helper answers', `python ${info.ping.python} ${info.ping.arch}-bit via ${info.exe}`);
  else fail('helper ping', JSON.stringify(info));

  const local = await host.windows({});
  if (local.windows.length > 0) ok('the user desktop has windows', `${local.windows.length}: ${local.windows.map((w) => w.process).slice(0, 4).join(', ')}`);
  else fail('user windows', JSON.stringify(local));

  console.log('2) an app starts on an isolated desktop');
  if (!existsSync(NOTEPAD)) fail('notepad present', NOTEPAD);
  const launched = await host.launch({ path: NOTEPAD, isolated: true, name: 'dsh-test' });
  if (launched?.isolated && launched?.pid > 0) ok('launched', `pid ${launched.pid} on desktop "${launched.desktop}"`);
  else fail('launch isolated', JSON.stringify(launched));

  notepad = await host.waitForWindow({ pid: launched.pid, desktop: launched.desktop });
  if (notepad) ok('its window exists there', `${notepad.title} — ${notepad.class} ${notepad.rect.width}x${notepad.rect.height}`);
  else fail('window on isolated desktop', 'no window appeared within 12s');

  // The point of the whole exercise: the app is not on the desktop the user is looking at.
  const stillLocal = await host.windows({});
  const leaked = stillLocal.windows.filter((w) => w.pid === launched.pid);
  if (leaked.length === 0) ok('it is invisible on the user desktop', `${stillLocal.windows.length} windows there, none of them it`);
  else fail('isolation', `the app also appears on the user desktop: ${JSON.stringify(leaked.map((w) => w.title))}`);

  console.log('3) the control tree finds the editor');
  const tree = notepad ? await host.tree({ window: notepad.id, desktop: launched.desktop }) : null;
  const editor = tree?.controls?.find((c) => c.kind === 'text field');
  if (editor) ok('text field found', `${editor.class} ${editor.rect.width}x${editor.rect.height} control ${editor.controlId}`);
  else fail('control tree', JSON.stringify(tree?.controls?.map((c) => c.class)));

  console.log('4) typing reaches it, and it reads back');
  if (!editor) fail('skip typing', 'no editor');
  else {
    const typed = 'hello from the desktop plane';
    const wrote = await host.act({ action: 'type', target: editor.id, text: typed }, { desktop: launched.desktop });
    if (wrote?.chars === typed.length) ok('text sent', `${wrote.via}, ${wrote.chars} chars`);
    else fail('type', JSON.stringify(wrote));
    const readBack = await host.read({ target: editor.id, desktop: launched.desktop });
    if (readBack?.text === typed) ok('the control contains exactly that', JSON.stringify(readBack.text));
    else fail('read back', JSON.stringify(readBack));
  }

  console.log('5) a window screenshot is real pixels');
  if (!notepad) fail('skip screenshot', 'no window');
  else {
    const shotPath = join(dir, `${notepad.id}.png`);
    const shot = await host.shot({ window: notepad.id, path: shotPath, desktop: launched.desktop });
    const png = existsSync(shotPath) ? readPng(readFileSync(shotPath)) : null;
    if (png && png.width === shot.width && png.height === shot.height) {
      ok('screenshot matches the client area', `${png.width}x${png.height}, painted ${shot.painted}`);
    } else {
      fail('screenshot', JSON.stringify({ shot, png: png ? `${png.width}x${png.height}` : null }));
    }
  }

  console.log('6) a click at a control hangs up the app (real button, real coordinates)');
  if (!existsSync(WINVER)) {
    fail('winver present', WINVER);
  } else {
    const second = await host.launch({ path: WINVER, isolated: true, name: 'dsh-test-dialog' });
    verifier = await host.waitForWindow({ pid: second.pid, desktop: second.desktop });
    if (!verifier) {
      fail('dialog window', 'winver produced no window');
    } else {
      ok('dialog opened', `${verifier.title || verifier.class} ${verifier.rect.width}x${verifier.rect.height}`);
      const dialogTree = await host.tree({ window: verifier.id, desktop: second.desktop });
      const button = dialogTree.controls.find((c) => c.kind === 'button' && c.enabled);
      if (!button) {
        fail('dialog button', JSON.stringify(dialogTree.controls.map((c) => `${c.class}:${c.text}`)));
      } else {
        const clicked = await host.act({ action: 'click', target: button.id }, { desktop: second.desktop });
        // A standard button acts on the posted button-up, so the dialog should close.
        let gone = false;
        for (let i = 0; i < 20 && !gone; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const list = await host.windows({ desktop: second.desktop });
          gone = !list.windows.some((w) => w.id === verifier.id);
        }
        if (gone) ok('the posted click was accepted', `${JSON.stringify(clicked)} closed "${button.text || button.class}"`);
        else fail('click on a real button', `the dialog is still open after ${JSON.stringify(clicked)}`);
      }
    }
  }

  console.log('7) both desktops are still separate afterwards');
  const isolatedList = await host.desktops();
  if (isolatedList.length === 2) ok('two isolated desktops tracked', isolatedList.map((d) => d.name).join(', '));
  else fail('desktop bookkeeping', JSON.stringify(isolatedList));
} catch (error) {
  failures += 1;
  console.log(`\n  ERROR ${error?.message ?? error}`);
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 5).join('\n'));
} finally {
  // Leave nothing running: the desktops belong to this process, and a stray notepad
  // on an invisible desktop would be impossible for the user to find and close.
  for (const pid of [notepad?.pid, verifier?.pid].filter(Boolean)) {
    await host.kill({ pid }).catch(() => {});
  }
  await host.stop().catch(() => {});
  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  console.log(`artifacts: ${dir}`);
  if (failures > 0) process.exitCode = 1;
}
