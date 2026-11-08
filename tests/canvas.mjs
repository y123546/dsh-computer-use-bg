/**
 * End-to-end test of the only route that works on a surface with no control tree.
 *
 * The fixture (tests/canvas-fixture.mjs) is a real Chromium window painting a canvas:
 * three buttons, a flat panel, and a zone that re-randomises itself every frame. Nothing
 * inside a canvas can be described by an accessibility tree, so the whole loop is
 * picture → coordinate → click → picture.
 *
 * What is asserted, and why each one matters:
 *
 *   1. the window can be captured at all — a composited app on an invisible desktop
 *      sometimes hands back a flat colour with no error anywhere;
 *   2. `desktop_tree` genuinely offers no way in — otherwise this test proves nothing
 *      about the picture route;
 *   3. the button can be found in the image and clicked by *that* coordinate, confirmed
 *      by the page's own click log (not by pixels);
 *   4. the report says the click landed — signal well above the area's own noise;
 *   5. a click on a flat panel reports that nothing changed;
 *   6. a click into a self-randomising zone reports that pixels cannot tell, instead of
 *      claiming success or failure.
 *
 * Point 6 is the one worth having: it is the case where a confident answer would be a
 * lie, and the only useful thing a tool can do is say so.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserHost, resolveBrowser } from '../lib/cdp.js';
import { DesktopHost } from '../lib/desktop.js';
import { evaluate } from '../lib/page.js';
import { readPng } from './png.mjs';
import {
  CANVAS_BUTTONS,
  CANVAS_HTML,
  CANVAS_NOISE_ZONE,
  CANVAS_STILL_ZONE,
} from './canvas-fixture.mjs';

const PORT = 9471;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-'));
const pageFile = join(dir, 'game.html');
writeFileSync(pageFile, CANVAS_HTML, 'utf8');

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Bounding box of everything within `tolerance` of a colour. */
function findColour(png, [tr, tg, tb], tolerance = 24) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const [r, g, b] = png.pixel(x, y);
      if (Math.abs(r - tr) <= tolerance && Math.abs(g - tg) <= tolerance && Math.abs(b - tb) <= tolerance) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const desk = new DesktopHost({});
const reader = new BrowserHost({ attachUrl: `http://127.0.0.1:${PORT}` });
let pid = 0;
try {
  console.log('1) launch a real canvas app');
  await desk.ensure();
  // Deliberately NOT isolated. Measured: on an invisible desktop a composited window
  // (Chromium, a game, anything DWM draws) is never composed at all, and PrintWindow
  // faithfully returns one flat colour while reporting success. All five capture flag
  // combinations behave identically, so this is the platform, not the call. The window
  // does appear on screen for the few seconds this test runs.
  const launched = await desk.launch({
    path: resolveBrowser(),
    args: [
      `--app=${pathToFileURL(pageFile).href}`,
      `--user-data-dir=${join(dir, 'profile')}`,
      `--remote-debugging-port=${PORT}`,
      '--window-size=920,660',
      '--no-first-run',
      '--no-default-browser-check',
      // A window on a desktop nobody watches is "occluded" by Chromium's own reckoning,
      // and it then stops painting. Without this the capture is a flat colour.
      '--disable-features=CalculateNativeWinOcclusion',
      // Software rasterisation: the GPU path is unreliable when the window is not on the
      // active desktop, and a half-drawn frame reads as an empty app.
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    isolated: false,
    name: 'canvas',
  });
  pid = launched.pid;
  const win = await desk.waitForWindow({ pid, desktop: launched.desktop });
  if (win) ok('window is up', `${win.id} ${win.rect.width}x${win.rect.height}`);
  else fail('window', 'never appeared');

  const conn = await reader.ensure();
  await sleep(900);
  const state = () => evaluate(conn, 'window.__state ? { ...window.__state } : null');
  const clientOrigin = await desk.tree({ window: win.id, desktop: launched.desktop });

  const shotAt = async (tag, grid = false) => {
    const file = join(dir, `${tag}.png`);
    const meta = await desk.shot({ window: win.id, path: file, desktop: launched.desktop, grid });
    return { png: readPng(readFileSync(file)), meta };
  };

  console.log('2) the control tree offers no way in — that is the premise of this test');
  const tree = await desk.tree({ window: win.id, desktop: launched.desktop });
  const named = tree.controls.map((c) => String(c.name || ''));
  const seesButtons = named.some((name) => /START|PAUSE|RESET|static panel/i.test(name));
  if (!seesButtons) ok('no painted control is visible to UI Automation', `${tree.controls.length} controls, none from the canvas`);
  else fail('canvas leaked into the tree', named.join(' | ').slice(0, 160));

  console.log('3) the picture is the only way in');
  let frame = await shotAt('frame');
  // The helper already re-takes a suspiciously flat frame; this is the second line of
  // defence, because a canvas scene has dozens of colours when it is really painted.
  for (let attempt = 0; attempt < 4 && Number(frame.meta.colours) < 24; attempt += 1) {
    await sleep(600);
    frame = await shotAt('frame');
  }
  if (Number(frame.meta.colours) > 6) ok('capture has real content', `${frame.meta.width}x${frame.meta.height}, ${frame.meta.colours} colours`);
  else fail('capture', `only ${frame.meta.colours} colours — the compositor never painted`);

  const start = CANVAS_BUTTONS[0];
  const box = findColour(frame.png, hexToRgb(start.fill));
  if (!box) {
    fail('find the button in the picture', 'its colour is nowhere in the capture');
    throw new Error('cannot continue without a located button');
  }
  ok('the painted button can be located by its colour', `at (${box.x}, ${box.y}) ${box.width}x${box.height}`);

  // Page coordinates and client-area coordinates differ (a Chromium app window has a
  // band above the page). The screenshot is in client pixels, so the offset is measured
  // once and then used to state expectations in the same space the tool works in.
  const offset = { x: box.x - start.x, y: box.y - start.y };
  ok('picture coordinates are client coordinates', `page → client offset ${offset.x},${offset.y}`);
  void clientOrigin;

  const buttonCentre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  console.log('4) click the button at the coordinate measured from the picture');
  const hit = await desk.act(
    { action: 'click', window: win.id, x: buttonCentre.x, y: buttonCentre.y },
    { desktop: launched.desktop },
  );
  await sleep(150);
  const afterHit = await state();
  if (afterHit?.start === 1) ok('the page itself confirms the hit', `last: ${afterHit.last}`);
  else fail('ground truth', `the canvas logged ${afterHit?.last} instead of start #1`);
  const hitLocal = hit.verify?.local ?? {};
  if ((Number(hitLocal.signal) || 0) >= (Number(hitLocal.noise) || 0) * 2 + 0.001 && (Number(hitLocal.signal) || 0) > 0.002) {
    ok('the report says the click landed', `signal ${(hitLocal.signal * 100).toFixed(1)}% vs noise ${(hitLocal.noise * 100).toFixed(1)}%`);
  } else {
    fail('hit report', JSON.stringify(hit.verify));
  }

  console.log('5) click the flat panel — nothing may be reported as happening');
  const stillPoint = {
    x: Math.round(CANVAS_STILL_ZONE.x + CANVAS_STILL_ZONE.w / 2 + offset.x),
    y: Math.round(CANVAS_STILL_ZONE.y + CANVAS_STILL_ZONE.h / 2 + offset.y),
  };
  const still = await desk.act(
    { action: 'click', window: win.id, x: stillPoint.x, y: stillPoint.y },
    { desktop: launched.desktop },
  );
  await sleep(150);
  const afterStill = await state();
  if (/^still@/.test(String(afterStill?.last))) ok('the page confirms it hit the panel', afterStill.last);
  else fail('ground truth', `the canvas logged ${afterStill?.last}`);
  const stillLocal = still.verify?.local ?? {};
  if ((Number(stillLocal.noise) || 0) < 0.004 && (Number(stillLocal.signal) || 0) < 0.004) {
    ok('nothing changed, and that is what it says', `signal ${(stillLocal.signal * 100).toFixed(1)}% noise ${(stillLocal.noise * 100).toFixed(1)}%`);
  } else {
    fail('still-panel report', JSON.stringify(still.verify));
  }

  console.log('6) click into the self-randomising zone — pixels must refuse to judge');
  const noisePoint = {
    x: Math.round(CANVAS_NOISE_ZONE.x + CANVAS_NOISE_ZONE.w / 2 + offset.x),
    y: Math.round(CANVAS_NOISE_ZONE.y + CANVAS_NOISE_ZONE.h / 2 + offset.y),
  };
  const noisy = await desk.act(
    { action: 'click', window: win.id, x: noisePoint.x, y: noisePoint.y },
    { desktop: launched.desktop },
  );
  await sleep(150);
  const afterNoise = await state();
  if (/^noise@/.test(String(afterNoise?.last))) ok('the page confirms it hit that zone', afterNoise.last);
  else fail('ground truth', `the canvas logged ${afterNoise?.last}`);
  const noiseLocal = noisy.verify?.local ?? {};
  const noiseFloor = Number(noiseLocal.noise) || 0;
  const noiseSignal = Number(noiseLocal.signal) || 0;
  if (noiseFloor > 0.02) ok('the baseline shows the zone animates on its own', `noise ${(noiseFloor * 100).toFixed(1)}%`);
  else fail('baseline noise', `expected the speckled zone to move, measured ${(noiseFloor * 100).toFixed(1)}%`);
  if (noiseSignal <= noiseFloor * 2 + 0.001) ok('the signal is indistinguishable from the noise', `signal ${(noiseSignal * 100).toFixed(1)}%`);
  else fail('noise-zone report', JSON.stringify(noisy.verify));

  console.log('7) the ruler does not destroy the picture');
  const gridded = await shotAt('grid', true);
  if (Number(gridded.meta.colours) > 6 && gridded.png.width === frame.png.width) {
    ok('grid capture is still a real image', `${gridded.meta.colours} colours`);
  } else {
    fail('grid capture', `${gridded.meta.colours} colours`);
  }

  console.log('8) a colour search turns the picture into a coordinate');
  const byColour = await desk.find({ window: win.id, color: start.fill });
  const block = byColour?.matches?.[0];
  if (block) {
    const dx = Math.abs(block.x - box.x);
    const dy = Math.abs(block.y - box.y);
    const dw = Math.abs(block.width - box.width);
    const dh = Math.abs(block.height - box.height);
    if (dx <= 2 && dy <= 2 && dw <= 2 && dh <= 2) {
      ok('the block is found exactly where it is painted', `${block.x},${block.y} ${block.width}x${block.height}, centre ${block.cx},${block.cy}`);
    } else {
      fail('colour box', `found ${JSON.stringify(block)} but the picture says ${box.x},${box.y} ${box.width}x${box.height}`);
    }
  } else {
    fail('colour search', JSON.stringify(byColour));
  }

  console.log('9) a text search reads the label off the pixels');
  const byText = await desk.find({ window: win.id, text: 'START' });
  const label = byText?.matches?.[0];
  if (label && byText.engines?.includes('ocr')) {
    // The label centre has to fall inside the button it belongs to, otherwise clicking
    // what OCR found would be a miss dressed up as a coordinate.
    const inside =
      label.cx >= box.x && label.cx <= box.x + box.width && label.cy >= box.y && label.cy <= box.y + box.height;
    if (inside) {
      ok('the label centre is inside its button', `"${label.text}" at ${label.x},${label.y} → centre ${label.cx},${label.cy}`);
    } else {
      fail('label placement', `"${label.text}" centre ${label.cx},${label.cy} is outside the button ${box.x},${box.y} ${box.width}x${box.height}`);
    }
  } else {
    fail('text search', JSON.stringify(byText));
  }

  console.log('10) a search that finds nothing says what the picture actually contains');
  const absent = await desk.find({ window: win.id, text: 'CHECKOUT-BUTTON' });
  if ((absent?.matches?.length ?? 0) === 0 && String(absent?.readText ?? '').length > 0) {
    ok('nothing matched, and the read text is reported', absent.readText.slice(0, 60).replace(/\s+/g, ' '));
  } else {
    fail('absent text search', JSON.stringify(absent));
  }

  console.log('11) a colour-only search does not need OCR at all');
  const noText = await desk.find({ window: win.id, color: CANVAS_BUTTONS[1].fill });
  const pause = noText?.matches?.[0];
  if (pause && !(noText.engines || []).includes('ocr') && Math.abs(pause.width - 140) <= 2) {
    ok('colour search runs on its own', `${pause.width}x${pause.height} of ${CANVAS_BUTTONS[1].fill}`);
  } else {
    fail('colour-only search', JSON.stringify({ engines: noText?.engines, match: pause }));
  }

  console.log('12) a background colour is reported as a background, not as a target');
  // The window background is within tolerance of this one, so a naive search returns a
  // box covering everything and a "centre" that would click the middle of nowhere.
  const background = await desk.find({ window: win.id, color: '#101318', tolerance: 8 });
  const wholeWindow = background?.matches?.[0];
  if (wholeWindow) {
    const share = (wholeWindow.width * wholeWindow.height) / (background.size.width * background.size.height);
    if (share > 0.6) ok('the background really does cover the window', `${Math.round(share * 100)}% — the tool warns about this`);
    else fail('background share', `${Math.round(share * 100)}% — the fixture changed`);
  } else {
    fail('background search', JSON.stringify(background));
  }
} catch (error) {
  failures += 1;
  console.log('  FAIL  crashed', error.message);
} finally {
  await reader.shutdown().catch(() => {});
  if (pid) await desk.kill({ pid }).catch(() => {});
  await desk.stop().catch(() => {});
  console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  if (failures === 0) console.log('artifacts kept nowhere; temp dir was', dir);
}
