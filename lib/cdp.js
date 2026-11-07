/**
 * Zero-dependency Chrome DevTools Protocol client + private Chromium host.
 *
 * Requires Node >= 22 for the global `fetch` and `WebSocket`.
 *
 * Everything here talks to a *separate* browser instance that this plugin owns.
 * Input events are synthesised inside that instance, so the user's real mouse,
 * keyboard and foreground window are never touched.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KNOWN_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** Locate a Chromium executable. `override` wins, then DSH_BG_CU_BROWSER, then well-known paths. */
export function resolveBrowser(override) {
  const candidates = [override, process.env.DSH_BG_CU_BROWSER, ...KNOWN_BROWSERS].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const rel of [
      'Google/Chrome/Application/chrome.exe',
      'Microsoft/Edge/Application/msedge.exe',
    ]) {
      const candidate = join(local, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    'No Chromium browser found. Install Edge or Chrome, or set DSH_BG_CU_BROWSER to the full path of msedge.exe / chrome.exe.',
  );
}

export class CdpConnection {
  static async open(url, { timeoutMs = 15000 } = {}) {
    const socket = new WebSocket(url);
    const connection = new CdpConnection(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP socket open timed out after ${timeoutMs}ms (${url})`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP socket failed to open (${url})`));
      }, { once: true });
    });
    return connection;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    socket.addEventListener('message', (event) => {
      let message;
      try {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const detail = message.error.data ? ` — ${message.error.data}` : '';
          reject(new Error(`${message.error.message}${detail}`));
        } else {
          resolve(message.result);
        }
        return;
      }
      if (message.method) {
        const set = this.listeners.get(message.method);
        if (set) for (const fn of [...set]) fn(message.params);
      }
    });

    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, { timeoutMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP socket is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

/** Owns the private Chromium process, its profile directory and the CDP page session. */
export class BrowserHost {
  constructor(options = {}) {
    this.exePath = options.exePath;
    this.port = Number(options.port ?? 9333);
    this.headless = options.headless === true;
    this.width = Number(options.width ?? 1440);
    this.height = Number(options.height ?? 900);
    this.timeoutMs = Number(options.timeoutMs ?? 25000);
    this.profileDir =
      options.profileDir ??
      join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-computer-use-bg', 'profile');
    this.connection = null;
    this.child = null;
    this.starting = null;
  }

  async ensure() {
    if (this.connection && !this.connection.closed) return this.connection;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    const exe = resolveBrowser(this.exePath);
    mkdirSync(this.profileDir, { recursive: true });

    let version = await this.#probe();
    if (!version) {
      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-service-autorun',
        '--remote-allow-origins=*',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-features=msEdgeFirstRunExperience,Translate,MediaRouter',
        `--window-size=${this.width},${this.height}`,
        '--window-position=40,40',
      ];
      if (this.headless) args.push('--headless=new');
      args.push('about:blank');

      this.child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      this.child.unref();
      this.child.on('error', () => {
        /* surfaced by #probe timeout */
      });
      version = await this.#probe(this.timeoutMs);
    }
    if (!version) {
      throw new Error(
        `Chromium did not expose a debugging endpoint on port ${this.port} within ${this.timeoutMs}ms. ` +
          `Close any browser using the same profile (${this.profileDir}) and retry.`,
      );
    }

    const target = await this.#pageTarget();
    const connection = await CdpConnection.open(target.webSocketDebuggerUrl);

    // A target can accept the socket and then ignore commands; one cheap round trip
    // tells us now instead of on the first real action.
    const alive = await connection
      .send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 6000 })
      .then((result) => result?.result?.value === 1)
      .catch(() => false);
    if (!alive) {
      connection.close();
      throw new Error(
        `CDP page target ${target.id ?? '(unknown)'} accepted the socket but did not answer commands. ` +
          `Close any browser using the profile ${this.profileDir} and try again.`,
      );
    }

    await connection.send('Page.enable', {}, { timeoutMs: 15000 }).catch(() => {});
    await connection.send('Runtime.enable', {}, { timeoutMs: 15000 }).catch(() => {});
    // A backgrounded target can silently drop synthetic input events.
    await connection.send('Page.bringToFront', {}, { timeoutMs: 10000 }).catch(() => {});
    await connection
      .send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: this.width,
          height: this.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        { timeoutMs: 15000 },
      )
      .catch(() => {});

    this.connection = connection;
    return connection;
  }

  async #probe(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
          signal: AbortSignal.timeout(1200),
        });
        if (response.ok) return await response.json();
      } catch {
        /* not up yet */
      }
      if (Date.now() >= deadline) return null;
      await sleep(250);
    } while (true);
  }

  async #pageTarget() {
    // Always create our own page. A browser-supplied about:blank target can accept
    // the websocket and then ignore every command (observed on Edge 155), which is
    // indistinguishable from a healthy connection until the first send times out.
    // Chrome 111+ requires PUT for /json/new.
    try {
      const created = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000),
      });
      if (created.ok) {
        const entry = await created.json();
        if (entry?.webSocketDebuggerUrl) return entry;
      }
    } catch {
      /* fall back to an existing page */
    }

    const list = await this.#json('/json/list');
    const page = list.find(
      (entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && !entry.url?.startsWith('devtools://'),
    );
    if (page) return page;
    throw new Error('Could not find or create a page target in the private browser.');
  }

  async #json(path) {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`CDP HTTP ${path} returned ${response.status}`);
    return response.json();
  }

  /** Reuse the current page session, or open a fresh connection after the browser was restarted. */
  async page() {
    const connection = await this.ensure();
    return connection;
  }

  /** Drop our handle without killing the browser process (it stays warm for the next call). */
  release() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }

  /** Terminate the private browser. */
  async shutdown() {
    this.release();
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close`, { signal: AbortSignal.timeout(1000) });
    } catch {
      /* ignore */
    }
    if (this.child && this.child.pid) {
      try {
        process.kill(this.child.pid);
      } catch {
        /* already gone */
      }
    }
    this.child = null;
  }
}
