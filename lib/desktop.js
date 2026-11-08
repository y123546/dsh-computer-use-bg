/**
 * Client for the Win32 desktop agent (helpers/desktop-agent.py).
 *
 * One python process per plugin session, driven by newline-delimited JSON over
 * stdin/stdout — the same shape as CDP, which keeps the tool layer free of another
 * protocol. Requests are serialised: the agent answers in order, and a second
 * command interleaved mid-answer would be impossible to attribute.
 *
 * Python is a real dependency and is treated as one: it is looked for lazily (the
 * first desktop_* call, not at plugin load), each candidate is *proven* to import
 * ctypes before being used, and the failure message says exactly what was tried.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE = 'import sys, ctypes; print(sys.version.split()[0]); print(ctypes.sizeof(ctypes.c_void_p))';

/** The helper script, next to this module. */
export function helperPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'desktop-agent.py');
}

/**
 * Pythons that ship *with* the host.
 *
 * DSH bundles a full CPython for its runtime dependencies, so the desktop plane works
 * on a fresh install without asking the user to install anything. Looking here first
 * also means the version is one the host is already known to support.
 */
function bundledPythons() {
  const found = [];
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const roots = [join(home, 'dsh-runtimes')];
  for (const root of roots) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      for (const exe of ['python.exe', 'python3.exe']) {
        const candidate = join(root, name, 'dependencies', 'python', exe);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

function run(exe, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, reason: error.message });
      return;
    }
    child.on('error', (error) => finish({ ok: false, reason: error.code === 'ENOENT' ? 'not installed' : error.message }));
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      finish({ ok: code === 0 && stdout.trim().length > 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

/**
 * Find a python that can import ctypes.
 *
 * `python` on Windows is often the Microsoft Store stub: it exists, it runs, and it
 * prints an advert instead of a version. Running the probe is the only honest test.
 */
export async function findPython({ explicit } = {}) {
  const candidates = [];
  if (explicit) candidates.push({ exe: explicit, args: [] });
  if (process.env.DSH_BG_CU_PYTHON) candidates.push({ exe: process.env.DSH_BG_CU_PYTHON, args: [] });
  for (const exe of bundledPythons()) candidates.push({ exe, args: [] });
  candidates.push({ exe: 'python', args: [] }, { exe: 'python3', args: [] }, { exe: 'py', args: ['-3'] });

  const tried = [];
  for (const candidate of candidates) {
    const result = await run(candidate.exe, [...candidate.args, '-c', PROBE]);
    if (result.ok) {
      const [version, pointer] = result.stdout.split(/\r?\n/);
      return { ...candidate, version, bits: Number(pointer) === 8 ? 64 : 32, tried };
    }
    tried.push(`${candidate.exe}${candidate.args.length ? ` ${candidate.args.join(' ')}` : ''}: ${result.reason ?? result.stderr?.split('\n')[0] ?? `exit ${result.code}`}`);
  }
  throw new Error(
    'No usable Python 3 was found for the desktop plane (it needs the standard library only). ' +
      `Tried: ${tried.join('; ')}. Install Python 3, or set pythonPath (or DSH_BG_CU_PYTHON) to python.exe.`,
  );
}

export class DesktopHost {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath;
    this.helper = options.helperPath ?? helperPath();
    this.timeoutMs = Number(options.timeoutMs ?? 25000);
    // Same reasoning as the browser's idle reaper: nobody should have to remember to
    // close a python process (and whatever desktops it owns) after a run.
    this.idleMs = Number(options.idleMs ?? 300000);
    this.child = null;
    this.starting = null;
    this.buffer = '';
    this.pending = [];
    this.stderr = '';
    this.python = null;
    this.exited = null;
    this.isolated = new Map();
    this.idleTimer = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  /** Reset the idle countdown; a helper that nobody asks anything should not survive. */
  #touch() {
    if (!this.idleMs || this.idleMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.stop().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async ensure() {
    if (this.running) return this.python;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    if (!existsSync(this.helper)) throw new Error(`The desktop helper is missing from the install: ${this.helper}`);
    this.python = this.python ?? (await findPython({ explicit: this.pythonPath }));
    this.buffer = '';
    this.stderr = '';

    const child = spawn(this.python.exe, [...this.python.args, this.helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    // Deliberately unref'd: the helper must never be the reason a host process cannot
    // exit. Reading still works — unref only takes these handles off the loop's ref
    // count.
    child.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    child.stdin.unref?.();
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('error', (error) => this.#failAll(`the desktop helper could not start: ${error.message}`));
    child.on('close', (code) => {
      const tail = this.stderr.trim().split('\n').slice(-3).join(' | ');
      this.#failAll(`the desktop helper exited (code ${code})${tail ? `: ${tail}` : ''}`);
      this.child = null;
    });

    const ping = await this.request({ cmd: 'ping' }, 15000);
    this.exited = null;
    return { ...this.python, ping };
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a stray print from a library must not break the protocol
      }
      const waiter = this.pending.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || 'the desktop helper failed without saying why'));
    }
  }

  #failAll(reason) {
    const waiters = this.pending.splice(0, this.pending.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }

  /** One request, one answer, in order. */
  async request(payload, timeoutMs = this.timeoutMs) {
    if (!this.running && payload.cmd !== 'ping') throw new Error('the desktop helper is not running');
    this.#touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(
          new Error(
            `the desktop helper did not answer "${payload.cmd}" within ${timeoutMs}ms — the target app may be hung`,
          ),
        );
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async call(payload, timeoutMs) {
    await this.ensure();
    return this.request(payload, timeoutMs);
  }

  // --- typed helpers -------------------------------------------------------

  async windows({ process: processFilter, desktop } = {}) {
    const payload = { cmd: 'windows' };
    if (desktop) payload.desktop = desktop;
    if (processFilter) payload.process = processFilter;
    const result = await this.call(payload, 20000);
    return { windows: Array.isArray(result?.windows) ? result.windows : [], desktop: result?.desktop ?? null };
  }

  /**
   * Look for something in a window that has no control tree: by its text or its colour.
   *
   * Slow by nature (one OCR pass spawns a script host), so it is a deliberate call rather
   * than something every action pays for.
   */
  async find({ window: windowId, text, color, region, tolerance, max, desktop }) {
    const payload = { cmd: 'find', window: windowId };
    if (text) payload.text = String(text);
    if (color) payload.color = String(color);
    if (region && typeof region === 'object') payload.region = region;
    if (Number.isFinite(Number(tolerance))) payload.tolerance = Number(tolerance);
    if (Number.isFinite(Number(max))) payload.max = Number(max);
    if (desktop) payload.desktop = desktop;
    return this.call(payload, 60000);
  }

  async tree({ window: windowId, desktop, max, engine }) {
    const payload = { cmd: 'tree', window: windowId };
    if (desktop) payload.desktop = desktop;
    if (Number.isFinite(Number(max)) && Number(max) > 0) payload.max = Math.min(1000, Number(max));
    if (engine === 'uia' || engine === 'win32') payload.engine = engine;
    return this.call(payload, 30000);
  }

  async read({ target, desktop }) {
    const payload = { cmd: 'read', target };
    if (desktop) payload.desktop = desktop;
    return this.call(payload, 15000);
  }

  async act(payload, { desktop } = {}) {
    const body = { ...payload, cmd: 'act' };
    if (desktop) body.desktop = desktop;
    return this.call(body, 20000);
  }

  async shot({ window: windowId, path, desktop, grid }) {
    const payload = { cmd: 'shot', window: windowId, path };
    if (desktop) payload.desktop = desktop;
    if (grid) payload.grid = true;
    return this.call(payload, 30000);
  }

  async desktops() {
    const result = await this.call({ cmd: 'desktops' }, 10000);
    return Array.isArray(result?.isolated) ? result.isolated : [];
  }

  /**
   * Start a program, on an isolated desktop by default.
   *
   * Isolation is the whole point of the desktop plane: the app gets its own invisible
   * desktop, so its windows never cover the user's screen and it can never steal the
   * foreground. A few installers and some UWP-launched apps refuse to run on a
   * non-interactive desktop; the caller can ask for the real one explicitly.
   */
  async launch({ path, args = [], isolated = true, name }) {
    const payload = { cmd: 'launch', path, args };
    if (isolated) {
      payload.isolated = true;
      if (name) payload.name = name;
    }
    const result = await this.call(payload, 45000);
    if (result?.desktop) this.isolated.set(result.desktop, { name: result.desktop, pid: result.pid });
    return result;
  }

  /**
   * Wait for a freshly launched program to own a visible window.
   *
   * A process answers CreateProcess long before it has a window, and a caller that
   * reads the window list immediately would see nothing and conclude the launch
   * failed.
   */
  async waitForWindow({ pid, desktop, timeoutMs = 12000 }) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    for (;;) {
      const { windows } = await this.windows({ desktop }).catch(() => ({ windows: [] }));
      // A process can own several windows (a hidden message-only one, a splash); the
      // biggest is the one worth reporting.
      const mine = windows
        .filter((item) => item.pid === pid)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      if (mine.length > 0) return mine[0];
      if (Date.now() >= deadline) return null;
      await sleep(250);
    }
  }

  async kill({ pid, desktop }) {
    const payload = { cmd: 'kill', pid };
    if (desktop) payload.desktop = desktop;
    return this.call(payload, 15000);
  }

  async stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.running) return;
    try {
      await this.request({ cmd: 'quit' }, 4000);
    } catch {
      /* fall through to the kill below */
    }
    await sleep(120);
    if (this.running) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
    this.child = null;
    this.pending = [];
  }
}
