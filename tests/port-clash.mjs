// Regression test for the DSH port clash: DSH itself runs with
// --remote-debugging-port, so a listening endpoint on our port may belong to
// another app. The host must never attach to a foreign (Electron) endpoint — it
// has to move to the next free port and start its own browser.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserHost } from '../lib/cdp.js';

const BASE_PORT = 9411;
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

let foreignHits = 0;
const fake = createServer((req, res) => {
  foreignHits += 1;
  if (req.url.startsWith('/json/version')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        Browser: 'Chrome/140.0.7339.80',
        'Protocol-Version': '1.3',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DeepSeek Harness/0.2.1 Chrome/140.0.7339.80 Electron/38.2.1 Safari/537.36',
      }),
    );
    return;
  }
  // If the host ever adopts us it will ask for a page target — record and refuse.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'FOREIGN', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/FOREIGN' }));
});

await new Promise((resolve, reject) => {
  fake.once('error', reject);
  fake.listen(BASE_PORT, '127.0.0.1', resolve);
});
console.log(`fake Electron endpoint listening on ${BASE_PORT}`);

const host = new BrowserHost({
  port: BASE_PORT,
  headless: true,
  profileDir: mkdtempSync(join(tmpdir(), 'bgcu-clash-')),
  timeoutMs: 25000,
});

try {
  const conn = await host.ensure();
  check('moved off the occupied port', host.port !== BASE_PORT, `still on ${host.port}`);
  check('started its own browser process', Boolean(host.child?.pid), 'no child process');
  check('never touched the foreign endpoint', foreignHits === 0, `${foreignHits} request(s)`);

  const alive = await conn.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, { timeoutMs: 8000 });
  check('our own browser answers CDP', alive?.result?.value === 2, JSON.stringify(alive));

  const version = await fetch(`http://127.0.0.1:${host.port}/json/version`).then((r) => r.json());
  check('endpoint on the new port is a real browser', !String(version['User-Agent']).includes('Electron'), version['User-Agent']);
  console.log(`using port ${host.port} — ${version.Browser}`);
} catch (error) {
  check('host started', false, error?.message ?? String(error));
} finally {
  await host.shutdown().catch(() => {});
  fake.close();
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
