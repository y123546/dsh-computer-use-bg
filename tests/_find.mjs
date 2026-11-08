/** Read-only: where does "一键领取" actually live in the running DSH window? */
import { BrowserHost } from '../lib/cdp.js';
import { evaluate } from '../lib/page.js';

const host = new BrowserHost({ attachUrl: 'http://127.0.0.1:9333' });
try {
  await host.ensure();
  const conn = await host.page();
  const where = await evaluate(conn, '({ title: document.title, url: location.href })');
  console.log('current page:', JSON.stringify(where));

  const hits = await evaluate(conn, `(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const needle = '领取';
    while (walker.nextNode()) {
      const text = (walker.currentNode.nodeValue || '').trim();
      if (!text || !text.includes(needle)) continue;
      const el = walker.currentNode.parentElement;
      if (!el) continue;
      const path = [];
      let node = el;
      for (let up = 0; up < 5 && node; up += 1) {
        path.push((node.tagName || '').toLowerCase() + (node.getAttribute && node.getAttribute('aria-label') ? '[' + node.getAttribute('aria-label') + ']' : ''));
        node = node.parentElement;
      }
      out.push({ text: text.slice(0, 60), path: path.join(' < '), cls: String(el.className).slice(0, 40) });
    }
    return out.slice(0, 10);
  })()`);
  console.log('matches for 领取:', hits.length);
  for (const hit of hits) console.log('  ', JSON.stringify(hit));

  const nav = await evaluate(conn, `[...document.querySelectorAll('button,[role="button"],a')]
    .map((el) => (el.textContent || '').trim())
    .filter((t) => t && t.length < 24)
    .slice(0, 40)`);
  console.log('clickable labels on this page:', JSON.stringify(nav));
} catch (error) {
  console.log('ERROR', error.message);
} finally {
  await host.shutdown();
}
