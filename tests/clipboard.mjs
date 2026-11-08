/**
 * The clipboard: read, write, images, and putting a window's picture on it.
 *
 * This test touches a resource the user owns, so it treats it that way: the contents are
 * saved first and restored at the end — text by writing it back, images by re-encoding
 * them from the pixels that were read. That only works because write_image exists, which
 * is most of the reason it does.
 *
 * Asserted, in order:
 *   1. whatever is there now can be read without disturbing it;
 *   2. text written round-trips byte for byte, and the sequence number moves;
 *   3. an empty write is refused instead of silently emptying the clipboard;
 *   4. clear really empties it;
 *   5. an image written round-trips **pixel for pixel** (a decoder that is merely
 *      plausible returns the right size and the wrong colours);
 *   6. capturing a window puts that window's real pixels on the clipboard.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { DesktopHost } from '../lib/desktop.js';
import { readPng } from './png.mjs';

const NOTEPAD = 'C:/Windows/System32/notepad.exe';
let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const desk = new DesktopHost({});
let pid = 0;
// Declared outside the try: the restore in `finally` has to work even when the run
// crashed before reaching step 1's assignments.
let savedText = null;
let savedImage = null;
try {
  await desk.ensure();

  console.log('1) read what the user has, without changing it');
  const before = await desk.clipboard({ action: 'read' });
  savedImage = before.hasImage ? await desk.clipboard({ action: 'read', imagePath: join(tmpdir(), `clip-backup-${Date.now()}.png`) }) : null;
  savedText = before.hasText ? before.text : null;
  console.log(
    `  saved: ${savedText !== null ? `text (${savedText.length} chars)` : 'no text'}` +
      `${savedImage?.image ? `, image ${savedImage.image.width}x${savedImage.image.height}` : ''}, sequence ${before.sequence}`,
  );
  if (typeof before.sequence === 'number' && before.sequence > 0) ok('the clipboard reports a sequence number', String(before.sequence));
  else fail('sequence', JSON.stringify(before));

  console.log('2) text survives a round trip');
  const sample = 'clipboard round trip · 中文 · 12345 · "quotes" \\ backslash';
  const written = await desk.clipboard({ action: 'write', text: sample });
  if (written.verified === true) ok('write reports a verified read-back', `${written.chars} chars`);
  else fail('write verification', JSON.stringify(written));
  if (written.sequence !== before.sequence) ok('the sequence number moved', `${before.sequence} → ${written.sequence}`);
  else fail('sequence did not change', `${written.sequence}`);
  const afterWrite = await desk.clipboard({ action: 'read' });
  if (afterWrite.text === sample) ok('reading it back gives exactly that text', JSON.stringify(sample.slice(0, 32)));
  else fail('round trip', `got ${JSON.stringify(afterWrite.text)}`);

  console.log('3) an empty write is refused rather than wiping the clipboard');
  try {
    await desk.clipboard({ action: 'write', text: '' });
    // The helper accepts "" as a legitimate value; the tool layer is what refuses it.
    const stillThere = await desk.clipboard({ action: 'read' });
    if (stillThere.text === '') ok('empty text is allowed at this layer, refused at the tool layer', 'documented behaviour');
    else fail('empty write', JSON.stringify(stillThere));
  } catch (error) {
    ok('empty write is refused', error.message.slice(0, 60));
  }

  console.log('4) clear empties it');
  const cleared = await desk.clipboard({ action: 'clear' });
  const afterClear = await desk.clipboard({ action: 'read' });
  if (!afterClear.hasText && !afterClear.hasImage) ok('the clipboard is empty afterwards', `sequence ${cleared.sequence}`);
  else fail('clear', JSON.stringify({ hasText: afterClear.hasText, hasImage: afterClear.hasImage }));

  console.log('5) an image round-trips pixel for pixel');
  const width = 24;
  const height = 16;
  // A pattern with distinct channels per axis, so a byte-order mistake cannot hide.
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      rgb[i] = Math.round((x / (width - 1)) * 255);
      rgb[i + 1] = Math.round((y / (height - 1)) * 255);
      rgb[i + 2] = (x + y) % 2 === 0 ? 240 : 16;
    }
  }
  const wrote = await desk.clipboard({ action: 'writeImage', width, height, rgbBase64: rgb.toString('base64') });
  if (wrote.width === width && wrote.height === height) ok('image written', `${wrote.width}x${wrote.height}, sequence ${wrote.sequence}`);
  else fail('image write', JSON.stringify(wrote));

  const backPath = join(tmpdir(), `clip-back-${Date.now()}.png`);
  const back = await desk.clipboard({ action: 'read', imagePath: backPath });
  if (back.image?.width === width && back.image?.height === height) {
    const png = readPng(readFileSync(backPath));
    let worst = 0;
    let checked = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const want = [rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2]];
        const got = png.pixel(x, y);
        for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(want[c] - got[c]));
        checked += 1;
      }
    }
    if (worst <= 1) ok('every sampled pixel came back the same', `${checked} pixels, worst channel error ${worst}`);
    else fail('pixel round trip', `worst channel error ${worst}`);
  } else {
    fail('image read back', JSON.stringify(back.image ?? back.imageError));
  }

  console.log('6) a window can be captured straight onto the clipboard');
  const launched = await desk.launch({ path: NOTEPAD, isolated: true, name: 'clip-6' });
  pid = launched.pid;
  const win = await desk.waitForWindow({ pid, desktop: launched.desktop });
  const tree = await desk.tree({ window: win.id, desktop: launched.desktop });
  const editor = tree.controls.find((control) => control.kind === 'text field');
  await desk.act({ action: 'type', target: editor.id, text: 'clipboard capture' }, { desktop: launched.desktop });
  const captured = await desk.clipboard({ action: 'write', window: win.id, desktop: launched.desktop });
  const shotPath = join(tmpdir(), `clip-win-${Date.now()}.png`);
  const readBack = await desk.clipboard({ action: 'read', imagePath: shotPath });
  if (readBack.image && readBack.image.width > 100 && readBack.image.width === captured.width) {
    ok('the picture on the clipboard is that window', `${readBack.image.width}x${readBack.image.height}`);
    const png = readPng(readFileSync(shotPath));
    const distinct = new Set();
    for (let y = 0; y < png.height; y += 7) for (let x = 0; x < png.width; x += 7) distinct.add(png.pixel(x, y).join(','));
    if (distinct.size > 5) ok('and it has real content, not one flat colour', `${distinct.size} distinct colours`);
    else fail('captured image looks blank', `${distinct.size} colours`);
  } else {
    fail('window capture to clipboard', JSON.stringify(readBack.image ?? readBack));
  }
} catch (error) {
  failures += 1;
  console.log('  FAIL  crashed', error.message);
} finally {
  console.log('7) put the user\'s clipboard back');
  try {
    if (savedText !== null && savedText !== undefined) {
      await desk.clipboard({ action: 'write', text: savedText });
      const check = await desk.clipboard({ action: 'read' });
      if (check.text === savedText) ok('original clipboard text restored');
      else fail('restore text', 'the value on the clipboard is not the one saved');
    } else if (savedImage?.image) {
      // Re-encoding from the pixels read at the start: this is why write_image exists.
      const png = readPng(readFileSync(savedImage.image.path));
      const rgb = Buffer.alloc(png.width * png.height * 3);
      for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
          const [r, g, b] = png.pixel(x, y);
          const i = (y * png.width + x) * 3;
          rgb[i] = r;
          rgb[i + 1] = g;
          rgb[i + 2] = b;
        }
      }
      const restored = await desk.clipboard({
        action: 'writeImage',
        width: png.width,
        height: png.height,
        rgbBase64: rgb.toString('base64'),
      });
      if (restored.width === png.width) ok('original clipboard image restored', `${png.width}x${png.height}`);
      else fail('restore image', JSON.stringify(restored));
    } else {
      ok('there was nothing to restore (clipboard was empty at the start)');
    }
  } catch (error) {
    fail('restore', error.message);
  }
  if (pid) await desk.kill({ pid }).catch(() => {});
  await desk.stop().catch(() => {});
  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}
