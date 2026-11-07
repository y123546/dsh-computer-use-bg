import { BrowserHost } from '../lib/cdp.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = new BrowserHost({
  port: 9474, headless: true,
  profileDir: mkdtempSync(join(tmpdir(), 'idle-')),
  timeoutMs: 30000, idleMs: 2500,
});
const conn = await host.ensure();
await conn.send('Runtime.evaluate', { expression: '1', returnByValue: true });
const pid = host.child?.pid;
console.log('browser up, child pid =', pid);

const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
console.log('right after use, alive =', alive(pid));

await new Promise((r) => setTimeout(r, 4000));
console.log('after 4s idle, alive =', alive(pid), '| host.child =', host.child);
process.exit(0);
