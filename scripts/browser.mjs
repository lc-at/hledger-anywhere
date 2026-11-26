// The browser the checks drive: found, launched, and spoken to over the DevTools protocol.
//
// Three checks put a page in headless Chrome — check-app boots the built app,
// check-plugin-windows opens every plugin window, check-plugin-freshness holds the service
// worker's promises to account — and each used to carry its own copy of this. The copies had
// drifted while they sat side by side: the window check's Chrome search stopped at PATH and
// never reached agent-browser's install, so on a machine whose Chrome lives behind a wrapper
// it could only run with CHROME set; and its poll answered a timeout with `undefined`, so a
// wait that never ended failed later under an assertion with nothing to do with it.
//
// What the three genuinely share is here: `findChrome`, `launch`, the `Protocol` socket with
// its sessions flattened into it, a `Tab` to open and drive, and `until`, which always names
// what it waited for. Everything else stays in the checks, because it differs on purpose:
// each one's server (a dist, a routes table, cache headers GitHub Pages sends), each one's
// `check()` (different counters, different contracts), and the parts of a page only one of
// them drives.

import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where Chrome is: `CHROME` when it is set, then anything PATH answers to a browser's name,
 * then agent-browser's own install — its wrapper first, because the raw browser under
 * `browsers/` links against libraries only the wrapper sets up, and nothing pins a version.
 * No Chrome anywhere is said out loud rather than spawned into ENOENT.
 */
export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const found = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      // not this one
    }
  }
  try {
    const wrapper = join(process.env.HOME || '', '.local', 'bin', 'agent-browser-chrome');
    accessSync(wrapper, constants.X_OK);
    return wrapper;
  } catch {
    // no wrapper
  }
  try {
    const browsers = readdirSync(join(process.env.HOME || '', '.agent-browser', 'browsers'))
      .filter((entry) => entry.startsWith('chrome-'))
      .sort();
    const latest = browsers[browsers.length - 1];
    if (latest) return join(process.env.HOME, '.agent-browser', 'browsers', latest, 'chrome');
  } catch {
    // no agent-browser either
  }
  throw new Error('no Chrome found: put google-chrome or chromium on PATH, or set CHROME=/path/to/chrome');
}

/** The DevTools protocol over one socket, with sessions flattened into it. */
export class Protocol {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = message.id && this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
        else waiting.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    };
  }

  send(method, params = {}, sessionId) {
    const id = (this.id += 1);
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Chrome headless on its own profile and debugging port, and the socket it answers on.
 *
 * `windowSize` is the window Chrome opens with. `extraArgs` is for a flag only one check
 * needs — the freshness check lets pop-ups through for the window a plugin opens — and
 * `env` for the environment one check has to add around Chrome's own, the window check
 * pointing it at a bundled fontconfig on a machine with no fonts of its own. `profile` is
 * the user-data directory: brought by the checks that clean one up, made here otherwise.
 *
 * The port comes back beside the socket, because the freshness check reaches a second
 * target — the service worker — over Chrome's HTTP endpoint rather than over the socket.
 */
export async function launch(chrome, { windowSize, extraArgs = [], env, profile } = {}) {
  const dir = profile || await mkdtemp(join(tmpdir(), 'hla-chrome-'));
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${dir}`, `--window-size=${windowSize}`, ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(env || {}) } });
  const url = await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${seen}`)), 30000);
    child.stderr.on('data', (chunk) => {
      seen += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${seen}`)));
  });
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return { child, cdp: new Protocol(socket), port: Number(new URL(url).port), profile: dir };
}

/**
 * Poll `fn` until it answers truthy, and name what was being waited for when it never does.
 *
 * Every wait goes through this one: a wait that runs out of time has to fail under its own
 * name, at once, rather than later as an assertion nobody can connect back to it.
 */
export async function until(label, fn, { timeoutMs = 30000, pollMs = 60 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(pollMs);
  }
}

/** The load event one tab's session is waiting for: what a navigation or a reload ends on. */
function loaded(cdp, sessionId, timeoutMs, label) {
  const fired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(label));
    }, timeoutMs);
    const stop = cdp.on((message) => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  });
  fired.catch(() => {});
  return fired;
}

/**
 * One tab: open it, navigate, evaluate, and wait for what the page is about to show.
 *
 * A check that needs more — its own viewport height, a shorter default wait, a listener for
 * the dialogs or exceptions its page raises — passes it in rather than forking the class;
 * the parts of a page only one check drives belong to that check's subclass.
 */
export class Tab {
  /**
   * A new target on `cdp`, attached with its session flattened into the socket.
   *
   * `width` and `height` set the viewport, which is also the ceiling what the page draws can
   * fit under; a check that reads a long page sets it tall enough to read. `timeoutMs` is
   * how long this tab's `until` waits when a call does not say. `onEvent` is called with the
   * tab and each message of its session, before anything is enabled, for a check that
   * answers dialogs or records exceptions.
   */
  static async open(cdp, { width, height, timeoutMs, onEvent, ...options } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new this(cdp, sessionId, { ...options, timeoutMs });
    if (onEvent) cdp.on((message) => { if (message.sessionId === sessionId) onEvent(tab, message); });
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    if (width && height) {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    }
    return tab;
  }

  constructor(cdp, sessionId, { timeoutMs = 30000 } = {}) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /**
   * An expression evaluated in the page: its value comes back, and anything that cannot
   * travel by value — a Node, the window, a function — is dropped rather than failing the
   * call. An expression that throws fails here, under itself.
   */
  async eval(expression) {
    const wrapped = `(async () => { const value = await (${expression}); return value instanceof Node || value === window || typeof value === 'function' ? undefined : value; })()`;
    const result = await this.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  /**
   * Poll an expression until it is truthy, and say what was being waited for.
   *
   * `what` names it; a number in its place is the timeout alone, and leaves the expression
   * as the name. The timeout a tab was opened with applies when neither gives one.
   */
  until(expression, what, options = {}) {
    if (typeof what === 'number') options = { ...options, timeoutMs: what };
    const label = typeof what === 'string' ? what : expression;
    return until(label, () => this.eval(expression), { timeoutMs: this.timeoutMs, ...options });
  }

  /** A load, ended by the event rather than by a readyState that was already complete. */
  navigate(url, { timeoutMs = 30000, label = 'the page never finished loading' } = {}) {
    const fired = loaded(this.cdp, this.sessionId, timeoutMs, label);
    return this.send('Page.navigate', { url }).then(() => fired);
  }

  /** A reload, ended the same way. */
  reload({ timeoutMs = 30000, label = 'the page never finished loading' } = {}) {
    const fired = loaded(this.cdp, this.sessionId, timeoutMs, label);
    return this.send('Page.reload', { ignoreCache: false }).then(() => fired);
  }
}
