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
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

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
    if (typeof WebSocket !== 'function') {
      throw new Error(
        'This runtime has no global WebSocket, so CDP cannot connect. Needs Node >= 22.19 / Electron >= 28.',
      );
    }
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
    this.port = Number(options.port ?? 9411);
    // Windowless by default, the way the agent itself works: the browser runs in the
    // background and nobody gets a stray window. `headless: false` opts into a visible one.
    this.headless = options.headless !== false;
    this.width = Number(options.width ?? 1440);
    this.height = Number(options.height ?? 900);
    this.timeoutMs = Number(options.timeoutMs ?? 25000);
    this.idleMs = Number(options.idleMs ?? 300000);
    // A JS dialog stops the renderer dead: every CDP command after it times out until
    // somebody answers. Automation has to answer, so accept by default and report.
    this.dialogBehavior = options.dialogBehavior === 'dismiss' ? 'dismiss' : 'accept';
    this.dialogPromptText = typeof options.dialogPromptText === 'string' ? options.dialogPromptText : '';
    this.profileDir =
      options.profileDir ??
      join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-computer-use-bg', 'profile');
    // Downloads land in the plugin's own folder by default: a headless browser that is
    // not told where to put them simply throws them away, and writing into the user's
    // real Downloads folder without being asked is not this plugin's call to make.
    this.downloadDir =
      options.downloadDir ??
      join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-computer-use-bg', 'downloads');
    this.connection = null;
    this.browserConnection = null;
    this.downloadError = null;
    this.child = null;
    this.starting = null;
    this.idleTimer = null;
    // Tab bookkeeping: which target the page session is attached to, and which target
    // ids existed at the last check. The second set is how a popup opened by a click is
    // noticed at all — Chrome gives no event on a plain page socket when a *new* target
    // appears, and target=_blank otherwise just looks like a click that did nothing.
    this.pageTargetId = null;
    this.knownTabs = new Set();
  }

  /**
   * Reset the idle countdown. The browser is not a service: once the agent stops
   * asking for it, the process has no reason to keep a few hundred MB alive.
   */
  touch() {
    if (!this.idleMs || this.idleMs <= 0) return;
    // Never arm the reaper while the browser is still coming up.
    if (this.starting && !this.connection) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.shutdown().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async ensure() {
    if (this.connection && !this.connection.closed) {
      this.touch();
      return this.connection;
    }
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    // Deliberately no touch() here: a cold start takes seconds, and starting the
    // idle countdown now would make the timer kill the browser mid-launch.
    return this.starting;
  }

  /** True when 127.0.0.1:port can be bound right now. */
  static #free(port) {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
  }

  /** First port at or above basePort that nothing is listening on. */
  async #pickFreePort(basePort) {
    for (let offset = 0; offset < 20; offset += 1) {
      const candidate = basePort + offset;
      if (await BrowserHost.#free(candidate)) return candidate;
    }
    throw new Error(`No free local port between ${basePort} and ${basePort + 19} for the private browser.`);
  }

  #killChild() {
    if (this.child?.pid) {
      try {
        process.kill(this.child.pid);
      } catch {
        /* already gone */
      }
    }
    this.child = null;
  }

  /**
   * Prove the endpoint on this.port belongs to the browser launched here. DSH runs
   * its own Chromium with --remote-debugging-port, so attaching to whatever happens
   * to answer would drive the app's windows instead of a private browser. The
   * browser's own command line carries the profile directory it was started with,
   * which is exactly the proof needed.
   */
  async #endpointIsOurs() {
    let version;
    try {
      version = await this.#json('/json/version');
    } catch {
      return false;
    }
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) return this.child?.exitCode === null;

    let connection;
    try {
      connection = await CdpConnection.open(wsUrl, { timeoutMs: 6000 });
      const info = await connection.send('Browser.getBrowserCommandLine', {}, { timeoutMs: 6000 });
      const args = Array.isArray(info?.arguments) ? info.arguments : [];
      const dirArg = args.find((arg) => arg.startsWith('--user-data-dir='));
      const portArg = args.find((arg) => arg.startsWith('--remote-debugging-port='));
      if (!dirArg) return this.child?.exitCode === null;
      const normalize = (value) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
      if (normalize(dirArg.slice('--user-data-dir='.length)) !== normalize(this.profileDir)) return false;
      if (portArg && Number(portArg.split('=')[1]) !== this.port) return false;
      return true;
    } catch {
      // Older builds may not expose the command; fall back to process liveness.
      return this.child?.exitCode === null;
    } finally {
      connection?.close();
    }
  }

  /** Spawn one browser on this.port and wait for its debugging endpoint. */
  async #launch(exe) {
    this.#killChild();
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
      /* surfaced by the probe timeout below */
    });

    const version = await this.#probe(this.timeoutMs);
    if (!version) {
      throw new Error(
        `Chromium did not expose a debugging endpoint on port ${this.port} within ${this.timeoutMs}ms. ` +
          `Close any browser using the same profile (${this.profileDir}) and retry.`,
      );
    }
    return version;
  }

  async #start() {
    const exe = resolveBrowser(this.exePath);
    mkdirSync(this.profileDir, { recursive: true });

    let version = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !version; attempt += 1) {
      if (this.child && this.child.exitCode === null) {
        // Same session, browser already warm: reuse it.
        version = await this.#probe(3000);
        if (version) break;
        this.#killChild();
      }

      this.port = await this.#pickFreePort(this.port + attempt);
      try {
        version = await this.#launch(exe);
      } catch (error) {
        lastError = error;
        this.#killChild();
        continue;
      }

      // Whatever answered has to be the browser launched just now: DSH itself runs
      // with --remote-debugging-port, and attaching to that would drive the app's
      // own windows instead of a private browser.
      if (!(await this.#endpointIsOurs())) {
        lastError = new Error(
          `Port ${this.port} is held by another process, not the browser this session launched. ` +
            'Close that program and retry.',
        );
        this.#killChild();
        version = null;
      }
    }
    if (!version) throw lastError ?? new Error('The private browser could not be started.');

    const connection = await this.#connectPage();
    await this.#prepare(connection);

    this.connection = connection;
    // One browser-level socket owns downloads for every tab. Re-arming it on each cold
    // start would leak a socket and a second copy of every download event.
    if (!this.browserConnection || this.browserConnection.closed) {
      // Losing downloads must never cost the whole session: browsing still works, and
      // the doctor tool reports why the folder is not armed.
      await this.#watchDownloads().catch((error) => {
        this.downloadError = error;
        this.browserConnection?.close?.();
        this.browserConnection = null;
      });
    }
    await this.#rememberTabs();
    this.touch();
    return connection;
  }

  /**
   * Everything a freshly attached page target needs before it can be driven.
   *
   * Shared by the cold start and by every tab switch: a tab that was never prepared
   * has no dialog handler (one alert would park its renderer), no emulated viewport
   * (coordinates would stop matching the screenshots) and may be backgrounded, in
   * which case Chrome drops synthetic input without an error.
   */
  async #prepare(connection) {
    await connection.send('Page.enable', {}, { timeoutMs: 15000 }).catch(() => {});
    this.#watchDialogs(connection);
    await connection.send('Runtime.enable', {}, { timeoutMs: 15000 }).catch(() => {});
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
  }

  /** Record the current tab set, so the next check can tell which ones are new. */
  async #rememberTabs() {
    const tabs = await this.listTabs().catch(() => []);
    for (const tab of tabs) this.knownTabs.add(tab.id);
    return tabs;
  }

  /** Page targets only: devtools:// windows and service workers are not tabs to drive. */
  async listTabs() {
    const list = await this.#json('/json/list');
    const pages = (Array.isArray(list) ? list : []).filter(
      (entry) =>
        entry.type === 'page' &&
        entry.webSocketDebuggerUrl &&
        !String(entry.url || '').startsWith('devtools://') &&
        // Browser-owned UI (edge://downloads-hub, chrome://settings, …) is not a page
        // the model can do anything useful with, and following it silently moves the
        // session off the site. Edge opens one of these on *every* download, so this
        // is the difference between a working export and a session staring at
        // edge://downloads-hub.
        !/^(edge|chrome|chrome-untrusted|brave|vivaldi):/i.test(String(entry.url || '')),
    );
    return pages.map((entry) => ({
      id: String(entry.id),
      url: String(entry.url || ''),
      title: String(entry.title || ''),
      active: String(entry.id) === this.pageTargetId,
    }));
  }

  async #tabById(targetId) {
    const list = await this.#json('/json/list');
    const wanted = String(targetId);
    const hit = (Array.isArray(list) ? list : []).find((entry) => String(entry.id) === wanted);
    if (!hit) throw new Error(`No open tab with id ${wanted}. Call browser_tabs (action "list") to see the current ones.`);
    if (!hit.webSocketDebuggerUrl) {
      throw new Error(`Tab ${wanted} is not inspectable — it is probably closing.`);
    }
    return hit;
  }

  /** Attach the page session to another open tab. */
  async useTab(targetId) {
    const target = await this.#tabById(targetId);
    if (String(target.id) === this.pageTargetId && this.connection && !this.connection.closed) {
      this.touch();
      return this.connection;
    }
    const connection = await CdpConnection.open(target.webSocketDebuggerUrl);
    // A target can accept the socket and never answer (brand-new profile, renderer still
    // warming up). Without this probe the failure surfaces 40s later as a timeout inside
    // #prepare, on a session that is already half-attached.
    const alive = await connection
      .send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 6000 })
      .then((result) => result?.result?.value === 1)
      .catch(() => false);
    if (!alive) {
      connection.close();
      throw new Error(`Tab ${String(target.id)} accepted the socket but did not answer; try again or pick another tab.`);
    }
    await this.#prepare(connection);
    const previous = this.connection;
    this.connection = connection;
    this.pageTargetId = String(target.id);
    // Closed only after the new session answers, so a failed switch leaves the old tab
    // usable instead of stranding the session with no connection at all.
    if (previous && previous !== connection) previous.close();
    this.knownTabs.add(this.pageTargetId);
    this.touch();
    return connection;
  }

  /** Open a tab and (by default) make it the one the tools drive. */
  async newTab(url = 'about:blank', { activate = true } = {}) {
    await this.ensure();
    let targetId = null;
    // Preferred: the browser-level socket, which is already connected. The HTTP
    // endpoint is the fallback for the case where download arming failed.
    if (this.browserConnection && !this.browserConnection.closed) {
      try {
        const created = await this.browserConnection.send('Target.createTarget', { url }, { timeoutMs: 15000 });
        targetId = created?.targetId ?? null;
      } catch {
        targetId = null;
      }
    }
    if (!targetId) {
      const created = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(8000),
      });
      if (!created.ok) throw new Error(`Could not open a new tab (HTTP ${created.status}).`);
      const entry = await created.json();
      targetId = entry?.id ?? null;
    }
    if (!targetId) throw new Error('The browser did not return an id for the new tab.');
    this.knownTabs.add(String(targetId));
    if (!activate) return { id: String(targetId), url };

    // A target can take a moment to appear in /json/list and another to answer.
    const deadline = Date.now() + 6000;
    for (;;) {
      try {
        await this.useTab(targetId);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(120);
      }
    }
    return { id: String(targetId), url };
  }

  /**
   * Close a tab. Closing the one being driven leaves the session attached to nothing,
   * so it moves to another open tab (or a fresh one) instead of breaking every later
   * call with "socket closed".
   */
  async closeTab(targetId) {
    const id = String(targetId);
    const wasCurrent = id === this.pageTargetId;
    let closed = false;
    if (this.browserConnection && !this.browserConnection.closed) {
      try {
        const result = await this.browserConnection.send('Target.closeTarget', { targetId: id }, { timeoutMs: 10000 });
        closed = result?.success !== false;
      } catch {
        closed = false;
      }
    }
    if (!closed) {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      closed = Boolean(response?.ok);
    }
    if (!closed) throw new Error(`The browser refused to close tab ${id}. It may already be gone — list them with browser_tabs.`);
    this.knownTabs.delete(id);

    if (wasCurrent) {
      this.connection?.close();
      this.connection = null;
      this.pageTargetId = null;
      await sleep(150); // let the target disappear from /json/list first
      const left = await this.listTabs().catch(() => []);
      if (left.length > 0) await this.useTab(left[0].id);
      else await this.ensure(); // no tab at all: #pageTarget creates one
    }
    return { closed: id, remaining: (await this.listTabs().catch(() => [])).length };
  }

  /**
   * Arm downloads and keep a record of them.
   *
   * A private browser discards downloads unless it is told where to put them, so
   * clicking "Export CSV" succeeds and nothing ever arrives — indistinguishable from a
   * broken button. `Browser.setDownloadBehavior` lives on the browser-level target,
   * hence this second socket, and `eventsEnabled` is what makes Chrome report what it
   * did instead of keeping it to itself. A second socket is also why the page session
   * is untouched: download bookkeeping cannot stall input commands.
   */
  async #watchDownloads() {
    const version = await this.#json('/json/version');
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('the browser endpoint advertises no browser-level websocket');
    mkdirSync(this.downloadDir, { recursive: true });

    const browser = await CdpConnection.open(wsUrl, { timeoutMs: 8000 });
    browser.downloads = [];

    browser.on('Browser.downloadWillBegin', (params) => {
      browser.downloads.push({
        guid: String(params?.guid ?? ''),
        url: String(params?.url ?? ''),
        suggestedFilename: String(params?.suggestedFilename || 'download'),
        state: 'inProgress',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        finishedAt: null,
        path: null,
        reportedState: null,
      });
      // A page that fetches in a loop must not grow this array forever.
      if (browser.downloads.length > 40) browser.downloads.splice(0, browser.downloads.length - 40);
    });

    browser.on('Browser.downloadProgress', (params) => {
      const entry = browser.downloads.find((item) => item.guid === params?.guid);
      if (!entry) return;
      entry.receivedBytes = Number(params?.receivedBytes ?? entry.receivedBytes);
      entry.totalBytes = Number(params?.totalBytes ?? entry.totalBytes);
      if (params?.state === 'completed') {
        entry.state = 'completed';
        entry.finishedAt = Date.now();
      } else if (params?.state === 'canceled') {
        entry.state = 'canceled';
        entry.finishedAt = Date.now();
      }
    });

    await browser.send(
      'Browser.setDownloadBehavior',
      // `allowAndName` saves each download under its guid. `allow` looks friendlier but
      // silently *overwrites* the previous file when the name repeats — two "export"
      // clicks then leave one file behind. Guids never collide, and #refreshPaths
      // renames the finished file to its readable name (adding " (1)" if needed).
      { behavior: 'allowAndName', downloadPath: this.downloadDir, eventsEnabled: true },
      { timeoutMs: 8000 },
    );

    this.browserConnection = browser;
    this.downloadError = null;
  }

  /** `report.csv`, then `report (1).csv`, … — never overwrite an earlier download. */
  #uniquePath(suggested) {
    // Chrome usually sanitises the suggested name already; do it once more because the
    // name comes from a response header, not from us, and this has to be a legal path.
    const base = basename(String(suggested || 'download').replace(/[\\/:*?"<>|]/g, '_')) || 'download';
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    let candidate = join(this.downloadDir, base);
    for (let n = 1; existsSync(candidate) && n < 1000; n += 1) {
      candidate = join(this.downloadDir, `${stem} (${n})${ext}`);
    }
    return candidate;
  }

  /**
   * Give a finished download its readable name and remember where it went.
   *
   * The protocol reports the suggested filename but never the final path, and says
   * `completed` a few milliseconds before the file is actually renamed into place, so
   * this runs lazily: an entry whose file is not there yet simply stays unresolved and
   * the next read tries again.
   */
  #refreshPaths() {
    const browser = this.browserConnection;
    const list = browser?.downloads;
    if (!Array.isArray(list) || list.length === 0) return;

    for (const entry of list) {
      if (entry.state !== 'completed' || entry.path) continue;
      const source = join(this.downloadDir, entry.guid);
      if (!existsSync(source)) continue;
      const target = this.#uniquePath(entry.suggestedFilename || 'download');
      try {
        renameSync(source, target);
        entry.path = target;
      } catch {
        // Locked or gone: leave it unresolved and retry on the next read.
        continue;
      }
      try {
        entry.bytes = statSync(target).size;
      } catch {
        /* keep the byte count the progress events reported */
      }
    }
  }

  /** Download records for this session, newest last, with completion paths resolved. */
  downloads() {
    this.#refreshPaths();
    return this.browserConnection?.downloads ?? [];
  }

  /** Block until nothing is downloading any more, or the budget runs out. */
  async waitForDownloads(timeoutMs = 30000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      this.#refreshPaths();
      const list = this.browserConnection?.downloads ?? [];
      if (!list.some((item) => item.state === 'inProgress')) {
        // Chrome reports `completed` a few milliseconds before it finishes renaming the
        // half-written file to its final name (`report (1).csv` when it collided), so a
        // path read right now can come back empty. Wait that rename out once, here,
        // rather than making every caller poll for it.
        const settleBy = Date.now() + 800;
        while (Date.now() < settleBy && list.some((item) => item.state === 'completed' && !item.path)) {
          await sleep(80);
          this.#refreshPaths();
        }
        return this.browserConnection?.downloads ?? [];
      }
      if (Date.now() >= deadline) return list;
      await sleep(150);
    }
  }

  /**
   * Files sitting in the download folder, newest first.
   *
   * Downloads outlive the browser process (the idle reaper closes it), so when this
   * session has no records the folder itself is still the honest answer to "did
   * anything get downloaded".
   */
  recentDownloads(limit = 10) {
    let names;
    try {
      names = readdirSync(this.downloadDir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (name.endsWith('.crdownload')) continue;
      const full = join(this.downloadDir, name);
      try {
        const info = statSync(full);
        if (info.isFile()) files.push({ path: full, name, bytes: info.size, at: info.mtimeMs });
      } catch {
        /* vanished between listing and stat */
      }
    }
    files.sort((a, b) => b.at - a.at);
    return files.slice(0, limit);
  }

  /**
   * Answer JS dialogs as they open, and keep a record of what they said.
   *
   * One `alert()` left unanswered parks the renderer: every later command — including
   * the screenshot the agent would use to find out why — times out. The reply is
   * deliberately fire-and-forget, because awaiting it would queue behind the very
   * dialog it is trying to close.
   */
  #watchDialogs(connection) {
    if (!Array.isArray(connection.dialogs)) connection.dialogs = [];
    connection.on('Page.javascriptDialogOpening', (params) => {
      const accept = this.dialogBehavior !== 'dismiss';
      connection.dialogs.push({
        type: String(params?.type ?? 'alert'),
        message: String(params?.message ?? ''),
        accepted: accept,
        url: params?.url,
        at: Date.now(),
      });
      connection
        .send(
          'Page.handleJavaScriptDialog',
          accept ? { accept: true, promptText: this.dialogPromptText } : { accept: false },
          { timeoutMs: 8000 },
        )
        .catch(() => {
          /* already dismissed (navigation, page closed) */
        });
    });
  }

  /**
   * Connect to a page target and prove it answers. A brand-new profile can hand out
   * a target whose renderer is still warming up: it accepts the socket and never
   * replies, so retry with a fresh target instead of failing the whole session.
   */
  async #connectPage() {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(700);
      let connection;
      try {
        const target = await this.#pageTarget();
        connection = await CdpConnection.open(target.webSocketDebuggerUrl);
        const alive = await connection
          .send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 6000 })
          .then((result) => result?.result?.value === 1)
          .catch(() => false);
        if (alive) {
          this.pageTargetId = target.id ? String(target.id) : null;
          return connection;
        }
        lastError = new Error(
          `CDP page target ${target.id ?? '(unknown)'} accepted the socket but did not answer commands.`,
        );
      } catch (error) {
        lastError = error;
      }
      connection?.close();
    }
    throw new Error(
      `${lastError?.message ?? 'The private browser did not accept a CDP session.'} ` +
        `Close any browser using the profile ${this.profileDir} and try again.`,
    );
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
    if (this.browserConnection) {
      this.browserConnection.close();
      this.browserConnection = null;
    }
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.pageTargetId = null;
    this.knownTabs.clear();
  }

  /** Terminate the private browser. */
  async shutdown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
