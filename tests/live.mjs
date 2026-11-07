/** Live-site check: real navigation, real snapshot, real click. node tests/live.mjs [url] */

import { BrowserHost } from '../lib/cdp.js';
import { clickAt, evaluate, navigate, screenshot, snapshot } from '../lib/page.js';

const url = process.argv[2] ?? 'https://example.com';
const host = new BrowserHost({ port: 9473, headless: true, width: 1280, height: 800 });

try {
  const conn = await host.page();
  const t0 = Date.now();
  const nav = await navigate(conn, url, { timeoutMs: 45000 });
  console.log(`navigate: ${nav.loaded ? 'loaded' : 'timeout'} in ${Date.now() - t0}ms`);

  const snap = await snapshot(conn);
  console.log(`title: ${snap.title}`);
  console.log(`url:   ${snap.url}`);
  console.log(`elements: ${snap.elements.length}`);
  for (const el of snap.elements.slice(0, 15)) {
    console.log(`  #${el.ref} ${el.tag}${el.type ? `[${el.type}]` : ''} "${el.name}" @${el.x},${el.y}`);
  }

  const link = snap.elements.find((el) => el.tag === 'a');
  if (link) {
    console.log(`\nclicking #${link.ref} "${link.name}" ...`);
    await clickAt(conn, link.x, link.y);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await evaluate(conn, 'location.href');
    console.log(`url after click: ${after}`);
    console.log(after !== snap.url ? 'navigation happened — click works on the live web' : 'url unchanged');
  }

  const shot = await screenshot(conn);
  console.log(`screenshot: ${shot.length} bytes`);
  console.log('\nOK');
} catch (error) {
  console.log(`ERROR ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await host.shutdown().catch(() => {});
}
