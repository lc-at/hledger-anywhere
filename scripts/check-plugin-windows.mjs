// Checks the plugins' windows in a real browser: every chart drawn and every way of using one,
// and the editor opening, saving, and refusing to.
//
// scripts/check-example-plugin.mjs checks what can be checked without a browser: commands,
// parsers, models, layouts. What it cannot reach is the half of the plugin that touches the
// DOM — the renderers, the tooltip, the legend, the keys, saving, drill-down — and that half
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

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import inspector from 'node:inspector/promises';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLORS, DARK, FLOWS_CSV, MONTHLY_CSV, RANKING_CSV, REGISTER_CSV, TREE_CSV, dailyCsv } from './chart-fixtures.mjs';

// This process writes every page, so its own coverage counts: it is measured from before the
// plugin's modules are loaded, which is why they are imported here and not above.
const self = new inspector.Session();
self.connect();
await self.post('Profiler.enable');
await self.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const { page } = await import('../assets/plugins/chart-window.js');
const { parseReport } = await import('../assets/plugins/chart.js');
const { page: editPage } = await import('../assets/plugins/edit-window.js');

const PLUGINS = fileURLToPath(new URL('../assets/plugins/', import.meta.url));
const MEASURED = ['chart.js', 'chart-d3.js', 'chart-ui.js', 'chart-window.js', 'chart-data.js', 'edit.js', 'edit-window.js', 'window-kit.js'];
/** The least each measured file's code may be executed, as a share of its source. */
const FLOOR = 0.9;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ the windows

/**
 * Each case is one window: a kind, a report in the engine's shape, and a theme. They are the
 * same calls the plugin makes, so what is drawn here is what a user would see.
 */
const CASES = {
  line: { kind: null, csv: MONTHLY_CSV, title: 'expenses', command: 'balance expenses -M -O csv' },
  daily: { kind: null, csv: dailyCsv(40), title: 'expenses daily', command: 'balance expenses -D -O csv' },
  networth: {
    kind: null, csv: MONTHLY_CSV, title: 'net worth', command: 'balance assets liabilities -H -M -O csv',
    options: { total: true, label: 'net worth' },
  },
  stacked: { kind: 'stacked', csv: MONTHLY_CSV, title: 'spending by category', command: 'balance expenses -M --depth 2 -O csv' },
  bar: {
    kind: null, csv: RANKING_CSV, title: 'top', command: 'balance expenses -O csv',
    related: [{ label: 'chart shares expenses', args: 'shares expenses' }, { label: 'chart treemap expenses', args: 'treemap expenses' }],
  },
  doughnut: { kind: 'shares', csv: RANKING_CSV, title: 'shares', command: 'balance expenses -O csv' },
  treemap: { kind: 'treemap', csv: TREE_CSV, title: 'where the money went', command: 'balance --tree expenses -O csv' },
  calendar: { kind: 'calendar', csv: REGISTER_CSV, title: 'daily spending', command: 'register -O csv' },
  waterfall: { kind: 'waterfall', csv: REGISTER_CSV, title: 'income to net', command: 'register -O csv' },
  multiples: { kind: 'multiples', csv: MONTHLY_CSV, title: 'accounts over time', command: 'balance -M -O csv' },
  sankey: { kind: 'sankey', csv: FLOWS_CSV, title: 'where income went', command: 'balance income expenses --depth 2 -O csv' },
};

function windowFor(name, theme, { library = true } = {}) {
  const entry = CASES[name];
  return page({
    report: parseReport(entry.kind, entry.csv),
    colors: theme === 'dark' ? DARK : COLORS,
    title: entry.title,
    command: entry.command,
    token: 'check',
    kind: entry.kind,
    options: entry.options || {},
    related: entry.related || [],
    module: '/plugins/chart-window.js',
    scripts: library ? ['/plugins/vendor/d3/d3.min.js'] : [],
  });
}

/**
 * What a drill-down gets back. The window asks the opener's bridge for an account; the answer
 * is a monthly report of it, which is what the plugin's bridge returns.
 */
const ANSWER = {
  report: parseReport(null, MONTHLY_CSV.replace('expenses:food:coffee', 'expenses:drilled')),
  command: 'balance expenses:drilled -M -O csv',
  options: {},
  kind: null,
};

// The page a window was opened by, stood in for: a chart bridge that records what it was asked
// and answers with ANSWER, after a moment, as hledger would; and an editor bridge that records
// what was saved, or refuses the way the app does when the file changed on disk.
const OPENER = `
  window.__asked = [];
  window.__saved = [];
  window.__refuse = '';
  Object.defineProperty(window, 'opener', { configurable: true, value: {
    __chartBridges: { check: {
      async requery(account) {
        window.__asked.push(account);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ...${JSON.stringify(ANSWER)}, title: account };
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

async function launch(chrome, profile) {
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1100,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    const path = name === 'edit' ? `/edit?theme=${theme}${extra}` : `/window?case=${name}&theme=${theme}${extra}`;
    await this.send('Page.navigate', { url: `${this.base}${path}` });
    await loaded;
    await this.until(name === 'edit'
      ? "document.querySelector('.ace_content') || !document.getElementById('warn').hidden"
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

  /** The centre of the first element matching a selector, in page coordinates. */
  async centre(selector, pick = 'first') {
    return this.eval(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = ${pick === 'last' ? 'all[all.length - 1]' : 'all[0]'};
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    })()`);
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
    line: 'path.line', daily: 'path.line', networth: 'path.line', stacked: 'path', bar: 'rect[role=button]',
    doughnut: 'path[role=button]', treemap: 'rect[role=button]', calendar: 'rect', waterfall: 'rect[role=button]',
    multiples: 'path', sankey: 'rect[role=button]',
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
  await tab.show('networth');
  check('a running total is filled', await tab.eval("document.querySelectorAll('#chart path.fill').length === 1"));
  await tab.show('treemap');
  check('the treemap draws one cell per leaf, not the parents',
    (await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")) === 3,
    String(await tab.eval("document.querySelectorAll('#chart rect[role=button]').length")));
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

  await tab.until("document.getElementById('heading').textContent === 'expenses:housing:rent'");
  check('a click on a line asks for that account, and charts it', (await tab.heading()) === 'expenses:housing:rent'
    && (await tab.eval('window.__asked.join()')) === 'expenses:housing:rent', `${await tab.heading()} ${await tab.eval('window.__asked.join()')}`);
  check('with the command it ran', (await tab.eval("document.getElementById('command').textContent")) === ANSWER.command);
  await tab.key('Escape', { keyCode: 27 });
  check('Escape goes back to the chart before', (await tab.heading()) === 'expenses', await tab.heading());
  await tab.key('Escape', { keyCode: 27 });
  check('and Escape with nowhere to go back to does nothing', (await tab.heading()) === 'expenses');

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
  for (const [name, expected] of [['bar', 'expenses:housing:rent'], ['doughnut', 'expenses:housing:rent'],
    ['treemap', 'expenses:food:coffee'], ['waterfall', 'income'], ['multiples', 'expenses:housing:rent'], ['sankey', 'income:salary']]) {
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
    check(`Enter on it charts that account (${name})`, asked === expected, String(asked));
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
  const svg = files.includes('hledger-expenses.svg') ? readFileSync(join(downloads, 'hledger-expenses.svg'), 'utf8') : '';
  check('s saves an SVG named after the chart', svg.startsWith('<?xml') && /xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(svg), files.join(','));
  check('with its title, subtitle and the legend of what is shown',
    svg.includes('>expenses<') && svg.includes('3 periods') && svg.includes('food:coffee') && !svg.includes('>expenses:housing:rent<'), '');
  check('and none of the interaction layers', svg && !svg.includes('data-transient'), '');
  const png = files.includes('hledger-expenses.png') ? readFileSync(join(downloads, 'hledger-expenses.png')) : Buffer.alloc(0);
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

async function relatedCharts(tab) {
  await tab.show('bar');
  const links = await tab.eval("[...document.querySelectorAll('#also a')].map(a => a.textContent).join(' | ')");
  check('a chart lists related charts under it, by the command each one is',
    links === 'chart shares expenses | chart treemap expenses' && !(await tab.eval("document.getElementById('also').hidden")), links);
  const link = await tab.centre('#also a', 'last');
  await tab.click(link[0], link[1]);
  await tab.until("document.getElementById('heading').textContent === 'treemap expenses'");
  check('clicking one charts it, through the app', (await tab.heading()) === 'treemap expenses'
    && (await tab.eval('window.__asked[window.__asked.length - 1]')) === 'treemap expenses', await tab.heading());
  check('and a chart with nothing related has no line for it', await tab.eval("document.getElementById('also').hidden"));
  await tab.key('Escape', { keyCode: 27 });
  check('Escape comes back, with the links where they were', (await tab.heading()) === 'top'
    && (await tab.eval("document.querySelectorAll('#also a').length")) === 2, await tab.heading());
  // A link is reached by Tab and followed with Enter, like the rest of the window.
  await tab.eval("document.querySelector('#also a').focus()");
  await tab.key('Enter', { keyCode: 13, text: '\r' });
  await tab.until("document.getElementById('heading').textContent === 'shares expenses'");
  check('Enter on a focused link follows it', (await tab.heading()) === 'shares expenses', await tab.heading());
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
  await everyChartDraws(tab);
  await theLineChart(tab);
  await zooming(tab);
  await byKeyboard(tab);
  await saving(tab, downloads);
  await relatedCharts(tab);
  await whenThingsGoWrong(tab);
  await theEditor(tab);
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
