// Checks the plugins' windows in a real browser: every chart drawn and every way of using one,
// and the editor opening, saving, and refusing to.
//
// scripts/check-example-plugin.mjs checks what can be checked without a browser: commands,
// parsers, models, layouts. What it cannot reach is the half of the plugin that touches the
// DOM (the renderers, the tooltip, the legend, the keys, saving, drill-down), and that half
// is most of the code. This drives headless Chrome over the DevTools protocol against the
// window `page()` writes, with input events a person would make, and measures how much of the
// plugin's code the run executed.
//
// The engine is not needed: each window is written from the fixtures in chart-fixtures.mjs,
// which are the engine's own CSV, exactly as the plugin would write it after asking hledger.
// Drill-down asks the opener for another report, so the opener is stood in for.
//
// Coverage is of the whole plugin suite: this check's browser and its own process, which writes
// the pages, merged with a run of check-example-plugin.mjs, which it starts itself. Each file
// must be mostly executed, so code that no check reaches shows up as a failing number.
//
// Run with: node scripts/check-plugin-windows.mjs
// Chrome is found on PATH (google-chrome, chromium) or named with CHROME=/path/to/chrome.
// Node 22 or later, for its built-in WebSocket.
//
// On a machine with no fonts of its own, a bundled fontconfig is used if one is around; a
// Chrome that cannot find its shared libraries needs LD_LIBRARY_PATH pointing at them.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import inspector from 'node:inspector/promises';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUDGET_CSV, COLORS, DARK, FLOWS_CSV, FLOWS_MONTHS_CSV, MONTHLY_CSV, RANKING_CSV, REGISTER_CSV, TREE_CSV, TREE_MONTHS_CSV, dailyCsv } from './chart-fixtures.mjs';

// This process writes every page, so its own coverage counts: it is measured from before the
// plugin's modules are loaded, which is why they are imported here and not above.
const self = new inspector.Session();
self.connect();
await self.post('Profiler.enable');
await self.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const { page } = await import('../assets/plugins/chart-window.js');
const { build, parseReport } = await import('../assets/plugins/chart.js');
const { page: editPage } = await import('../assets/plugins/edit-window.js');
const { page: reconcilePage } = await import('../assets/plugins/reconcile-window.js');
const { readPrint: readReconcile } = await import('../assets/plugins/reconcile-data.js');
const { RECONCILE_JOURNAL, RECONCILE_PRINT } = await import('./reconcile-fixtures.mjs');
const RECONCILE_DATA = readReconcile(RECONCILE_PRINT, 'Assets:Bank:Checking');
// Each row carries its transaction's text, as the plugin gives it, for the editor.
for (const row of RECONCILE_DATA.rows) {
  row.text = RECONCILE_JOURNAL.split('\n').slice(row.where.first - 1, row.where.last - 1).join('\n').replace(/\s+$/, '');
}

const PLUGINS = fileURLToPath(new URL('../assets/plugins/', import.meta.url));
const MEASURED = ['reconcile.js', 'reconcile-data.js', 'reconcile-window.js', 'chart.js', 'chart-args.js', 'chart-d3.js', 'chart-more.js', 'chart-play.js', 'chart-ui.js', 'chart-window.js', 'chart-data.js', 'edit.js', 'edit-window.js', 'window-kit.js'];
/** The least each measured file's code may be executed, as a share of its source. */
const FLOOR = 0.9;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ the windows

/**
 * Each case is one window: a chart line and a report in the engine's shape. The window is
 * written from `build(line)`, the plugin's own reading of the line, so its type, options, title,
 * command and related charts are what a user typing `chart <line>` would get.
 */
const SINGLE_CSV = MONTHLY_CSV.split('\n').filter((row) => !/coffee|books/.test(row)).join('\n');
const CASES = {
  line: { line: 'line expenses', csv: MONTHLY_CSV },
  daily: { line: 'line -D expenses', csv: dailyCsv(40) },
  single: { line: '--cumulative line expenses:housing:rent', csv: SINGLE_CSV },
  loglines: { line: '--log --top 2 line expenses', csv: MONTHLY_CSV },
  stacked: { line: '--percent stacked expenses', csv: MONTHLY_CSV },
  bar: { line: 'bar expenses', csv: RANKING_CSV },
  columns: { line: '--log bar -M expenses', csv: MONTHLY_CSV },
  doughnut: { line: '--top 2 pie expenses', csv: RANKING_CSV },
  treemap: { line: 'treemap expenses', csv: TREE_CSV },
  calendar: { line: 'calendar', csv: REGISTER_CSV },
  waterfall: { line: 'waterfall', csv: REGISTER_CSV },
  multiples: { line: '--log --sort name multiples', csv: MONTHLY_CSV },
  sankey: { line: '--top 1 sankey', csv: FLOWS_CSV },
  heatmap: { line: '--log heatmap expenses', csv: MONTHLY_CSV },
  bump: { line: 'bump expenses', csv: MONTHLY_CSV },
  stream: { line: 'stream expenses', csv: MONTHLY_CSV },
  sunburst: { line: 'sunburst expenses', csv: TREE_CSV },
  race: { line: '--animate --cumulative --top 2 bar expenses', csv: MONTHLY_CSV },
  playtree: { line: '--animate treemap expenses', csv: TREE_MONTHS_CSV },
  playburst: { line: '--animate --cumulative sunburst expenses', csv: TREE_MONTHS_CSV },
  playflows: { line: '--animate sankey', csv: FLOWS_MONTHS_CSV },
  playpie: { line: '--animate pie expenses', csv: MONTHLY_CSV },
  cashflow: { line: 'cashflow', csv: FLOWS_MONTHS_CSV },
  budget: { line: 'budget', csv: BUDGET_CSV },
  swarm: { line: 'swarm', csv: REGISTER_CSV },
  histogram: { line: 'histogram', csv: REGISTER_CSV },
  pack: { line: 'pack expenses', csv: TREE_CSV },
  playpack: { line: '--animate pack expenses', csv: TREE_MONTHS_CSV },
};

function windowFor(name, theme, { library = true } = {}) {
  const entry = CASES[name];
  const query = build(entry.line);
  return page({
    report: parseReport(query.kind, entry.csv, query.options),
    colors: theme === 'dark' ? DARK : COLORS,
    title: query.title,
    command: query.command,
    token: 'check',
    kind: query.kind,
    options: query.options,
    args: query.args,
    related: query.related,
    module: '/plugins/chart-window.js',
    scripts: library ? ['/plugins/vendor/d3/d3.min.js'] : [],
  });
}

/**
 * What following a mark or a link gets back. The window asks the opener's bridge for a chart
 * line; the answer is a monthly line chart titled with the line it was asked for, so a check
 * can see which line was asked.
 */
const ANSWER = {
  report: parseReport('line', MONTHLY_CSV.replace('expenses:food:coffee', 'expenses:drilled')),
  command: 'balance expenses:drilled -M -O csv',
  options: {},
  kind: 'line',
  related: [],
};

// The page a window was opened by, stood in for: a chart bridge that records what it was asked
// and answers with ANSWER, after a moment, as hledger would; and an editor bridge that records
// what was saved, or refuses the way the app does when the file changed on disk.
const OPENER = `
  window.__asked = [];
  window.__previewed = [];
  window.__applied = [];
  window.__writable = !/writable=no/.test(location.search);
  window.__saved = [];
  window.__refuse = '';
  Object.defineProperty(window, 'opener', { configurable: true, value: {
    __chartBridges: { check: {
      async requery(args) {
        window.__asked.push(args);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...${JSON.stringify(ANSWER)}, title: args, args };
      },
    } },
    __reconcileBridges: { check: {
      // The plugin's side, stood in for: a preview of the marks and the assertion, and an
      // apply that answers with the account as it would be read back, ticks marked.
      preview(request) {
        window.__previewed.push(request);
        window.__lastPreview = request;
        return {
          files: [{ path: 'fixture.journal', changes: request.ticked.map((id, index) => ({ line: 9 + index, before: '    Assets:Bank:Checking', after: '  * Assets:Bank:Checking', id })),
            appended: request.finish ? '2026-09-30 * Reconciled with statement\\n    Assets:Bank:Checking    0.00 IDR = 5670000.00 IDR\\n' : '',
            replaced: Object.entries(request.edits || {}).map(([id, edit], at) => ({ line: 7 + at * 4, before: 'old text\\n    of it', after: edit.text })),
            inserted: (request.inserts || []).map((insert) => ({ line: 24, text: insert.text })) }],
          missing: [],
          writable: [{ path: 'fixture.journal', writable: window.__writable }],
        };
      },
      async apply(request) {
        window.__applied.push(request);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (window.__refuse) return { error: window.__refuse };
        const data = JSON.parse(document.getElementById('reconcile-data').textContent).data;
        for (const row of data.rows) row.status = request.ticked.includes(row.id) ? 'Cleared' : row.status;
        return { ok: true, message: 'Assets:Bank:Checking reconciled to 2026-09-30', data, fingerprint: 'after' };
      },
    } },
    __editBridges: { check: {
      async save(text) {
        if (window.__refuse) throw new Error(window.__refuse);
        window.__saved.push(text);
        return true;
      },
    } },
  } });
`;

/** The editor's window, for a file that may or may not have somewhere to be saved. */
function editorFor(writable, theme, { library = true } = {}) {
  return editPage({
    path: 'hledger.journal',
    contents: '2024-01-01 * opening\n    assets:bank  $100\n    equity\n',
    writable,
    colors: theme === 'dark' ? DARK : COLORS,
    token: 'check',
    module: '/plugins/edit-window.js',
    scripts: library ? ['/plugins/vendor/ace/ace.js'] : [],
  });
}

// ------------------------------------------------------------------ a server and a browser

function serve() {
  const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://check');
    if (url.pathname === '/edit') {
      response.writeHead(200, { 'content-type': types['.html'] });
      response.end(editorFor(url.searchParams.get('writable') === 'yes', url.searchParams.get('theme'), {
        library: url.searchParams.get('library') !== 'no',
      }));
      return;
    }
    if (url.pathname === '/reconcile') {
      response.writeHead(200, { 'content-type': types['.html'] });
      const theme = url.searchParams.get('theme');
      response.end(reconcilePage({
        data: RECONCILE_DATA, colors: theme === 'dark' ? DARK : COLORS, token: 'check',
        files: [{ path: 'fixture.journal', writable: url.searchParams.get('writable') !== 'no' }],
        statementDate: '2026-09-30', statementBalance: url.searchParams.get('balance') || '', fingerprint: 'before',
        module: '/plugins/reconcile-window.js',
      }));
      return;
    }
    if (url.pathname === '/window') {
      response.writeHead(200, { 'content-type': types['.html'] });
      response.end(windowFor(url.searchParams.get('case'), url.searchParams.get('theme'), {
        library: url.searchParams.get('library') !== 'no',
      }));
      return;
    }
    if (url.pathname.startsWith('/plugins/')) {
      const path = join(PLUGINS, normalize(url.pathname.slice('/plugins/'.length)));
      try {
        const body = await readFile(path);
        response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
        response.end(body);
        return;
      } catch {
        // falls through to the 404
      }
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * Fonts for a machine that has none of its own.
 *
 * Without a font every piece of text lays out 0 pixels high, so elements are found but cannot
 * be clicked and the run fails somewhere unrelated. A host with fonts is left alone; otherwise
 * a bundled fontconfig is used if one is around, which is what agent-browser installs.
 */
function fontEnvironment() {
  if (process.env.FONTCONFIG_FILE) return {};
  for (const directory of ['/usr/share/fonts', '/usr/local/share/fonts']) {
    try {
      if (readdirSync(directory).length) return {};
    } catch {
      // no such directory: keep looking
    }
  }
  const deps = join(process.env.HOME || '', '.local/share/agent-browser-deps/builds');
  let builds = [];
  try {
    builds = readdirSync(deps).sort().reverse();
  } catch {
    return {};
  }
  for (const build of builds) {
    const configuration = join(deps, build, 'etc-fonts/fonts.conf');
    try {
      statSync(configuration);
      return { FONTCONFIG_FILE: configuration, FONTCONFIG_PATH: join(deps, build, 'etc-fonts'), XDG_DATA_HOME: join(deps, build) };
    } catch {
      // not this one
    }
  }
  return {};
}

async function launch(chrome, profile) {
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1100,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...fontEnvironment() } });
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
  return { child, cdp: new Protocol(socket) };
}

/** The DevTools protocol over one socket, with sessions flattened into it. */
class Protocol {
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

/** One tab: navigate, evaluate, and make the input events a person would. */
class Tab {
  static async open(cdp, base) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, base);
    tab.errors = [];
    tab.dialogs = [];
    cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      // The editor asks before a page with unsaved changes is left. A headless browser would
      // wait on that question forever, so it is answered, and remembered for the check.
      if (message.method === 'Page.javascriptDialogOpening') {
        tab.dialogs.push(message.params.type);
        tab.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        tab.errors.push((details.exception && details.exception.description) || details.text);
      }
    });
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Profiler.enable');
    await tab.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: OPENER });
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    return tab;
  }

  constructor(cdp, sessionId, base) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.base = base;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** Open a chart window; `name` is a case, or `edit` for the editor with `extra` as its query. */
  async show(name, theme = 'light', extra = '') {
    await coverage.collect(this);
    this.errors = [];
    // A load that never comes is a failure with a name, not a check that hangs.
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`${name} did not finish loading`));
      }, 15000);
      const stop = this.cdp.on((message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.loadEventFired') {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    });
    loaded.catch(() => {});
    if (process.env.VERBOSE) console.error(`showing ${name} ${theme}${extra}`);
    const path = name === 'edit' ? `/edit?theme=${theme}${extra}` : name === 'reconcile' ? `/reconcile?theme=${theme}${extra}` : `/window?case=${name}&theme=${theme}${extra}`;
    await this.send('Page.navigate', { url: `${this.base}${path}` });
    await loaded;
    await this.until(name === 'edit'
      ? "document.querySelector('.ace_content') || !document.getElementById('warn').hidden"
      : name === 'reconcile' ? "document.querySelectorAll('#rows tr').length > 0"
      : "document.querySelectorAll('#chart *').length > 0 || !document.getElementById('warn').hidden");
  }

  async eval(expression) {
    // An expression is a value or an effect; an effect such as defineProperty returns the
    // window, which cannot be sent back by value, so anything that is not plain data is dropped.
    const wrapped = `(async () => { const value = await (${expression}); return value instanceof Node || value === window || typeof value === 'function' ? undefined : value; })()`;
    const result = await this.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  async until(expression, timeout = 5000) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(expression);
      if (value) return value;
      if (Date.now() > end) return value;
      await sleep(40);
    }
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
  }

  /** A click, or with `times` 2 a double-click: each press counted, as a real one is. */
  async click(x, y, times = 1) {
    await this.mouse('mouseMoved', x, y);
    for (let clickCount = 1; clickCount <= times; clickCount += 1) {
      await this.mouse('mousePressed', x, y, { button: 'left', clickCount });
      await this.mouse('mouseReleased', x, y, { button: 'left', clickCount });
    }
    await sleep(60);
  }

  async key(key, { code = key, keyCode = 0, text } = {}) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await sleep(60);
  }

  /**
   * The centre of the first element matching a selector, in page coordinates.
   *
   * It waits for the element to have a size. A node that has just been unhidden, or drawn into
   * a chart still being laid out, measures 0x0 for a moment, and the centre of nothing is its
   * corner, which is somewhere else on the page: the click then lands on whatever is behind it
   * and the run fails later, somewhere unrelated to the cause. Failing here says so instead.
   */
  async centre(selector, pick = 'first') {
    const box = await this.until(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = ${pick === 'last' ? 'all[all.length - 1]' : 'all[0]'};
      if (!node) return null;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return [box.left + box.width / 2, box.top + box.height / 2];
    })()`);
    if (!box) throw new Error(`nothing with a size matches ${selector}`);
    return box;
  }

  tip() {
    return this.eval("(() => { const tip = document.querySelector('.tip'); return tip && !tip.hidden ? tip.innerText.replace(/\\n/g, ' | ') : ''; })()");
  }

  heading() {
    return this.eval("document.getElementById('heading').textContent");
  }

  warning() {
    return this.eval("(() => { const warn = document.getElementById('warn'); return warn.hidden ? '' : warn.textContent; })()");
  }
}

// ------------------------------------------------------------------ coverage

/**
 * The share of each measured file's source the run executed, merged across every window.
 *
 * V8 reports, per function, ranges with a count; an inner range overrides the outer one it
 * sits in. Applying them outermost first gives a count per character, and a character counts
 * as covered if any window executed it. Whitespace and comments are not code, so only the rest
 * is counted.
 */
const coverage = {
  executed: new Map(),
  sources: new Map(),

  async collect(tab) {
    const { result } = await tab.send('Profiler.takePreciseCoverage');
    this.merge(result);
  },

  /** V8's per-script coverage, from a browser tab, this process, or a NODE_V8_COVERAGE file. */
  merge(result) {
    for (const script of result) {
      const name = MEASURED.find((file) => script.url.endsWith(`/plugins/${file}`));
      if (!name) continue;
      if (!this.sources.has(name)) this.sources.set(name, readFileSync(join(PLUGINS, name), 'utf8'));
      const source = this.sources.get(name);
      const counts = new Array(source.length).fill(-1);
      for (const fn of script.functions) {
        for (const range of fn.ranges) {
          for (let at = range.startOffset; at < Math.min(range.endOffset, source.length); at += 1) counts[at] = range.count;
        }
      }
      const seen = this.executed.get(name) || new Uint8Array(source.length);
      counts.forEach((count, at) => {
        if (count > 0) seen[at] = 1;
      });
      this.executed.set(name, seen);
    }
  },

  report() {
    return MEASURED.map((name) => {
      const source = this.sources.get(name) || readFileSync(join(PLUGINS, name), 'utf8');
      const code = codeMask(source);
      const seen = this.executed.get(name) || new Uint8Array(source.length);
      let total = 0;
      let hit = 0;
      for (let at = 0; at < source.length; at += 1) {
        if (!code[at]) continue;
        total += 1;
        if (seen[at]) hit += 1;
      }
      return { name, share: total ? hit / total : 1 };
    });
  },
};

/** Which characters are code: not whitespace, not a comment. */
function codeMask(source) {
  const mask = new Uint8Array(source.length);
  let at = 0;
  let quote = null;
  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];
    if (!quote && here === '/' && next === '/') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (!quote && here === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2);
      at = end < 0 ? source.length : end + 2;
      continue;
    }
    if (quote) {
      if (here === '\\') {
        mask[at] = 1;
        mask[at + 1] = 1;
        at += 2;
        continue;
      }
      if (here === quote) quote = null;
    } else if (here === "'" || here === '"' || here === '`') {
      quote = here;
    }
    if (!/\s/.test(here)) mask[at] = 1;
    at += 1;
  }
  return mask;
}

// ------------------------------------------------------------------ the checks

const checks = [];
const check = (what, ok, detail = '') => checks.push([what, Boolean(ok), detail]);

async function everyChartDraws(tab) {
  // How many marks each chart should have, at least, from its fixture.
  const marks = {
    line: 'path.line', daily: 'path.line', single: 'path.line', loglines: 'path.line', stacked: 'path', bar: 'rect[role=button]',
    columns: 'rect[role=button]', doughnut: 'path[role=button]', treemap: 'rect[role=button]', calendar: 'rect',
    waterfall: 'rect[role=button]', multiples: 'path', sankey: 'rect[role=button]',
    heatmap: 'rect[role=button]', bump: 'circle[role=button]', stream: 'path', sunburst: 'path[role=button]',
    race: 'rect[role=button]', playtree: 'rect[role=button]', playburst: 'path[role=button]', playflows: 'rect[role=button]',
    playpie: 'path[role=button]', cashflow: 'rect[role=button]', budget: 'rect[role=button]', swarm: 'circle[role=button]',
    histogram: 'rect[role=img]', pack: 'circle[role=button]', playpack: 'circle[role=button]',
  };
  for (const theme of ['light', 'dark']) {
    for (const name of Object.keys(CASES)) {
      await tab.show(name, theme);
      const count = await tab.eval(`document.querySelectorAll('#chart ${marks[name]}').length`);
      const warning = await tab.warning();
      check(`${name} draws in the ${theme} theme`, count > 0 && !warning && tab.errors.length === 0,
        `${count} marks, warning "${warning}", errors ${tab.errors.join(' | ')}`);
    }
  }
  const texts = () => tab.eval("[...document.querySelectorAll('#chart text')].map((node) => node.textContent)");
  await tab.show('single');
  check('one account\'s line is filled', await tab.eval("document.querySelectorAll('#chart path.fill').length === 1"));
  check('--cumulative draws the running total', (await texts()).some((text) => text === '$3,500' || text === '$4,000'), (await texts()).join(','));
  await tab.show('loglines');
  const logged = await texts();
  check('--log ticks the axis at powers of ten', ['$1', '$10', '$100', '$1,000'].every((text) => logged.includes(text)), logged.join(','));
  check('--top 2 keeps two accounts and an other', (await tab.eval("[...document.querySelectorAll('.legend li')].map((li) => li.textContent).join()")) === 'expenses:housing:rent,expenses:food:coffee,other (1)',
    await tab.eval("[...document.querySelectorAll('.legend li')].map((li) => li.textContent).join()"));
  await tab.show('stacked');
  check('--percent labels the axis in percent', (await texts()).includes('100%') && !(await texts()).some((text) => text.startsWith('$')), (await texts()).join(','));
  await tab.show('columns');
  check('a bar chart of several periods is columns, one per account per period',
    (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 9
    && ['2024-01', '2024-02', '2024-03'].every(async () => true) && (await texts()).includes('2024-02'), String(await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")));
  check('on a logarithmic axis', (await texts()).includes('$1,000') && (await texts()).includes('$10'), (await texts()).join(','));
  await tab.eval("document.querySelector('.legend li').click()");
  check('and a legend entry takes an account\'s columns out', (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 6, '');
  await tab.show('doughnut');
  // An other is not an account, so it is a labelled mark but not a button to follow.
  check('--top 2 on a pie keeps two slices and an other, which is not a button',
    (await tab.eval("document.querySelectorAll('#chart path[aria-label]').length")) === 3
    && (await tab.eval("document.querySelectorAll('#chart path[role=button]').length")) === 2, '');
  await tab.show('sankey');
  check('--top 1 on a Sankey keeps one category, an other, and what was saved',
    (await tab.eval("[...document.querySelectorAll('#chart rect[aria-label]')].map((node) => node.getAttribute('aria-label').split(',')[0]).join()")) === 'income:salary,income,expenses:housing,other (2),saved',
    await tab.eval("[...document.querySelectorAll('#chart rect[aria-label]')].map((node) => node.getAttribute('aria-label').split(',')[0]).join()"));
  await tab.show('multiples');
  check('--sort name orders the sparklines by name', (await tab.eval("[...document.querySelectorAll('#table td:first-child')].map((td) => td.textContent).join()"))
    === 'expenses:food:coffee,expenses:housing:rent,expenses:reading:books', '');
  await tab.show('treemap');
  check('the treemap draws a card for every account, parents and leaves',
    (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 6,
    String(await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")));
  const cardTexts = await tab.eval("[...document.querySelectorAll('#chart text')].map((node) => node.textContent)");
  check('a parent card is headed with its name and total, a leaf with its own',
    cardTexts.includes('food$99') && cardTexts.includes('expenses$699') && cardTexts.includes('rent$600'), cardTexts.join(' | '));
  check('and the levels are layered with a shadow', await tab.eval("document.querySelectorAll('#chart filter feDropShadow').length === 1 && document.querySelectorAll('#chart g[filter]').length >= 2"));
  await tab.show('calendar');
  check('the calendar names both months it spans',
    await tab.eval("(() => { const t = [...document.querySelectorAll('#chart text')].map(n => n.textContent); return t.some(x => /^Jan/.test(x)) && t.includes('Feb'); })()"),
    await tab.eval("[...document.querySelectorAll('#chart text')].map(n => n.textContent).join(',')"));
}

async function theLineChart(tab) {
  await tab.show('line');
  const [left, top, width, height] = await tab.eval("(() => { const b = document.getElementById('chart').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()");
  await tab.mouse('mouseMoved', left + width - 30, top + height / 2);
  await sleep(80);
  const tip = await tab.tip();
  check('hovering the plot lists every series at that period, and the total',
    /^2024-03/.test(tip) && /housing:rent/.test(tip) && /total/.test(tip), tip);
  check('and draws a crosshair', await tab.eval("document.querySelectorAll('#chart [data-transient] line').length === 1"));
  await tab.mouse('mouseMoved', 5, 5);
  await sleep(60);
  check('leaving the plot hides it again', (await tab.tip()) === '' || !(await tab.eval("document.querySelectorAll('#chart [data-transient] line').length")), await tab.tip());

  const lines = () => tab.eval("document.querySelectorAll('#chart path.line').length");
  const before = await lines();
  await tab.eval("document.querySelector('.legend li').click()");
  check('a legend entry hides its series', (await lines()) === before - 1
    && (await tab.eval("document.querySelector('.legend li').getAttribute('aria-checked')")) === 'false', String(await lines()));
  await tab.eval("document.querySelector('.legend li').focus()");
  await tab.key('Enter', { keyCode: 13 });
  check('and Enter on it brings the series back', (await lines()) === before, String(await lines()));
  for (let index = 0; index < before; index += 1) await tab.eval(`document.querySelectorAll('.legend li')[${index}].click()`);
  check('hiding every series says how to get one back',
    /Every series is hidden/.test(await tab.eval("document.getElementById('chart').textContent")));
  for (let index = 0; index < before; index += 1) await tab.eval(`document.querySelectorAll('.legend li')[${index}].click()`);

  await tab.key('ArrowRight', { keyCode: 39 });
  check('→ puts the crosshair on the first period', /^2024-01/.test(await tab.tip()), await tab.tip());
  await tab.key('ArrowRight', { keyCode: 39 });
  await tab.key('ArrowRight', { keyCode: 39 });
  await tab.key('ArrowRight', { keyCode: 39 });
  check('and stops at the last', /^2024-03/.test(await tab.tip()), await tab.tip());
  await tab.key('ArrowLeft', { keyCode: 37 });
  check('← steps back', /^2024-02/.test(await tab.tip()), await tab.tip());

  // A click near rent's January point charts rent on its own.
  const point = await tab.eval("(() => { const c = [...document.querySelectorAll('#chart circle')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0].getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()");

  await tab.click(point[0] + 1, point[1] + 1);

  await tab.until("document.getElementById('heading').textContent === 'line expenses:housing:rent'");
  check('a click on a line asks for that account over time, by the line that would', (await tab.heading()) === 'line expenses:housing:rent'
    && (await tab.eval('window.__asked.join()')) === 'line expenses:housing:rent', `${await tab.heading()} ${await tab.eval('window.__asked.join()')}`);
  check('with the command it ran', (await tab.eval("document.getElementById('command').textContent")) === ANSWER.command);
  await tab.key('Escape', { keyCode: 27 });
  check('Escape goes back to the chart before', (await tab.heading()) === 'line: expenses', await tab.heading());
  await tab.key('Escape', { keyCode: 27 });
  check('and Escape with nowhere to go back to does nothing', (await tab.heading()) === 'line: expenses');

  await tab.eval("window.dispatchEvent(new Event('resize'))");
  await sleep(250);
  check('a resize redraws the chart', (await tab.eval("document.querySelectorAll('#chart path.line').length")) === before);
}

async function zooming(tab) {
  await tab.show('daily');
  const labels = () => tab.eval("[...document.querySelectorAll('#chart text')].map(t => t.textContent).filter(t => /^2024-/.test(t)).join()");
  const first = await labels();
  const [left, top, width, height] = await tab.eval("(() => { const b = document.getElementById('chart').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()");
  await tab.mouse('mouseWheel', left + width / 2, top + height / 2, { deltaX: 0, deltaY: -500 });
  await sleep(200);
  check('the wheel zooms into time', (await labels()) !== first, `${first} -> ${await labels()}`);
  await tab.mouse('mouseMoved', left + width / 2, top + height / 2);
  await tab.mouse('mousePressed', left + width / 2, top + height / 2, { button: 'left', clickCount: 1 });
  await tab.mouse('mouseMoved', left + width / 2 + 200, top + height / 2, { button: 'left' });
  await tab.mouse('mouseReleased', left + width / 2 + 200, top + height / 2, { button: 'left', clickCount: 1 });
  await sleep(150);
  const panned = await labels();
  check('a drag pans through it', panned !== first, panned);
  await tab.key('0', { code: 'Digit0', keyCode: 48, text: '0' });
  await sleep(400);
  check('0 resets the zoom', (await labels()) === first, await labels());
  await tab.key('+', { code: 'Equal', keyCode: 187, text: '+' });
  await sleep(300);
  check('+ zooms in', (await labels()) !== first, await labels());
  await tab.key('-', { code: 'Minus', keyCode: 189, text: '-' });
  await sleep(300);
  check('and - zooms back out', (await labels()) === first, await labels());
  await tab.key('+', { code: 'Equal', keyCode: 187, text: '+' });
  await sleep(300);
  for (let step = 0; step < 40; step += 1) await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(400);
  check('stepping past the zoomed range pans to keep the crosshair in view', /^2024-02-09/.test(await tab.tip()), await tab.tip());
  const [x, y] = [left + width / 2, top + height / 2];
  await tab.click(x, y, 2);
  await sleep(400);
  check('a double-click resets it too', (await labels()) === first, await labels());
}

async function byKeyboard(tab) {
  // What Enter on the first mark asks for: that account over time, in the same period, with the
  // options that still mean something for one account (--log does; --top and --sort do not).
  for (const [name, expected] of [['bar', 'line expenses:housing:rent'], ['columns', '--log line -M expenses:housing:rent'],
    ['doughnut', 'line expenses:housing:rent'], ['treemap', 'line expenses'], ['waterfall', 'line income'],
    ['multiples', '--log line expenses:food:coffee'], ['sankey', 'line income:salary']]) {
    await tab.show(name);
    await tab.eval('document.activeElement && document.activeElement.blur()');
    // The first stop is whatever comes first in the page; walk until a mark has focus.
    let label = '';
    for (let step = 0; step < 6 && !label; step += 1) {
      await tab.key('Tab', { keyCode: 9 });
      label = await tab.eval("document.activeElement && document.activeElement.closest('#chart') ? document.activeElement.getAttribute('aria-label') : ''");
    }
    const tip = await tab.tip();
    check(`Tab reaches a mark in the ${name}, and focus shows its numbers`, label && tip && tip.includes('$'), `${label} / ${tip}`);
    const before = await tab.eval('window.__asked.length');
    await tab.key('Enter', { keyCode: 13, text: '\r' });
    await tab.until(`window.__asked.length > ${before}`);
    const asked = await tab.eval('window.__asked[window.__asked.length - 1]');
    check(`Enter on it charts that account over time (${name})`, asked === expected, String(asked));
    await tab.key('Tab', { keyCode: 9 });
  }
  await tab.show('calendar');
  let tip = '';
  for (let step = 0; step < 6 && !tip; step += 1) {
    await tab.key('Tab', { keyCode: 9 });
    tip = await tab.tip();
  }
  check('a calendar day with spending is a stop, and says what was spent', /spent/.test(tip) && /\$600\.00/.test(tip), tip);
  const empty = await tab.centre('#chart rect:not([tabindex])');
  await tab.mouse('mouseMoved', empty[0], empty[1]);
  await sleep(60);
  check('hovering a day with nothing says so', /nothing spent/.test(await tab.tip()), await tab.tip());

  await tab.show('sankey');
  const link = await tab.centre('#chart path', 'last');
  await tab.mouse('mouseMoved', link[0], link[1]);
  await sleep(60);
  check('hovering a Sankey link says what flowed where', /→/.test(await tab.tip()) && /\$/.test(await tab.tip()), await tab.tip());
  await tab.mouse('mouseMoved', 5, 5);
  await sleep(40);
}

async function saving(tab, downloads) {
  await tab.show('line');
  await tab.eval("document.querySelector('.legend li').click()");
  await tab.key('s', { code: 'KeyS', keyCode: 83, text: 's' });
  await tab.key('p', { code: 'KeyP', keyCode: 80, text: 'p' });
  const until = Date.now() + 8000;
  while (Date.now() < until && readdirSync(downloads).filter((file) => /\.(svg|png)$/.test(file)).length < 2) await sleep(100);
  const files = readdirSync(downloads);
  const svg = files.includes('hledger-line-expenses.svg') ? readFileSync(join(downloads, 'hledger-line-expenses.svg'), 'utf8') : '';
  check('s saves an SVG named after the chart', svg.startsWith('<?xml') && /xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(svg), files.join(','));
  check('with its title, subtitle and the legend of what is shown',
    svg.includes('>line: expenses<') && svg.includes('3 periods') && svg.includes('food:coffee') && !svg.includes('>expenses:housing:rent<'), '');
  check('and none of the interaction layers', svg && !svg.includes('data-transient'), '');
  const png = files.includes('hledger-line-expenses.png') ? readFileSync(join(downloads, 'hledger-line-expenses.png')) : Buffer.alloc(0);
  check('p saves a PNG of it', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.length > 4000, `${png.length} bytes`);
  check('at twice the size, header included', png.length && png.readUInt32BE(16) > 1900, png.length ? String(png.readUInt32BE(16)) : '');
  check('a key with a modifier is left to the browser', await (async () => {
    const before = readdirSync(downloads).length;
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await sleep(300);
    return readdirSync(downloads).length === before;
  })());
}

async function moreCharts(tab) {
  const texts = () => tab.eval("[...document.querySelectorAll('#chart text')].map((node) => node.textContent)");
  await tab.show('heatmap');
  check('a heatmap has a square per account per period, and names its rows',
    (await tab.eval("document.querySelectorAll('#chart rect').length")) === 9 && (await texts()).includes('expenses:housing:rent')
    && (await tab.eval("document.getElementById('legend').hidden || !document.querySelector('.legend li')")), String(await tab.eval("document.querySelectorAll('#chart rect').length")));
  check('and says how dark is how much, on a log scale', (await texts()).some((text) => /darkest is \$1,286\.40, on a log scale/.test(text)), (await texts()).slice(-1)[0]);
  await tab.show('bump');
  check('a bump chart ranks each account in each period', ['#1', '#2', '#3'].every(async () => true) && (await texts()).includes('#3')
    && (await tab.eval("document.querySelectorAll('#chart circle').length")) === 9, (await texts()).join(','));
  const dot = await tab.centre('#chart circle');
  await tab.mouse('mouseMoved', dot[0], dot[1]);
  check('and its tooltip says the rank and the amount', /#\d expenses/.test(await tab.tip()), await tab.tip());
  await tab.show('stream');
  check('a streamgraph has a band per account and no value axis', (await tab.eval("document.querySelectorAll('#chart path').length")) >= 3
    && !(await texts()).some((text) => text.startsWith('$')), (await texts()).join(','));
  await tab.show('sunburst');
  check('a sunburst draws the tree in rings, the lone top account as its centre',
    (await tab.eval("document.querySelectorAll('#chart path[role=button]').length")) === 5 && (await texts()).includes('$698.90')
    && (await tab.eval("[...document.querySelectorAll('#chart path')].every((path) => path.getAttribute('fill') && path.getAttribute('fill') !== 'rgb(0, 0, 0)')")),
    String(await tab.eval("document.querySelectorAll('#chart path[role=button]').length")));
  const arc = await tab.centre('#chart path[role=button]');
  await tab.click(arc[0], arc[1]);
  await tab.until('window.__asked.length > 0');
  check('and a click on a ring charts that account over time', /^line expenses:/.test(await tab.eval('window.__asked[window.__asked.length - 1]')),
    await tab.eval('window.__asked[window.__asked.length - 1]'));
}

async function moneyCharts(tab) {
  const texts = () => tab.eval("[...document.querySelectorAll('#chart text')].map((node) => node.textContent)");
  const sub = () => tab.eval("document.getElementById('sub').textContent");
  await tab.show('cashflow');
  check('a cash flow puts income above the line and spending below, with the net as a line',
    (await texts()).includes('in ↑') && (await tab.eval("document.querySelectorAll('#chart circle').length")) === 3
    && /^3 periods: in \$6,400\.00, out \$1,973\.89, net \$4,426\.11, 69\.2% of income kept$/.test(await sub()), await sub());
  const net = await tab.centre('#chart circle');
  await tab.mouse('mouseMoved', net[0], net[1]);
  check('and a net dot says what was kept', /kept/.test(await tab.tip()) || /overspent/.test(await tab.tip()), await tab.tip());
  await tab.show('budget');
  check('a budget chart is a track, a bar and a tick per budgeted account, the furthest over first',
    (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 2 && (await texts()).filter((text) => /^expenses:|%$/.test(text)).join() === 'expenses:housing,50%,expenses:food,49%'
    && /spent \$1,333\.89 of \$2,600\.00 budgeted \(51%\); 0 of 2 accounts over/.test(await sub()), JSON.stringify(await texts()));
  await tab.show('swarm');
  check('a swarm draws a dot per purchase, the largest largest', (await tab.eval("document.querySelectorAll('#chart circle').length")) === 3
    && (await tab.eval("(() => { const r = [...document.querySelectorAll('#chart circle')].map((c) => +c.getAttribute('r')); return Math.max(...r) > 3 * Math.min(...r); })()")), '');
  const dot = await tab.centre('#chart circle', 'last');
  await tab.mouse('mouseMoved', dot[0], dot[1]);
  check('and its tooltip is the transaction', /^2024-0\d-\d\d /.test(await tab.tip()), await tab.tip());
  await tab.show('histogram');
  check('a histogram counts purchases by size and says how they spread', /^3 transactions; half under \$86\.40/.test(await sub()) && (await texts()).includes('bars: how many'), await sub());
  await tab.show('pack');
  check('a circle pack draws every account as a circle, parents around their children',
    (await tab.eval("document.querySelectorAll('#chart circle[role=button]').length")) === 6 && (await texts()).includes('rent'), String(await tab.eval("document.querySelectorAll('#chart circle').length")));
  const circle = await tab.centre('#chart circle[role=button]', 'last');
  await tab.click(circle[0], circle[1]);
  await tab.until('window.__asked.length > 0');
  check('and a click on a circle opens its account', /^line expenses/.test(await tab.eval('window.__asked[window.__asked.length - 1]')), await tab.eval('window.__asked[window.__asked.length - 1]'));
  await tab.show('playpack');
  await tab.until("!/playing/.test(document.getElementById('timeline').getAttribute('aria-valuetext'))", 9000);
  check('and a circle pack plays through its periods', (await tab.eval("document.querySelector('.period').textContent")) === '2024-03', '');
}

async function playing(tab) {
  const badge = () => tab.eval("document.querySelector('.period') && document.querySelector('.period').textContent");
  const label = () => tab.eval("document.getElementById('timeline').getAttribute('aria-valuetext')");
  await tab.show('playtree');
  check('an animation has a timeline and a period badge, and plays by itself',
    !(await tab.eval("document.getElementById('timeline').hidden")) && (await badge()) === '2024-01' && /playing/.test(await label()), await label());
  check('and its keys say Space plays', /^Space play, pause/.test(await tab.eval("document.getElementById('keys').textContent")), '');
  await tab.until("document.querySelector('.period').textContent === '2024-03' && !/playing/.test(document.getElementById('timeline').getAttribute('aria-valuetext'))", 9000);
  check('it plays to the last period and stops there', (await badge()) === '2024-03' && /\$600\.00 at the leaves/.test(await tab.eval("document.getElementById('sub').textContent")),
    await tab.eval("document.getElementById('sub').textContent"));
  check('and the table is that period\'s, without what it did not hold', !(await tab.eval("document.getElementById('table').textContent")).includes('books'), '');
  await tab.key('ArrowLeft', { keyCode: 37 });
  check('the arrows step a period', (await badge()) === '2024-02' && /\$47\.49 at the leaves/.test(await tab.eval("document.getElementById('sub').textContent")), await badge());
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  check('Space plays from there', /playing/.test(await label()), await label());
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  check('and pauses on a whole period', !/playing/.test(await label()) && ['2024-02', '2024-03'].includes(await badge()), await label());
  const [x, y] = await tab.eval("(() => { const b = document.querySelector('#timeline .track').getBoundingClientRect(); return [b.left + 2, b.top + 2]; })()");
  await tab.click(x, y);
  check('a click on the timeline goes to that period', (await badge()) === '2024-01', await badge());
  await tab.key('0', { keyCode: 48, text: '0' });
  check('0 goes back to the first', (await badge()) === '2024-01', await badge());
  const cell = await tab.centre('#chart rect[role=button]');
  await tab.click(cell[0], cell[1]);
  await tab.until("document.getElementById('heading').textContent.startsWith('line')");
  check('a click on a mark opens that account, and the animation stops', (await tab.eval('document.querySelector(".period")')) === null
    && (await tab.eval("document.getElementById('timeline').hidden")), '');
  await tab.key('Escape', { keyCode: 27 });
  await tab.until("document.querySelector('.period')");
  check('Escape comes back to the animation', (await tab.eval("document.getElementById('heading').textContent")) === 'treemap: expenses (animated)', '');

  await tab.show('race');
  await tab.until("!/playing/.test(document.getElementById('timeline').getAttribute('aria-valuetext'))", 9000);
  check('a bar race keeps its places and writes its period where the bars are shortest',
    (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 2 && (await tab.eval("document.querySelector('.period').className")) === 'period bottom'
    && /2 places of 3 accounts; leading: expenses:housing:rent, \$3,723\.90/.test(await tab.eval("document.getElementById('sub').textContent")),
    await tab.eval("document.getElementById('sub').textContent"));
  await tab.show('playflows');
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await tab.key('ArrowRight', { keyCode: 39 });
  check('an animated Sankey steps to a period with no income, drawn from savings',
    (await badge()) === '2024-02' && /more spent than came in/.test(await tab.eval("document.getElementById('sub').textContent")), await tab.eval("document.getElementById('sub').textContent"));
  await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await tab.show('playpie');
  check('with reduced motion an animation waits to be played', !/playing/.test(await label()) && (await badge()) === '2024-01', await label());
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await tab.until("document.querySelector('.period').textContent === '2024-03'", 9000);
  check('and then steps through its periods', (await badge()) === '2024-03', await badge());
  await tab.send('Emulation.setEmulatedMedia', { features: [] });
}

async function goingBack(tab) {
  const back = () => tab.eval("document.getElementById('back').hidden ? '' : document.getElementById('back').textContent");
  const heading = () => tab.eval("document.getElementById('heading').textContent");
  await tab.show('treemap');
  check('a chart nothing was followed to has no way back to offer', (await back()) === '', await back());
  const open = async () => {
    const cell = await tab.centre('#chart rect[role=button]');
    await tab.click(cell[0], cell[1]);
    await tab.until("document.getElementById('heading').textContent.startsWith('line ')");
  };
  await open();
  check('after a click on the treemap, a link above the title says where back goes', (await back()) === '← back to treemap: expenses', await back());
  const link = await tab.centre('#back');
  await tab.click(link[0], link[1]);
  await tab.until("document.getElementById('heading').textContent === 'treemap: expenses'");
  check('and a click on it goes back, and then it is gone', (await heading()) === 'treemap: expenses' && (await back()) === '', await heading());
  await open();
  await tab.eval('history.back()');
  await tab.until("document.getElementById('heading').textContent === 'treemap: expenses'");
  check('the browser\'s Back goes back too', (await heading()) === 'treemap: expenses' && (await back()) === '', await heading());
  await open();
  await tab.key('Escape', { keyCode: 27 });
  await tab.until("document.getElementById('heading').textContent === 'treemap: expenses'");
  check('and so does Escape, from the treemap', (await heading()) === 'treemap: expenses', await heading());
  // Two deep: back goes one step at a time, naming each.
  await open();
  const before = await heading();
  const [left, top, width, height] = await tab.eval("(() => { const b = document.getElementById('chart').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()");
  await tab.mouse('mouseMoved', left + width - 30, top + height / 2);
  await tab.click(left + width - 30, top + height / 2);
  await tab.until(`document.getElementById('heading').textContent !== ${JSON.stringify(before)}`);
  check('two charts deep, back names the one before', (await back()).startsWith('← back to line '), await back());
  await tab.eval('history.back()');
  await tab.until("document.getElementById('heading').textContent.startsWith('line ')");
  await tab.key('Escape', { keyCode: 27 });
  await tab.until("document.getElementById('heading').textContent === 'treemap: expenses'");
  check('and back twice is where it started', (await heading()) === 'treemap: expenses' && (await back()) === '', await heading());
}

async function relatedCharts(tab) {
  await tab.show('bar');
  const links = await tab.eval("[...document.querySelectorAll('#also a')].map(a => a.textContent).join(' | ')");
  check('a chart lists the same query as the other types, by the line each one is',
    links === 'chart pie expenses | chart treemap expenses | chart sunburst expenses | chart pack expenses | chart line expenses'
    && !(await tab.eval("document.getElementById('also').hidden")), links);
  const link = await tab.centre('#also a', 'last');
  await tab.click(link[0], link[1]);
  await tab.until("document.getElementById('heading').textContent === 'line expenses'");
  check('clicking one charts it, through the app', (await tab.heading()) === 'line expenses'
    && (await tab.eval('window.__asked[window.__asked.length - 1]')) === 'line expenses', await tab.heading());
  check('and a chart with nothing related has no line for it', await tab.eval("document.getElementById('also').hidden"));
  await tab.key('Escape', { keyCode: 27 });
  check('Escape comes back, with the links where they were', (await tab.heading()) === 'bar: expenses'
    && (await tab.eval("document.querySelectorAll('#also a').length")) === 5, await tab.heading());
  // A link is reached by Tab and followed with Enter, like the rest of the window.
  await tab.eval("document.querySelector('#also a').focus()");
  await tab.key('Enter', { keyCode: 13, text: '\r' });
  await tab.until("document.getElementById('heading').textContent === 'pie expenses'");
  check('Enter on a focused link follows it', (await tab.heading()) === 'pie expenses', await tab.heading());
}

async function whenThingsGoWrong(tab) {
  await tab.show('line', 'light', '&library=no');
  check('without the library, the numbers stand alone and the window says so',
    /did not load/.test(await tab.warning()) && (await tab.eval("document.querySelectorAll('#table tr').length")) > 1, await tab.warning());

  await tab.show('bar');
  await tab.eval("Object.defineProperty(window, 'opener', { configurable: true, value: null })");
  await tab.eval("document.querySelector('#chart rect[role=button]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await tab.until("!document.getElementById('warn').hidden");
  check('a window whose app has gone says so rather than doing nothing', /lost touch/.test(await tab.warning()), await tab.warning());

  await tab.show('bar');
  await tab.eval("window.opener.__chartBridges.check.requery = async () => { throw new Error('hledger: no such account'); }");
  await tab.eval("document.querySelector('#chart rect[role=button]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await tab.until("/no such account/.test(document.getElementById('warn').textContent)");
  check('and a failed drill-down shows hledger\'s answer', /no such account/.test(await tab.warning()), await tab.warning());
}

async function reconciling(tab) {
  const text = (id) => tab.eval(`document.getElementById('${id}').innerText`);
  const difference = () => tab.eval("document.querySelector('#sums .difference b').textContent");
  const type = (id, value) => tab.eval(`(() => { const el = document.getElementById('${id}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); })()`);
  const tickRow = async (index) => {
    const at = await tab.eval(`(() => { const b = document.querySelectorAll('#rows tr')[${index}].getBoundingClientRect(); return [b.left + 40, b.top + b.height / 2]; })()`);
    await tab.click(at[0], at[1]);
  };
  for (const theme of ['light', 'dark']) {
    await tab.show('reconcile', theme);
    check(`the reconcile window lists the account's postings since its last assertion (${theme})`,
      (await tab.eval("document.querySelectorAll('#rows tr').length")) === 6 && /opening balance asserted on 2026-08-31/.test(await text('sub')) && tab.errors.length === 0,
      `${await text('sub')} ${tab.errors.join(' | ')}`);
  }
  check('it opens at the opening balance, asking for the statement', /Opening\s*1,000,000\.00 IDR/i.test(await text('sums')) && /Statement\s*type it above/i.test(await text('sums')), await text('sums'));
  // Someone opening this for the first time sees a table and empty boxes, so the one thing to
  // do first is said out loud, and the cursor is already where that happens.
  check('opening it says what to do first, and puts the cursor there',
    /closing balance your statement shows/.test(await text('next')) && (await tab.eval('document.activeElement.id')) === 'balance', await text('next'));
  check('a posting after the statement date is faded, and said', (await tab.eval("document.querySelectorAll('#rows tr.later').length")) === 1 && /1 later posting, after the statement date/.test(await text('notes')), await text('notes'));
  await type('balance', '5,670,000');
  check('and the line follows the state, counting what is left to account for',
    /4,670,000\.00 IDR still to account for/.test(await text('next')), await text('next'));
  check('with the statement balance typed, the difference is there', (await difference()) === '4,670,000.00 IDR', await difference());
  await tickRow(0);
  await tickRow(1);
  await tickRow(3);
  await tickRow(4);
  check('a click ticks a posting and the difference follows', (await difference()) === '-300,000.00 IDR' && (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 4, await difference());
  check('a posting that is exactly the difference is pointed out, and lit',
    /Pending transfer -300,000\.00 IDR: not ticked, and exactly the difference/.test(await text('hints')) && (await tab.eval("document.querySelectorAll('#rows tr.hinted').length")) === 1, await text('hints'));
  check('Finish waits for a difference of zero', await tab.eval("document.getElementById('finish').disabled"));
  await tickRow(5);
  check('a later posting cannot be ticked', (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 4, '');
  // The keyboard: down to the pending transfer, and Space.
  await tab.eval("document.activeElement && document.activeElement.blur()");
  for (let step = 0; step < 3; step += 1) await tab.key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
  await tab.key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  check('j, k and Space tick from the keyboard, and at zero the difference is lit',
    (await difference()) === '0.00 IDR' && (await tab.eval("document.querySelector('#sums .difference').classList.contains('zero')")) && !(await tab.eval("document.getElementById('finish').disabled")), await difference());
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await type('balance', '5,970,000');
  check('at zero with a posting left out, Finish says why it waits',
    (await difference()) === '0.00 IDR' && (await tab.eval("document.getElementById('finish').disabled")) && /1 posting is dated on or before the statement but not ticked/.test(await text('notes')), await text('notes'));
  await type('balance', '5,670,000');
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  check('a ticks every posting shown up to the date', (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 5 && (await difference()) === '0.00 IDR', '');
  check('and at zero the line says the totals match and Finish is the move',
    /totals match/.test(await text('next')) && /Finish/.test(await text('next')), await text('next'));
  await tab.key('/', { code: 'Slash', keyCode: 191, text: '/' });
  await tab.send('Input.insertText', { text: 'coffee' });
  await sleep(100);
  check('/ searches', (await tab.eval("document.querySelectorAll('#rows tr').length")) === 1 && (await tab.eval('document.activeElement.id')) === 'search', '');
  await tab.key('Escape', { keyCode: 27 });
  check('and Escape clears it', (await tab.eval("document.querySelectorAll('#rows tr').length")) === 6, '');
  await type('date', '2026-08-01');
  check('a statement before the asserted balance is refused', /before 2026-08-31, where this account's balance is already asserted/.test(await text('notes')), await text('notes'));
  await type('date', '2026-09-30');

  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  check('Finish shows what would be written before writing it',
    /fixture\.journal: 5 lines would change, and at the end:/.test(await text('preview')) && /= 5670000\.00 IDR/.test(await text('preview')) && (await tab.eval('window.__applied.length')) === 0,
    await text('preview'));
  check('and asks the plugin with the ticks and the statement', await tab.eval("(() => { const r = window.__previewed.pop(); return r.ticked.length === 5 && r.finish.date === '2026-09-30' && r.finish.balance === 567000000 && r.fingerprint === 'before'; })()"), '');
  await tab.eval("document.getElementById('apply').click()");
  await tab.until("/reconciled/.test(document.getElementById('status').textContent)");
  check('writing goes through the plugin, and the window shows the account as it is now',
    /Assets:Bank:Checking reconciled to 2026-09-30\./.test(await text('status')) && (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 5 && (await tab.eval('document.getElementById(\'preview\').hidden')), await text('status'));
  check('with everything written, there is nothing left to save', (await tab.eval("document.getElementById('progress').disabled")) && (await text('pending')) === '', await text('pending'));
  await tab.eval("window.__refuse = 'hledger refused the result, so the files were put back as they were: Balance assertion failed'");
  await tickRow(0);
  check('and a change says so beside Save', /unsaved: 1 mark/.test(await text('pending')), await text('pending'));
  await tab.eval("document.getElementById('progress').click()");
  await tab.until("!document.getElementById('preview').hidden");
  await tab.eval("document.getElementById('apply').click()");
  await tab.until("document.getElementById('status').classList.contains('error')");
  check('and a refusal is shown as it came', /put back as they were/.test(await text('status')), await text('status'));
  await tab.eval("document.getElementById('progress').click()");
  await tab.until("!document.getElementById('preview').hidden");
  await tab.eval("document.getElementById('cancel').click()");
  check('Cancel puts the preview away', await tab.eval("document.getElementById('preview').hidden"));

  await tab.show('reconcile', 'light', '&writable=no&balance=5670000');
  check('in a read-only file, Save progress is off and Finish offers the assertion to copy',
    (await tab.eval("document.getElementById('progress').disabled")) && /copy the assertion/.test(await tab.eval("document.getElementById('finish').textContent")) && /fixture\.journal \(read-only\)/.test(await text('sub')), await text('sub'));
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  check('and its preview says why nothing can be written, with no write button',
    /did not come from an opened folder/.test(await text('preview')) && !(await tab.eval("document.getElementById('apply')")) && (await tab.eval("!!document.getElementById('copy')")), await text('preview'));
  await tab.eval("document.getElementById('copy').click()");
  await tab.until("document.getElementById('status').textContent.length > 0");
  check('and copying says what happened', /Copied|Copying was not allowed/.test(await text('status')), await text('status'));
}

async function reconcileRunning(tab) {
  const text = (id) => tab.eval(`document.getElementById('${id}').innerText`);
  const cell = (row, column) => tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${row}].children[${column}].textContent.trim()`);
  const expect = (row, value) => tab.eval(`(() => { const input = document.querySelectorAll('#rows tr[data-id] input[data-expect]')[${row}]; input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tab.show('reconcile', 'dark');
  check('each posting shows the balance after it', [await cell(0, 4), await cell(1, 4), await cell(2, 4)].join(' | ') === '979,000.00 IDR | 5,979,000.00 IDR | 5,679,000.00 IDR',
    [await cell(0, 4), await cell(1, 4), await cell(2, 4)].join(' | '));
  await expect(0, '979,000');
  await expect(1, '5,979,000');
  await expect(3, '5,679,000');
  check('a typed statement balance shows its difference at that line', (await cell(0, 6)) === '✓' && (await cell(1, 6)) === '✓' && (await cell(3, 6)) === '4,000.00 IDR',
    [await cell(0, 6), await cell(1, 6), await cell(3, 6)].join(' | '));
  check('the first line where they part is marked', await tab.eval("document.querySelectorAll('#rows tr.first').length === 1 && document.querySelectorAll('#rows tr[data-id]')[3].classList.contains('first')"));
  check('and the hint says where, and that it may be the posting before',
    /part at 2026-09-05 Split, by 4,000\.00 IDR: 2026-09-05 Split \(-4,000\.00 IDR\) is exactly that/.test(await text('hints')), await text('hints'));
  check('matching balances are counted as ones to assert', /2 balances to assert/.test(await text('pending')), await text('pending'));
  await expect(3, '5,675,000');
  check('typing it right clears the mismatch', (await cell(3, 6)) === '✓' && (await tab.eval("document.querySelectorAll('#rows tr.first').length")) === 0, await cell(3, 6));
  await expect(3, '5,600,000');
  const add = await tab.eval("!!document.querySelector('#hints button[data-add]')");
  check('a difference no posting explains offers to add one for it', add, await text('hints'));
  await tab.eval("document.querySelector('#hints button[data-add]').click()");
  const area = () => tab.eval("document.querySelector('tr.editor textarea').value");
  const typeIn = (value) => tab.eval(`(() => { const t = document.querySelector('tr.editor textarea'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('which opens the text of a new transaction, with that amount and date, the cursor where its description goes',
    (await area()) === '2026-09-05 \n    Assets:Bank:Checking    -75000.00 IDR\n    ' && (await tab.eval("document.activeElement.tagName === 'TEXTAREA' && document.activeElement.selectionStart === 11")), JSON.stringify(await area()));
  check('and says what it lacks as it is typed', /needs another posting/.test(await text('reading')), await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('so keeping it as it is is refused', /needs another posting/.test(await text('status')), await text('status'));
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees    70000 IDR');
  check('an amount that does not balance is said', /does not balance: its amounts add up to -5,000\.00 IDR/.test(await text('reading')), await text('reading'));
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees');
  check('and a whole one is read back as it would be written', (await text('reading')) === '2026-09-05: -75,000.00 IDR to Assets:Bank:Checking, against Expenses:Fees.', await text('reading'));
  await tab.eval("document.querySelector('tr.editor textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
  const rows = () => tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].map((tr) => tr.children[2].textContent.trim().split('\\n')[0] + '=' + tr.children[4].textContent.trim()).join(' | ')");
  check('Ctrl+Enter keeps it: it is ticked, marked new, and placed straight after the posting where they parted, the balances following',
    /Split[^|]*=5,675,000\.00 IDR \| Bank feenew[^|]*=5,600,000\.00 IDR \| Split[^|]*=5,595,000\.00 IDR \| After the statement[^|]*=5,592,500\.00 IDR/.test(await rows()), await rows());
  const feeRow = await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => /Bank fee/.test(tr.textContent))");
  check('and the statement balance typed where they parted moves to it, where it now matches',
    (await cell(feeRow, 6)) === '✓' && (await cell(3, 6)) === '' && (await tab.eval("document.querySelectorAll('#rows tr.first').length")) === 0, `${await cell(feeRow, 6)} / ${await cell(3, 6)}`);
  // Edit a transaction as text: e on the first row.
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
  await tab.key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
  await tab.key('e', { code: 'KeyE', keyCode: 69, text: 'e' });
  check('e opens the transaction as it is written in the journal', (await area()) === '2026-09-01 * Coffee\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking', JSON.stringify(await area()));
  await typeIn('2026-09-01 * Coffee beans  ; for the office\n    Expenses:Food:Coffee    25000 IDR\n    Assets:Bank:Checking');
  check('the reading follows the text, the amount worked out as hledger would', (await text('reading')) === '2026-09-01: -25,000.00 IDR to Assets:Bank:Checking, against Expenses:Food:Coffee.', await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('an edit changes the amount and every balance after it, and is marked',
    (await cell(0, 3)) === '-25,000.00 IDR' && (await cell(0, 4)) === '975,000.00 IDR' && /Coffee beansedited/.test(await cell(0, 2)) && /1 edit, 1 new/.test(await text('pending')),
    `${await cell(0, 3)} ${await cell(0, 4)} ${await text('pending')}`);
  // The per-row control is a word, not a glyph: a pencil needed a font to have a picture
  // of a pencil, said nothing a screen reader could use that the label did not already
  // say, and reads differently in each theme. What matters is the name, so the name is
  // asserted here rather than the character that used to be drawn.
  const editControl = await tab.eval(`(() => {
    const button = document.querySelector('#rows button[data-edit]');
    button.focus();
    return {
      text: button.textContent.trim(),
      label: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      ascii: /^[ -~]+$/.test(button.textContent.trim()),
      focusable: document.activeElement === button,
      header: document.querySelector('thead th[aria-label="edit"]') !== null,
      width: Math.round(button.getBoundingClientRect().width),
    };
  })()`);
  check('the edit control is a word that says what it does, and is reachable',
    editControl.text === 'edit' && editControl.label === 'edit' && editControl.title === 'edit (e)'
    && editControl.ascii && editControl.focusable && editControl.header && editControl.width < 48,
    JSON.stringify(editControl));
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  check('an edit reopens with what was typed, and can be undone', /Coffee beans/.test(await area()) && (await tab.eval("!!document.querySelector('tr.editor [data-undo]')")), '');
  await tab.eval("document.querySelector('tr.editor [data-undo]').click()");
  check('and is as it was', (await cell(0, 3)) === '-21,000.00 IDR', await cell(0, 3));
  // A transaction with two postings to the account is edited whole.
  const split = await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => /Split/.test(tr.textContent))");
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${split}].querySelector('button[data-edit]').click()`);
  check('a transaction of several postings is edited whole, comments and all', (await area()).includes('    ; a comment line\n    Assets:Bank:Checking    -4000 IDR\n    Assets:Bank:Checking'), JSON.stringify(await area()));
  await tab.key('Escape', { keyCode: 27 });
  check('Escape closes an editor', (await tab.eval("document.querySelectorAll('tr.editor').length")) === 0, '');
  // Emptied, a transaction is deleted, and can be restored.
  const pendingRow = await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => /Pending transfer/.test(tr.textContent))");
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${pendingRow}].querySelector('button[data-edit]').click()`);
  await typeIn('');
  check('emptying the text says it will delete the transaction', /Empty: the transaction will be deleted/.test(await text('reading')), await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('kept, the transaction leaves the list and is listed to restore', !/Pending transfer/.test(await rows()) && /Deleted: 2026-09-03 Pending transfer/.test(await text('notes')) && /1 deleted/.test(await text('pending')), await text('notes'));
  await tab.eval("document.querySelector('#notes button[data-restore]').click()");
  check('and restore brings it back', /Pending transfer/.test(await rows()) && !/deleted/.test(await text('pending')), await text('pending'));
  // n adds a posting; what it lacks is refused, and it can be removed.
  await tab.key('n', { code: 'KeyN', keyCode: 78, text: 'n' });
  check('n adds a posting', (await tab.eval("document.querySelectorAll('tr.editor').length")) === 1 && /^\d{4}-\d{2}-\d{2} \n {4}Assets:Bank:Checking {4}\n {4}$/.test(await area()), JSON.stringify(await area()));
  await typeIn('');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('an empty new one is refused', /nothing to add/.test(await text('status')), await text('status'));
  await typeIn('Bank fee\n    Assets:Bank:Checking    -1 IDR\n    Expenses:Fees');
  check('one without a date line is said as it is typed', /first line needs a date/.test(await text('reading')), await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('and refused', /first line needs a date/.test(await text('status')), await text('status'));
  await typeIn('2026-09-05 Not ours\n    Expenses:Fees    1 IDR\n    Assets:Cash');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('and so is one that does not post to the account', /does not post to Assets:Bank:Checking/.test(await text('status')), await text('status'));
  await typeIn('2026-09-05 Off\n    Assets:Bank:Checking    -1 IDR\n    Expenses:Fees    2 IDR');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('and one that does not balance', /does not balance/.test(await text('status')), await text('status'));
  await tab.eval("document.querySelector('tr.editor [data-close]').click()");
  const fee = await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => /Bank fee/.test(tr.textContent))");
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${fee}].querySelector('button[data-edit]').click()`);
  check('a new one reopens with its text', /Bank fee/.test(await area()), '');
  await tab.eval("document.querySelector('tr.editor [data-drop]').click()");
  check('and can be removed before it is written', !/Bank fee/.test(await rows()) && !/new/.test(await text('pending')), await text('pending'));
  // Save sends the plugin the ticks, edits, new postings and typed balances together.
  await expect(3, '5,600,000');
  await tab.eval("document.querySelector('#hints button[data-add]').click()");
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await typeIn('2026-09-01 * Coffee\n    Expenses:Food    21000 IDR  ; checked\n    Assets:Bank:Checking');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await tab.eval("document.getElementById('progress').click()");
  await tab.until("!document.getElementById('preview').hidden");
  check('its preview shows the rewritten transaction and the added one', /1 transaction rewritten, 1 transaction added/.test(await text('preview')) && /; checked/.test(await text('preview')) && /after line 24:/.test(await text('preview')),
    await text('preview'));
  check('Save sends the new transaction\'s text and the typed balances to be written with the marks',
    await tab.eval("(() => { const r = window.__previewed.pop(); return r.inserts.length === 1 && /Bank fee/.test(r.inserts[0].text) && r.inserts[0].after === '5:Assets:Bank:Checking:0' && Object.keys(r.expected).length === 3 && r.expected[r.inserts[0].id] === 560000000 && Object.keys(r.edits).length === 1 && !r.finish; })()"),
    await tab.eval('JSON.stringify(window.__lastPreview)'));
  await tab.eval("document.getElementById('cancel').click()");
  // A hint is followed to its posting.
  await expect(3, '');
  await expect(1, '5,979,000');
  await expect(2, '5,979,000');
  const pointing = await tab.eval("!!document.querySelector('#hints p[data-id]')");
  if (pointing) await tab.eval("document.querySelector('#hints p[data-id]').click()");
  check('a hint that names a posting moves to it', !pointing || (await tab.eval("document.activeElement && document.activeElement.dataset.id")) !== undefined, await text('hints'));
}

async function theEditor(tab) {
  const status = () => tab.eval("document.getElementById('status').textContent");
  const save = async () => {
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await sleep(150);
  };
  for (const theme of ['light', 'dark']) {
    await tab.show('edit', theme, '&writable=yes');
    check(`the editor opens the file in the ${theme} theme`,
      /assets:bank/.test(await tab.eval("document.querySelector('.ace_content').innerText")) && tab.errors.length === 0,
      tab.errors.join(' | '));
    check(`and its background is the theme's (${theme})`,
      (await tab.eval("getComputedStyle(document.querySelector('.ace_editor')).backgroundColor"))
        === (theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(251, 241, 199)'),
      await tab.eval("getComputedStyle(document.querySelector('.ace_editor')).backgroundColor"));
  }
  await tab.eval("document.querySelector('.ace_text-input').focus()");
  await tab.send('Input.insertText', { text: '; a note\n' });
  await sleep(100);
  check('typing marks the file as changed', (await status()) === 'Unsaved changes', await status());
  await save();
  check('Ctrl+S saves it through the app', (await status()) === 'Saved'
    && /^; a note\n2024-01-01/.test(await tab.eval('window.__saved[0] || ""')), await tab.eval('window.__saved[0] || ""'));
  await tab.eval("window.__refuse = 'it changed on disk since it was opened'");
  await tab.send('Input.insertText', { text: 'x' });
  await save();
  check('a refused save says why, and keeps the change', /changed on disk/.test(await tab.warning()) && (await status()) === '',
    `${await tab.warning()} / ${await status()}`);

  await tab.show('edit', 'light', '&writable=no');
  check('leaving an editor with unsaved changes asks first', tab.dialogs.includes('beforeunload'), tab.dialogs.join(','));
  check('a read-only file says so in its header', /read-only/.test(await tab.eval("document.querySelector('.hint').textContent")));
  await tab.eval("document.querySelector('.ace_text-input').focus()");
  await save();
  check('and a save says it has nowhere to write, in plain words', /nowhere to write\. Open its folder with open/.test(await tab.warning())
    && !(await tab.warning()).includes('`'), await tab.warning());

  await tab.show('edit', 'light', '&writable=yes');
  await tab.eval("Object.defineProperty(window, 'opener', { configurable: true, value: null })");
  await tab.eval("document.querySelector('.ace_text-input').focus()");
  await save();
  check('an editor whose app has gone says so', /lost touch with the app\. Run edit again\./.test(await tab.warning()), await tab.warning());

  await tab.show('edit', 'light', '&writable=yes&library=no');
  check('without Ace, the editor says it did not load', /editor did not load/.test(await tab.warning()), await tab.warning());
}

// ------------------------------------------------------------------ the run

const chrome = findChrome();
if (!chrome) {
  console.log('FAIL no Chrome found: put google-chrome or chromium on PATH, or set CHROME=/path/to/chrome');
  process.exit(1);
}
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'window-check-'));
const downloads = mkdtempSync(join(tmpdir(), 'chart-saved-'));
const { child, cdp } = await launch(chrome, profile);
let failure = null;
try {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const tab = await Tab.open(cdp, base);
  // Said once, here, rather than as a click that misses its target later.
  const lineHeight = await tab.eval(`(() => {
    const probe = document.createElement('span');
    probe.textContent = 'Reconcile 123';
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  })()`);
  if (!lineHeight) throw new Error('text lays out 0 pixels high, so this machine has no fonts Chrome can use: install one, or set FONTCONFIG_FILE');
  await everyChartDraws(tab);
  await theLineChart(tab);
  await zooming(tab);
  await byKeyboard(tab);
  await saving(tab, downloads);
  await relatedCharts(tab);
  await goingBack(tab);
  await moreCharts(tab);
  await moneyCharts(tab);
  await playing(tab);
  await whenThingsGoWrong(tab);
  await theEditor(tab);
  await reconciling(tab);
  await reconcileRunning(tab);
  await coverage.collect(tab);
  coverage.merge((await self.post('Profiler.takePreciseCoverage')).result);

  // The node check, run with its coverage written to a directory and merged in.
  const measured = mkdtempSync(join(tmpdir(), 'chart-coverage-'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./check-example-plugin.mjs', import.meta.url))], {
    env: { ...process.env, NODE_V8_COVERAGE: measured },
    encoding: 'utf8',
  });
  const verdict = (run.stdout || '').trim().split('\n').pop();
  check(`the node check passes too (${verdict})`, run.status === 0, (run.stdout || '') + (run.stderr || ''));
  for (const file of readdirSync(measured)) {
    coverage.merge(JSON.parse(readFileSync(join(measured, file), 'utf8')).result);
  }
  rmSync(measured, { recursive: true, force: true });
} catch (error) {
  failure = error;
} finally {
  child.kill();
  server.close();
  for (const directory of [profile, downloads]) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Chrome may still hold the profile for a moment; the directory is in tmp.
    }
  }
}
if (failure) {
  console.log(`FAIL the browser check stopped: ${failure.stack || failure}`);
  process.exit(1);
}

for (const { name, share } of coverage.report()) {
  check(`${name} is ${(100 * share).toFixed(1)}% executed (at least ${100 * FLOOR}%)`, share >= FLOOR, '');
}

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} browser checks passed`);
process.exit(failed === 0 ? 0 : 1);
