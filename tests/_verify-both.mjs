/** Read the rows of both plugins out of the live app, via the plugin's own attach mode. */
import { BrowserHost } from '../lib/cdp.js';
import { snapshotAll } from '../lib/frames.js';
import { clickAt, evaluate } from '../lib/page.js';

const WANTED = ['dsh-armory', 'dsh-computer-use-bg'];
const ALL = process.argv.includes('--all');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = new BrowserHost({ attachUrl: 'http://127.0.0.1:9333' });
try {
  await host.ensure();
  const conn = await host.page();
  const snap = await snapshotAll(conn);
  const entry = snap.elements.find((el) => el.name === '插件' || el.name === 'Plugins');
  console.log('plugin entry:', entry ? `${entry.name} @${entry.x},${entry.y}` : 'not found');
  if (entry) await clickAt(conn, entry.x, entry.y);
  await sleep(3200);

  const readRow = async (name) =>
    evaluate(conn, `(() => {
      const hit = [...document.querySelectorAll('*')].find(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(name)},
      );
      if (!hit) return null;
      let node = hit;
      for (let d = 0; d < 16 && node; d += 1) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
        if (key) {
          let fiber = node[key];
          for (let u = 0; u < 14 && fiber; u += 1) {
            const props = fiber.memoizedProps;
            if (props && props.pkg && String(props.pkg.name || '') === ${JSON.stringify(name)}) {
              const pkg = props.pkg;
              return {
                version: pkg.version,
                enabled: pkg.enabled,
                error: pkg.error === undefined ? null : String(pkg.error),
                phases: (pkg.rows || []).map((row) => row.phase),
                diagnostics: (pkg.rows || []).map((row) => row.diagnostic || []).flat().slice(0, 2),
              };
            }
            fiber = fiber.return;
          }
        }
        node = node.parentElement;
      }
      return null;
    })()`);

  if (ALL) {
    // Walk every fiber in the plugin list once, instead of looking up two names.
    let rows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      rows = await evaluate(conn, `(() => {
        const seen = new Map();
        for (const el of document.querySelectorAll('*')) {
          const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
          if (!key) continue;
          let fiber = el[key];
          for (let u = 0; u < 14 && fiber; u += 1) {
            const pkg = fiber.memoizedProps && fiber.memoizedProps.pkg;
            if (pkg && pkg.name && !seen.has(pkg.name)) {
              seen.set(pkg.name, {
                name: pkg.name,
                version: pkg.version,
                enabled: pkg.enabled,
                error: pkg.error === undefined ? null : String(pkg.error),
                phases: (pkg.rows || []).map((row) => row.phase),
              });
            }
            fiber = fiber.return;
          }
        }
        return [...seen.values()];
      })()`);
      if (rows.length >= 20) break;
      await sleep(1500);
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const row of rows) console.log(`${row.name}: ${JSON.stringify(row)}`);
    console.log(`total rows: ${rows.length}${rows.length < 20 ? ' — INCOMPLETE: plugin list not visible in the current view' : ''}`);
  } else {
    for (const name of WANTED) {
      let row = null;
      for (let attempt = 0; attempt < 20 && !row; attempt += 1) {
        row = await readRow(name);
        if (!row) await sleep(1500);
      }
      console.log(`${name}:`, row ? JSON.stringify(row) : 'row not found');
    }
  }
} catch (error) {
  console.log('ERROR', error.message);
} finally {
  await host.shutdown();
  await sleep(400);
  console.log('DSH still alive:', await fetch('http://127.0.0.1:9333/json/version').then((r) => r.ok).catch(() => false));
}
