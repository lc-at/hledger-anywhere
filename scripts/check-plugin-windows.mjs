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
const { GENERIC_JOURNAL, GENERIC_PRINT, RECONCILE_JOURNAL, RECONCILE_PRINT } = await import('./reconcile-fixtures.mjs');
const { liveChecks, liveRoute } = await import('./reconcile-live.mjs');
const RECONCILE_DATA = readReconcile(RECONCILE_PRINT, 'Assets:Bank:Checking');
// Each row carries its transaction's text, as the plugin gives it, for the editor.
for (const row of RECONCILE_DATA.rows) {
  row.text = RECONCILE_JOURNAL.split('\n').slice(row.where.first - 1, row.where.last - 1).join('\n').replace(/\s+$/, '');
}

// The same journal with its first two transactions marked, which is how most journals are
// kept: a `*` on the transaction line, and no mark on the postings under it. Used to check
// that the window opens on work already done as done, rather than as a backlog.
const RECONCILE_PRINT_MARKED = RECONCILE_PRINT.map((transaction) => (
  transaction.tindex === 2 || transaction.tindex === 3 ? { ...transaction, tstatus: 'Cleared' } : transaction
));
const RECONCILE_DATA_MARKED = readReconcile(RECONCILE_PRINT_MARKED, 'Assets:Bank:Checking');
for (const row of RECONCILE_DATA_MARKED.rows) {
  row.text = RECONCILE_JOURNAL.split('\n').slice(row.where.first - 1, row.where.last - 1).join('\n').replace(/\s+$/, '');
}

// The generic fixture: a journal carrying every kind of posting the window has to handle, so the
// window is checked against it too and not only against one shape of journal.
const RECONCILE_DATA_GENERIC = readReconcile(GENERIC_PRINT, 'assets:bank');
for (const row of RECONCILE_DATA_GENERIC.rows) {
  row.text = GENERIC_JOURNAL.split('\n').slice(row.where.first - 1, row.where.last - 1).join('\n').replace(/\s+$/, '');
}

const PLUGINS = fileURLToPath(new URL('../assets/plugins/', import.meta.url));
const MEASURED = ['reconcile.js', 'reconcile-data.js', 'reconcile-window.js', 'chart.js', 'chart-args.js', 'chart-d3.js', 'chart-more.js', 'chart-play.js', 'chart-ui.js', 'chart-window.js', 'chart-data.js', 'edit.js', 'edit-window.js', 'window-kit.js'];
/** The least each measured file's code may be executed, as a share of its source. */
const FLOOR = 0.9;
const ONLY = process.env.ONLY || '';

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

/**
 * The reconcile plugin's side of a window, stood in for. It runs in the page (it is written into
 * OPENER as source), keeps the account as the plugin would have it after each change, and
 * answers each change the way the plugin does: told 'writing' and then 'checking', a moment
 * apart, and then the account as hledger would read it back. Every request is kept in
 * window.__changed. Set window.__refuse to have a change refused, window.__throw to have the
 * bridge throw, window.__outside to a data object to have the next poll find the file changed,
 * window.__pollError to have it fail, window.__conflicts for a Finish preview's conflicts, and
 * window.__delay for how long each stage takes.
 */
function reconcileBridge({ journals, candidate }) {
  window.__changed = [];
  window.__history = [];
  window.__delay = 20;
  window.__outside = null;
  let made = 0;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const current = () => {
    if (!window.__data) window.__data = JSON.parse(document.getElementById('reconcile-data').textContent).data;
    return window.__data;
  };
  window.__current = () => copy(current());
  const kit = () => import('/plugins/reconcile-data.js');
  const named = (row) => `${row.date} ${row.description}`.trim();
  const together = (row, other) => other.where.file === row.where.file && other.where.first === row.where.first;
  const shift = (data, from, by) => {
    for (const row of data.rows) {
      if (row.where.first >= from) { row.where.first += by; row.where.last += by; }
    }
  };
  /** A row read from a transaction's text, as readPrint would make it. */
  const rowFrom = (tools, data, text, where, status) => {
    const read = tools.readTransaction(text, data.account, data.style, data.inclusive);
    made += 1;
    return {
      id: `w${made}:${data.account}:0`, date: read.date, description: read.description || '', account: data.account,
      against: read.against, amount: read.amount == null ? 0 : read.amount, counted: read.amount != null, stated: null,
      virtual: false, status, transactionMark: 'Unmarked', ownMark: status !== 'Unmarked', generated: false, ownDate: false,
      simple: true, other: read.against || null, where: { ...where, occurrence: 0 }, text,
    };
  };
  const byDate = (data) => {
    data.rows = data.rows.map((row, at) => ({ row, at })).sort((a, b) => (a.row.date < b.row.date ? -1 : a.row.date > b.row.date ? 1 : a.at - b.at)).map((entry) => entry.row);
  };

  /** One change, applied to `data` in place: the message to say, or `{ error }`. */
  const apply = (tools, data, request) => {
    const targets = request.targets || {};
    const find = (id) => {
      const row = data.rows.find((entry) => entry.id === id);
      const target = targets[id];
      // Found by what the window says it was, as the plugin does: a row whose text is not what
      // the window saw changed outside it.
      if (!row || !target || (target.text == null ? null : target.text) !== (row.text == null ? null : row.text)) return null;
      return row;
    };
    const gone = (id) => ({ error: `${targets[id] ? `${targets[id].date} ${targets[id].description}` : 'that line'} changed outside this window, so this change was not made. The window shows the file as it is now.` });
    switch (request.kind) {
      case 'tick': {
        const done = [];
        for (const change of request.changes || []) {
          const row = find(change.id);
          if (!row) return gone(change.id);
          const group = request.style === 'transaction' ? data.rows.filter((entry) => together(row, entry)) : [row];
          for (const entry of group) entry.status = change.on ? 'Cleared' : 'Unmarked';
          done.push({ row, on: change.on });
        }
        return { message: done.length === 1
          ? `${done[0].on ? 'Ticked' : 'Unticked'} ${named(done[0].row)}`
          : `${done.filter((entry) => entry.on).length} ticked, ${done.filter((entry) => !entry.on).length} unticked`.replace(/^0 ticked, |, 0 unticked$/g, '') };
      }
      case 'edit': {
        const row = find(request.id);
        if (!row) return gone(request.id);
        const text = String(request.text || '').replace(/\s+$/, '');
        const group = data.rows.filter((entry) => together(row, entry));
        if (!text) {
          data.rows = data.rows.filter((entry) => !together(row, entry));
          return { message: `Deleted ${named(row)}` };
        }
        const read = tools.readTransaction(text, data.account, data.style, data.inclusive);
        for (const entry of group) Object.assign(entry, { text, date: read.date || entry.date, description: read.description || '' });
        if (group.length === 1) Object.assign(row, { amount: read.amount == null ? 0 : read.amount, counted: read.amount != null, against: read.against });
        byDate(data);
        return { message: `Rewrote ${named(group[0])}` };
      }
      case 'insert': {
        const text = String(request.text || '').replace(/\s+$/, '');
        const read = tools.readTransaction(text, data.account, data.style, data.inclusive);
        const anchor = request.after ? find(request.after) : null;
        const place = tools.placement(tools.ordered(data), { anchor: anchor ? anchor.id : null, date: read.date });
        const beside = place && data.rows.find((entry) => entry.id === place.id);
        const size = text.split('\n').length;
        const file = (data.rows[0] && data.rows[0].where.file) || 'fixture.journal';
        const line = beside ? (place.side === 'after' ? beside.where.last : beside.where.first) : 999;
        shift(data, line, size + 1);
        // The plugin ticks what it adds: the line was added because the statement has it.
        const row = rowFrom(tools, data, text, { file, first: line, last: line + size }, 'Cleared');
        let at = data.rows.length;
        if (beside) {
          const group = data.rows.map((entry, index) => (together(beside, entry) ? index : -1)).filter((index) => index >= 0);
          at = place.side === 'after' ? group[group.length - 1] + 1 : group[0];
        }
        data.rows.splice(at, 0, row);
        return { message: `Added ${read.date} ${read.description || ''}`.trim(), focus: row.id };
      }
      case 'date': {
        const row = find(request.id);
        if (!row) return gone(request.id);
        const refused = tools.moveRefusal(data, request.date);
        if (refused) return { error: `Cannot move it to ${request.date}: it is ${refused}.` };
        for (const entry of data.rows.filter((other) => together(row, other))) {
          entry.date = request.date;
          entry.text = String(entry.text || '').replace(/^\d{4}-\d{2}-\d{2}/, request.date);
        }
        byDate(data);
        return { message: `Moved ${row.description} to ${request.date}` };
      }
      case 'reorder': {
        const row = find(request.id);
        if (!row) return gone(request.id);
        const where = tools.neighbour(tools.ordered(data), row.id, request.direction);
        if (where.refused) return { error: `${row.description} stays where it is: ${where.refused}.` };
        const next = data.rows.find((entry) => entry.id === where.to.id);
        const mine = data.rows.filter((entry) => together(row, entry));
        const theirs = data.rows.filter((entry) => together(next, entry));
        const size = (group) => group[0].where.last - group[0].where.first;
        const [aFirst, bFirst] = [mine[0].where.first, theirs[0].where.first];
        const up = request.direction !== 'down';
        const moveBy = (group, to) => { const by = to - group[0].where.first; for (const entry of group) { entry.where.first += by; entry.where.last += by; } };
        if (up) { moveBy(mine, bFirst); moveBy(theirs, bFirst + size(mine)); } else { moveBy(theirs, aFirst); moveBy(mine, aFirst + size(theirs)); }
        const rest = data.rows.filter((entry) => !mine.includes(entry));
        const at = up ? rest.indexOf(theirs[0]) : rest.indexOf(theirs[theirs.length - 1]) + 1;
        rest.splice(at, 0, ...mine);
        data.rows = rest;
        return { message: `Moved ${row.description} ${up ? 'up' : 'down'} within ${row.date}` };
      }
      case 'account': {
        const found = request.candidate || {};
        const after = tools.moveAccount(found.text, request.at, data.account);
        if (!after) return { error: 'That posting is not in the transaction any more.' };
        const parts = tools.parsePosting(String(found.text).split('\n')[request.at]);
        const row = rowFrom(tools, data, after, { file: found.file, first: found.first, last: found.last }, 'Unmarked');
        data.rows.push(row);
        byDate(data);
        return { message: `Moved ${found.description}'s ${parts.account} posting to ${data.account}`, focus: row.id };
      }
      case 'finish':
        return { message: `${data.account} reconciled to ${(request.finish || {}).date}` };
      default:
        return { error: `${request.kind} is not a change this window makes.` };
    }
  };

  const journalOf = (path) => (Object.prototype.hasOwnProperty.call(journals, path) ? journals[path] : null);
  const assertion = (finish) => `${finish.date} * Reconciled with statement\n    Assets:Bank:Checking    0.00 IDR = ${(Number(finish.balance) / 100).toFixed(2)} IDR\n`;

  return {
    // What Finish would write. A request with a kind is a writable window's Finish, against the
    // file as it is now; one without is a read-only window's own ticks, edits and new lines.
    preview(request) {
      window.__previewed.push(request);
      window.__lastPreview = request;
      const writable = [{ path: 'fixture.journal', writable: window.__writable }];
      if (request.kind === 'finish') {
        return {
          files: [{ path: 'fixture.journal', changes: [], appended: assertion(request.finish), inserted: [], replaced: [] }],
          missing: [], assertion: '', writable, conflicts: window.__conflicts || [],
        };
      }
      return {
        files: [{ path: 'fixture.journal', changes: [
          ...Object.entries(request.moved || {}).slice(0, 1).map(([id, date]) => ({ line: 7, before: '2026-09-01 * Coffee', after: `${date} * Coffee`, id })),
          ...request.ticked.map((id, index) => ({ line: 9 + index, before: '    Assets:Bank:Checking', after: '  * Assets:Bank:Checking', id })),
        ],
          appended: request.finish ? assertion(request.finish) : '',
          replaced: Object.entries(request.edits || {}).map(([, edit], at) => ({ line: 7 + at * 4, before: 'old text\n    of it', after: edit.text })),
          inserted: (request.inserts || []).map((insert) => ({ line: 24, text: insert.text })) }],
        missing: [],
        writable,
      };
    },
    setStyle(style) {
      window.__styleSet = style;
      return style;
    },
    setLines(on) {
      window.__linesSet = on;
      return on;
    },
    async change(request, progress) {
      window.__changed.push(copy(request));
      if (window.__throw) throw new Error(window.__throw);
      const tools = await kit();
      progress('writing');
      await wait(window.__delay);
      progress('checking');
      await wait(window.__delay);
      if (window.__refuse) return { error: window.__refuse, data: copy(current()) };
      const data = copy(current());
      const done = apply(tools, data, copy(request));
      if (done.error) return { error: done.error, data: copy(current()) };
      window.__history.push({ data: current(), message: done.message });
      window.__data = data;
      return { ok: true, message: done.message, data: copy(data), undo: window.__history.length, focus: done.focus || null, outside: Boolean(window.__outsideOnChange) };
    },
    async undo(progress) {
      window.__changed.push({ kind: 'undo' });
      progress('writing');
      await wait(window.__delay);
      progress('checking');
      await wait(window.__delay);
      const last = window.__history.pop();
      if (!last) return { error: 'Nothing to undo: no change has been written from this window.', data: copy(current()), undo: 0 };
      window.__data = last.data;
      return { ok: true, message: `Undid: ${last.message}`, data: copy(last.data), undo: window.__history.length };
    },
    poll() {
      window.__polled = (window.__polled || 0) + 1;
      if (window.__pollError) {
        const error = window.__pollError;
        window.__pollError = null;
        return { changed: true, error };
      }
      if (!window.__outside) return { changed: false };
      window.__data = copy(window.__outside);
      window.__outside = null;
      window.__history = [];
      return { changed: true, data: copy(window.__data) };
    },
    source(path) {
      window.__sourced = path;
      return journalOf(path);
    },
    async find(request) {
      window.__found = request;
      await wait(window.__delay);
      if (request.amount == null && !String(request.words || '').trim()) return { candidates: [], error: 'Give an amount, or some words from the description, to look for.' };
      if (/nothing/.test(request.words || '')) return { candidates: [] };
      return { candidates: [copy(candidate)] };
    },
  };
}

// A transaction under another account, for Find a transaction to turn up: at the end of the
// fixture's file as the bridge shows it, shaped as rankCandidates gives it, with its text and
// each posting's line in that text, as the plugin adds them.
const FOUND_TEXT = '2026-09-04 Bank fee\n    Expenses:Fees    75000 IDR\n    Assets:Cash    -75000 IDR';
const FOUND = {
  file: 'fixture.journal', first: 29, last: 32, date: '2026-09-04', description: 'Bank fee', score: 6, apart: 1,
  reasons: ['the amount', '1 day from the date'], text: FOUND_TEXT,
  postings: [
    { account: 'Expenses:Fees', amount: '75,000.00 IDR', matches: true, virtual: false, generated: false, at: 1 },
    { account: 'Assets:Cash', amount: '-75,000.00 IDR', matches: true, virtual: false, generated: false, at: 2 },
  ],
};
const BRIDGE_FIXTURES = {
  journals: { 'fixture.journal': `${RECONCILE_JOURNAL}\n${FOUND_TEXT}\n`, 'generic.journal': GENERIC_JOURNAL },
  candidate: FOUND,
};

// The page a window was opened by, stood in for: a chart bridge that records what it was asked
// and answers with ANSWER, after a moment, as hledger would; a reconcile bridge (above); and an
// editor bridge that records what was saved, or refuses the way the app does when the file
// changed on disk.
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
    __reconcileBridges: { check: (${reconcileBridge.toString()})(${JSON.stringify(BRIDGE_FIXTURES)}) },
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

/**
 * A print with `count` postings to the account, built rather than run.
 *
 * The window renders from what the page is handed, so timing it does not need the engine; it
 * needs the shape the engine would produce. The first transaction is an opening assertion so
 * the arithmetic has somewhere to start.
 */
function syntheticPrint(count) {
  const style = { ascommodityside: 'R', ascommodityspaced: true, asdecimalmark: '.', asprecision: 2 };
  const amount = (minor) => [{ acommodity: 'IDR', aquantity: { decimalMantissa: minor, decimalPlaces: 2 }, astyle: style }];
  const transactions = [{
    tindex: 1, tdate: '2026-01-01', tdescription: 'Opening', tstatus: 'Unmarked',
    tsourcepos: [{ sourceName: '/fixture.journal', sourceLine: 3 }, { sourceName: '/fixture.journal', sourceLine: 6 }],
    tpostings: [
      { paccount: 'Assets:Bank:Checking', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: amount(100000),
        pbalanceassertion: { baamount: { acommodity: 'IDR', aquantity: { decimalMantissa: 100000, decimalPlaces: 2 }, astyle: style } } },
      { paccount: 'Equity:Opening', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: amount(-100000), pbalanceassertion: null },
    ],
  }];
  let line = 7;
  for (let index = 0; index < count; index += 1) {
    const day = String(1 + (index % 27)).padStart(2, '0');
    const month = String(1 + (index % 12)).padStart(2, '0');
    transactions.push({
      tindex: index + 2, tdate: `2026-${month}-${day}`, tdescription: `Row ${index}`, tstatus: 'Unmarked',
      tsourcepos: [{ sourceName: '/fixture.journal', sourceLine: line }, { sourceName: '/fixture.journal', sourceLine: line + 2 }],
      tpostings: [
        { paccount: 'Expenses:Food', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: amount(-(index + 1) * 100), pbalanceassertion: null },
        { paccount: 'Assets:Bank:Checking', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: amount((index + 1) * 100), pbalanceassertion: null },
      ],
    });
    line += 3;
  }
  return transactions;
}

// ------------------------------------------------------------------ a server and a browser

function serve() {
  const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://check');
    // The reconcile plugin run for real, against files on disk and the shipped engine.
    if (await liveRoute(url, request, response, { COLORS, DARK })) return;
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
        data: url.searchParams.get('many')
          ? readReconcile(syntheticPrint(Number(url.searchParams.get('many')) || 0), 'Assets:Bank:Checking')
          : url.searchParams.get('generic') ? RECONCILE_DATA_GENERIC
            : url.searchParams.get('marked') ? RECONCILE_DATA_MARKED : RECONCILE_DATA,
        colors: theme === 'dark' ? DARK : COLORS, token: 'check',
        files: [{ path: 'fixture.journal', writable: url.searchParams.get('writable') !== 'no' }],
        statementDate: '2026-09-30', statementBalance: url.searchParams.get('balance') || '', fingerprint: 'before',
        lines: url.searchParams.get('lines') === 'on',
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
    const path = name === 'edit' ? `/edit?theme=${theme}${extra}` : name === 'reconcile' ? `/reconcile?theme=${theme}${extra}` : name === 'live' ? `/live?theme=${theme}${extra}` : `/window?case=${name}&theme=${theme}${extra}`;
    await this.send('Page.navigate', { url: `${this.base}${path}` });
    await loaded;
    await this.until(name === 'edit'
      ? "document.querySelector('.ace_content') || !document.getElementById('warn').hidden"
      : name === 'reconcile' || name === 'live' ? "document.getElementById('rows') && document.querySelectorAll('#rows tr').length > 0"
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

  async key(key, { code = key, keyCode = 0, text, modifiers = 0 } = {}) {
    // `modifiers` is the CDP bit field: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift... as the browser sees
    // them, so a chord reaches the page the way a real keyboard sends it.
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
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

/**
 * Waits for the window to finish writing: nothing marked as being written, and the status no
 * longer busy. A change goes out the moment it is made, so a check reads the window after it.
 */
const writesDone = (tab) => tab.until("!document.querySelector('#rows tr.writing') && !document.getElementById('status').classList.contains('busy')");

async function reconciling(tab) {
  const text = (id) => tab.eval(`document.getElementById('${id}').innerText`);
  const difference = () => tab.eval("document.querySelector('#difference b').textContent");
  const type = (id, value) => tab.eval(`(() => { const el = document.getElementById('${id}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); })()`);
  const done = () => writesDone(tab);
  const changed = () => tab.eval('window.__changed');
  const tickRow = async (index) => {
    const ticked = await tab.eval(`(() => {
      const row = document.querySelectorAll('#rows tr[data-id]')[${index}];
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!ticked) throw new Error(`there is no row ${index} to tick`);
  };
  for (const theme of ['light', 'dark']) {
    await tab.show('reconcile', theme);
    check(`the reconcile window lists the account's postings since its last assertion (${theme})`,
      (await tab.eval("document.querySelectorAll('#rows tr').length")) === 6
      && /^6 postings in IDR, since the balance asserted on 2026-08-31\. Changes are written to the file as you make them\.$/.test(await text('sub')) && tab.errors.length === 0,
      `${await text('sub')} ${tab.errors.join(' | ')}`);
  }
  check('it opens at the opening balance, with nothing typed for the statement yet',
    /opening 1,000,000\.00 IDR/i.test(await text('figures')) && /cleared to 2026-09-30/.test(await text('figures'))
    // Nothing has been typed for the statement yet, so the difference says nothing at all:
    // a dash where the number will be reads as a broken field rather than as a waiting one.
    && (await text('difference')).trim() === '', `${await text('figures')} | "${await text('difference')}"`);
  check('a writable window offers no Save: each change is written as it is made',
    !(await tab.eval("document.getElementById('progress') || document.getElementById('pending')")) && /u undo/.test(await tab.eval("document.querySelector('.keys').textContent")), '');
  // Where one day's postings end and the next begin, a heavier rule than the hairline between
  // postings, so the eye can find the day boundaries in a long list.
  const days = await tab.eval(`(() => {
    const trs = [...document.querySelectorAll('#rows tr[data-id]')];
    const marked = trs.map((tr, at) => ({ date: tr.querySelector('td.date').textContent, day: tr.classList.contains('day'), at }));
    const boundary = trs.find((tr) => tr.classList.contains('day'));
    return {
      dates: marked.map((entry) => entry.date),
      markedAt: marked.filter((entry) => entry.day).map((entry) => entry.at),
      firstIsMarked: marked[0].day,
      boundaryTop: boundary ? parseFloat(getComputedStyle(boundary.querySelector('td')).borderTopWidth) : 0,
      ordinaryTop: parseFloat(getComputedStyle(trs[0].querySelector('td')).borderTopWidth),
    };
  })()`);
  check('a heavier rule marks where the day changes, and not before the first row',
    JSON.stringify(days.markedAt) === JSON.stringify([1, 2, 3, 5]) && days.firstIsMarked === false, JSON.stringify(days));
  check('and it is visibly heavier than the ordinary hairline',
    days.boundaryTop > days.ordinaryTop && days.boundaryTop >= 2, `${days.boundaryTop} vs ${days.ordinaryTop}`);
  // The bar carries the figures and the difference; the table carries no column for ticking,
  // because a line says its own state instead.
  const shape = await tab.eval(`(() => {
    const row = document.querySelector('#rows tr[data-id]');
    return {
      figures: document.getElementById('figures').innerText,
      difference: document.getElementById('difference').innerText,
      hasDifference: document.getElementById('difference') !== null,
      columns: document.querySelectorAll('thead th').length,
      tickColumn: document.querySelector('thead th.tick') !== null,
      role: row.getAttribute('role'),
      checked: row.getAttribute('aria-checked'),
      label: row.getAttribute('aria-label'),
      draggable: row.getAttribute('draggable'),
      grip: document.querySelector('.grip') !== null,
    };
  })()`);
  check('the bar has the figures and the difference, and the table has no column for ticking',
    /opening 1,000,000\.00 IDR/.test(shape.figures) && /cleared to 2026-09-30/.test(shape.figures)
    && shape.hasDifference && !/journal/i.test(shape.figures)
    && shape.columns === 6 && shape.tickColumn === false, JSON.stringify(shape));
  check('a line is a checkbox with a name of its own, so ticking needs no column',
    shape.role === 'checkbox' && shape.checked === 'false' && /2026-09-01/.test(shape.label)
    && /not cleared/.test(shape.label), JSON.stringify(shape));
  check('and nothing on a line drags: a date is changed by editing it',
    shape.draggable === null && shape.grip === false, JSON.stringify(shape));

  // Someone opening this for the first time sees a table and empty boxes, so the one thing to
  // do first is said out loud, and the cursor is already where that happens.
  check('opening it says what to do first, and puts the cursor there',
    /statement's closing balance/.test(await text('next')) && (await tab.eval('document.activeElement.id')) === 'balance', await text('next'));
  check('a posting after the statement date is faded, and said', (await tab.eval("document.querySelectorAll('#rows tr.later').length")) === 1 && /^1 line after the statement date is greyed out and not counted\.$/.test(await text('notes')), await text('notes'));
  await type('balance', '5,670,000');
  check('and the line follows the state, counting what is left to account for',
    /4,670,000\.00 IDR still to account for/.test(await text('next')), await text('next'));
  check('with the statement balance typed, the difference is there', (await difference()) === '4,670,000.00 IDR', await difference());

  // Four quick clicks: the first is written at once, and the three made while it is being
  // written go together in the next write, each row once.
  await tab.eval('window.__delay = 150');
  const clicked = await tab.eval(`(() => {
    const rows = document.querySelectorAll('#rows tr[data-id]');
    for (const index of [0, 1, 3, 4]) rows[index].click();
    const first = rows[0];
    return {
      on: document.querySelectorAll('#rows tr.on').length,
      writing: first.classList.contains('writing'), busy: first.getAttribute('aria-busy'),
      status: document.getElementById('status').textContent, spinning: document.getElementById('status').classList.contains('busy'),
    };
  })()`);
  check('a tick shows at once, and the row and the status say it is being written',
    clicked.on === 4 && clicked.writing && clicked.busy === 'true' && clicked.status === 'Writing to the file…' && clicked.spinning, JSON.stringify(clicked));
  const checking = await tab.until("document.getElementById('status').textContent === 'Checking with hledger…'");
  check('then that it is being checked with hledger', checking, await text('status'));
  await done();
  await tab.eval('window.__delay = 20');
  const sent = await changed();
  const coffee = sent[0] && sent[0].targets && sent[0].targets['2:Assets:Bank:Checking:0'];
  check('a tick sends one change, with the row as the window saw it, its text included',
    sent.length === 2 && sent[0].kind === 'tick' && JSON.stringify(sent[0].changes) === JSON.stringify([{ id: '2:Assets:Bank:Checking:0', on: true }])
    && sent[0].style === 'posting' && coffee && coffee.text === '2026-09-01 Coffee\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking'
    && coffee.first === 7 && coffee.file === 'fixture.journal' && coffee.description === 'Coffee', JSON.stringify(sent[0]));
  check('and the ticks made while it was written go together in one write after it',
    sent[1] && sent[1].kind === 'tick' && sent[1].changes.map((change) => `${change.id}=${change.on}`).join() === '3:Assets:Bank:Checking:0=true,5:Assets:Bank:Checking:0=true,5:Assets:Bank:Checking:1=true'
    && Object.keys(sent[1].targets).length === 3, JSON.stringify(sent[1]));
  check('a click ticks a posting and the difference follows, as the file now says',
    (await difference()) === '-300,000.00 IDR' && (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 4
    && /^3 ticked\.Undo$/.test(await text('status')), `${await difference()} ${await text('status')}`);
  check('a posting that is exactly the difference is pointed out, and lit',
    /Pending transfer -300,000\.00 IDR: not ticked, and exactly the difference/.test(await text('hints')) && (await tab.eval("document.querySelectorAll('#rows tr.hinted').length")) === 1, await text('hints'));
  check('Finish waits for a difference of zero', await tab.eval("document.getElementById('finish').disabled"));
  await tickRow(5);
  check('a later posting cannot be ticked, and nothing is written for it',
    (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 4 && (await changed()).length === 2, '');
  // The keyboard: down to the pending transfer, and Space.
  await tab.eval("document.activeElement && document.activeElement.blur()");
  for (let step = 0; step < 3; step += 1) await tab.key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
  await tab.key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await done();
  check('j, k and Space tick from the keyboard, and at zero the difference is lit',
    (await difference()) === '0.00 IDR' && (await tab.eval("document.querySelector('#difference').classList.contains('zero')")) && !(await tab.eval("document.getElementById('finish').disabled")), await difference());
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await done();
  check('a second Space unticks it in the file too',
    (await changed()).slice(-1)[0].changes[0].on === false && /^Unticked 2026-09-03 Pending transfer\./.test(await text('status')), await text('status'));
  await type('balance', '5,970,000');
  check('at zero with a posting left out, Finish says why it waits',
    (await difference()) === '0.00 IDR' && (await tab.eval("document.getElementById('finish').disabled")) && /^1 line up to the statement date is not ticked; an assertion counts every one/.test(await text('notes')), await text('notes'));
  await type('balance', '5,670,000');
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await done();
  check('a ticks every posting shown up to the date, in one write of the ones not yet ticked',
    (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 5 && (await difference()) === '0.00 IDR'
    && JSON.stringify((await changed()).slice(-1)[0].changes) === JSON.stringify([{ id: '4:Assets:Bank:Checking:0', on: true }]), JSON.stringify((await changed()).slice(-1)[0]));
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
    /fixture\.journal: at the end:/.test(await text('preview')) && /= 5670000\.00 IDR/.test(await text('preview'))
    && !(await changed()).some((request) => request.kind === 'finish'), await text('preview'));
  check('and asks the plugin for a finish against the file as it is, with the statement',
    await tab.eval("(() => { const r = window.__previewed.pop(); return r.kind === 'finish' && r.finish.date === '2026-09-30' && r.finish.balance === 567000000 && r.style === 'posting' && !r.ticked; })()"),
    await tab.eval('JSON.stringify(window.__lastPreview)'));
  await tab.eval('window.__delay = 200');
  const pressed = await tab.eval(`(() => {
    const apply = document.getElementById('apply');
    apply.click();
    apply.click();
    return { disabled: apply.disabled, said: apply.textContent, cancel: document.getElementById('cancel').disabled };
  })()`);
  check('Write and check is disabled the moment it is pressed, and says it is writing',
    pressed.disabled && pressed.said === 'Writing to the file…' && pressed.cancel, JSON.stringify(pressed));
  const checked = await tab.until("document.getElementById('apply') && document.getElementById('apply').textContent === 'Checking with hledger…'");
  check('then that hledger is checking it', checked, '');
  await tab.until("/reconciled/.test(document.getElementById('status').textContent)");
  await tab.eval('window.__delay = 20');
  const finishes = (await changed()).filter((request) => request.kind === 'finish');
  check('the finish goes through the plugin once, and the window says so and puts the preview away',
    /^Assets:Bank:Checking reconciled to 2026-09-30\.$/.test(await text('status')) && finishes.length === 1
    && finishes[0].finish.balance === 567000000 && (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 5
    && (await tab.eval("document.getElementById('preview').hidden")), `${await text('status')} ${JSON.stringify(finishes)}`);
  check('and a finish is not offered to undo', !(await tab.eval("document.getElementById('undo')")), await text('status'));
  await tab.eval("window.__refuse = 'hledger refused the result, so the files were put back as they were: Balance assertion failed'");
  await tickRow(0);
  await done();
  check('a refused change is shown as it came, and the line goes back to what the file says',
    /put back as they were/.test(await text('status')) && (await tab.eval("document.getElementById('status').classList.contains('error')"))
    && (await tab.eval("document.querySelectorAll('#rows tr[data-id]')[0].classList.contains('on')")), await text('status'));
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  await tab.eval("document.getElementById('apply').click()");
  await tab.until("document.getElementById('apply-said').textContent.length > 0");
  const refusedFinish = await tab.eval("({ said: document.getElementById('apply-said').textContent, label: document.getElementById('apply').textContent, disabled: document.getElementById('apply').disabled, cancel: document.getElementById('cancel').disabled })");
  check('a refused finish says why beside its button, and the button can be pressed again',
    /put back as they were/.test(refusedFinish.said) && refusedFinish.label === 'Write and check' && !refusedFinish.disabled && !refusedFinish.cancel, JSON.stringify(refusedFinish));
  await tab.eval("document.getElementById('cancel').click()");
  check('Cancel puts the preview away', await tab.eval("document.getElementById('preview').hidden"));
  await tab.eval("window.__refuse = ''");
  await tab.eval("document.getElementById('undo').click()");
  await done();
  check('Undo beside the message takes the last change back out of the file',
    /^Undid: Assets:Bank:Checking reconciled to 2026-09-30\./.test(await text('status')) && (await changed()).slice(-1)[0].kind === 'undo', await text('status'));
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('u', { code: 'KeyU', keyCode: 85, text: 'u' });
  await done();
  check('and u undoes the one before it, the window following the file',
    /^Undid: Ticked 2026-09-03 Pending transfer\./.test(await text('status'))
    && (await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Pending transfer/.test(tr.textContent)).getAttribute('aria-checked')")) === 'false', await text('status'));

  await tab.show('reconcile', 'light', '&writable=no&balance=5670000');
  check('in a read-only file, read-only is said once at the top, nothing offers to write, and Finish shows the assertion',
    (await tab.eval("document.getElementById('finish').textContent")) === 'Show the assertion'
    && /^Read-only: fixture\.journal did not come from an opened folder.*Run open in the terminal/.test(await text('readonly'))
    && !/read-only/i.test(await text('next')) && !/written to the file/.test(await text('sub'))
    && !/undo/.test(await tab.eval("document.querySelector('.keys').textContent")), await text('readonly'));
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await tab.key('u', { code: 'KeyU', keyCode: 85, text: 'u' });
  check('and its ticks stay in the window: nothing is sent to be written',
    (await tab.eval("document.querySelectorAll('#rows tr.on').length")) === 5 && (await changed()).length === 0, JSON.stringify(await changed()));
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  check('and its preview says why nothing can be written, with no write button',
    /did not come from an opened folder/.test(await text('preview')) && !(await tab.eval("document.getElementById('apply')")) && (await tab.eval("!!document.getElementById('copy')"))
    && (await tab.eval('window.__lastPreview.ticked.length')) === 5, await text('preview'));
  await tab.eval("document.getElementById('copy').click()");
  await tab.until("document.getElementById('status').textContent.length > 0");
  check('and copying says what happened', /Copied|Copying was not allowed/.test(await text('status')), await text('status'));

  // The line under the keyboard is ringed, and Space ticks it: the two things that make a
  // checkbox a checkbox rather than a colour. It gets a window of its own, because ticking a
  // line and moving the focus are both things the checks above depend on not having happened.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('u', { code: 'KeyU', keyCode: 85, text: 'u' });
  check('u with nothing written yet says there is nothing to undo, and sends nothing',
    /^Nothing to undo: no change has been written from this window\.$/.test(await text('status')) && (await changed()).length === 0, await text('status'));
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40 });
  const keyboard = await tab.eval(`(() => {
    const row = document.activeElement;
    return { tag: row.tagName, outline: getComputedStyle(row).outlineWidth };
  })()`);
  check('the line under the keyboard is focused and drawn with a focus ring',
    keyboard.tag === 'TR' && parseFloat(keyboard.outline) >= 2, JSON.stringify(keyboard));
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await done();
  const tickedBySpace = await tab.eval("({ checked: document.querySelectorAll('#rows tr[data-id]')[1].getAttribute('aria-checked'), focused: document.activeElement === document.querySelectorAll('#rows tr[data-id]')[1] })");
  check('Space ticks the line that has focus, and it keeps the focus once written', tickedBySpace.checked === 'true' && tickedBySpace.focused, JSON.stringify(tickedBySpace));
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  await done();
  const untickedBySpace = await tab.eval("document.querySelectorAll('#rows tr[data-id]')[1].getAttribute('aria-checked')");
  check('and a second Space takes it off again', untickedBySpace === 'false', String(untickedBySpace));

  // Another program changes the file: the window reads it again, keeps its place and what was
  // being typed in an open editor, and says so.
  await tab.show('reconcile', 'dark', '&balance=5670000');
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await tab.eval("(() => { const area = document.querySelector('tr.editor textarea'); area.value = '2026-09-01 Coffee, typed'; area.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await tab.eval(`(() => {
    const data = window.__current();
    data.rows.find((row) => row.description === 'Salary').status = 'Cleared';
    window.__outside = data;
    window.dispatchEvent(new Event('focus'));
  })()`);
  await tab.until("/changed outside/.test(document.getElementById('status').textContent)");
  const outside = await tab.eval(`({
    salary: [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Salary/.test(tr.textContent)).getAttribute('aria-checked'),
    draft: (document.querySelector('tr.editor textarea') || {}).value,
    status: document.getElementById('status').textContent,
  })`);
  check('a change made outside the window is read in when it is looked at again, and what was being typed is kept',
    outside.salary === 'true' && outside.draft === '2026-09-01 Coffee, typed' && outside.status === 'The file changed outside this window, so it was read again.', JSON.stringify(outside));
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  await tab.eval("(() => { window.__pollError = 'The file changed outside this window, and hledger cannot read it as it is now: a parse error'; window.dispatchEvent(new Event('focus')); })()");
  await tab.until("document.getElementById('status').classList.contains('error')");
  check('and a file hledger cannot read is said', /hledger cannot read it as it is now/.test(await text('status')), await text('status'));
  await tab.eval('window.__outsideOnChange = true');
  await tickRow(0);
  await done();
  check('a change that found the file changed first says it was read again',
    /^Ticked 2026-09-01 Coffee\. The file had changed outside this window, and was read again first\./.test(await text('status')), await text('status'));
  await tab.eval("(() => { window.__outsideOnChange = false; window.__throw = 'the app went away'; })()");
  await tickRow(2);
  await done();
  check('a bridge that does not answer is said',
    /^The app did not answer: the app went away/.test(await text('status')), await text('status'));
  await tab.eval("(() => { window.__throw = ''; delete window.opener.__reconcileBridges.check.change; })()");
  await tickRow(2);
  check('and a window whose app has gone says to run reconcile again',
    /lost touch with the app\. Run reconcile again\./.test(await text('status')), await text('status'));
}


// The generic fixture: a journal carrying every kind of posting the window has to handle, so the
// window itself is checked against it and not only against one shape of journal.
async function reconcileGeneric(tab) {
  await tab.show('reconcile', 'dark', '&generic=yes&balance=15640');
  const seen = await tab.eval(`(() => {
    const rows = [...document.querySelectorAll('#rows tr[data-id]')];
    return {
      notes: document.getElementById('notes').innerText,
      amounts: rows.map((tr) => tr.children[2].textContent.trim()),
      states: rows.map((tr) => (tr.querySelector('.state') || { textContent: '' }).textContent),
      lastBalance: rows[rows.length - 1].children[3].textContent.trim(),
      virtual: rows.filter((tr) => /Cash set aside|Money set aside/.test(tr.textContent)).length,
    };
  })()`);
  check('it says which commodity it counts and how to count another one',
    /Counting IDR/.test(seen.notes) && /--commodity USD/.test(seen.notes), JSON.stringify(seen.notes));
  check('a line in another commodity is shown with its own amount, and leaves the balance alone',
    seen.amounts.includes('100 USD') && seen.amounts.includes('-25.00 USD') && seen.lastBalance === '15,640.00',
    JSON.stringify({ amounts: seen.amounts, last: seen.lastBalance }));
  // The cleared ones are hidden until asked for, so only one virtual line is up at first and
  // nothing visible is marked cleared. Showing them brings back the rest, marks and all.
  check('the virtual lines are listed like any other, and the pending marks are said on them',
    seen.virtual === 1 && seen.states.includes('pending') && !seen.states.includes('cleared'),
    JSON.stringify(seen));
  const revealed = await tab.eval(`(() => {
    document.querySelector('[data-toggle-hidden]').click();
    const rows = [...document.querySelectorAll('#rows tr[data-id]')];
    return {
      virtual: rows.filter((tr) => /Cash set aside|Money set aside/.test(tr.textContent)).length,
      tinted: rows.filter((tr) => tr.classList.contains('on')).length,
      states: rows.map((tr) => (tr.querySelector('.state') || { textContent: '' }).textContent),
      line: document.getElementById('hidden').innerText,
    };
  })()`);
  // Cleared is the tint rather than a word: three lines were cleared when the window opened and
  // they come back tinted, with no "cleared" on any of them, while pending and not counted stay
  // words. The row still says cleared to a screen reader through aria-checked and its label.
  check('showing them brings back the cleared lines, virtual ones included',
    revealed.virtual === 2 && revealed.tinted === 3 && !revealed.states.includes('cleared')
    && revealed.states.includes('pending') && revealed.states.includes('not counted')
    && /hide them/.test(revealed.line), JSON.stringify(revealed));
}

// A sticky bar that eats a third of the screen is worse than no sticky header, so the narrow
// window is measured rather than eyeballed: the bar has to stay within a quarter of the height,
// and the table has to keep its columns rather than lose them to the squeeze.
async function reconcileNarrow(tab) {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 620, height: 1000, deviceScaleFactor: 1, mobile: false });
  try {
    await tab.show('reconcile', 'dark', '&generic=yes');
    const measured = await tab.eval(`(() => {
      const bar = document.querySelector('.bar');
      return {
        bar: Math.round(bar.getBoundingClientRect().height),
        quarter: Math.round(window.innerHeight / 4),
        columns: document.querySelectorAll('thead th').length,
        scroll: document.querySelector('.table').scrollWidth > document.querySelector('.table').clientWidth,
      };
    })()`);
    check('at 620px the bar stays within a quarter of the screen', measured.bar <= measured.quarter,
      JSON.stringify(measured));
    // Columns are never lost to the squeeze. With the line-by-line columns drawn the table is
    // wider than the window and scrolls for them; with them off it fits without scrolling, which
    // is also correct, so the scroll is checked in the mode that needs it.
    check('and the table keeps its columns rather than losing them to the squeeze',
      measured.columns === 6, JSON.stringify(measured));
    const scrolled = await tab.eval(`(() => {
      const box = document.getElementById('lines');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      const table = document.querySelector('.table');
      return { scroll: table.scrollWidth > table.clientWidth, columns: document.querySelectorAll('thead th').length };
    })()`);
    check('and with the line-by-line columns drawn it scrolls instead of cutting them off',
      scrolled.scroll === true && scrolled.columns === 6, JSON.stringify(scrolled));
  } finally {
    await tab.send('Emulation.clearDeviceMetricsOverride');
  }
}

// The date cell has to still say the date after a line is ticked, whichever way it was ticked,
// and the editor must never be left sitting over a row. A date you cannot see looks like it
// vanished when the line was checked, which is how the window was reported.
async function reconcileDateEditing(tab) {
  const read = () => tab.eval(`(() => {
    const tr = document.querySelector('#rows tr[data-id]');
    const button = tr.querySelector('.date-btn');
    const input = tr.querySelector('.date-input');
    return {
      date: button ? button.textContent : (input ? input.value : ''),
      editor: Boolean(input),
      checked: tr.getAttribute('aria-checked'),
    };
  })()`);
  const onShow = (state) => !state.editor && /^\d{4}-\d{2}-\d{2}$/.test(state.date);

  await tab.show('reconcile', 'dark');
  await tab.eval("document.querySelector('#rows tr[data-id]').click()");
  let state = await read();
  check('a click on the row ticks it and the date is still on show',
    state.checked === 'true' && onShow(state), JSON.stringify(state));

  await tab.show('reconcile', 'dark');
  await tab.eval(`(() => {
    const cell = document.querySelector('#rows tr[data-id] td.date');
    const box = cell.getBoundingClientRect();
    document.elementFromPoint(box.left + box.width - 3, box.top + box.height - 3).click();
    return true;
  })()`);
  state = await read();
  check('a click on the date cell itself ticks it and the date is still on show',
    state.checked === 'true' && onShow(state), JSON.stringify(state));

  await tab.show('reconcile', 'dark');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40 });
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  state = await tab.eval(`(() => {
    const tr = document.activeElement;
    const button = tr.querySelector && tr.querySelector('.date-btn');
    return {
      tag: tr.tagName,
      checked: tr.getAttribute && tr.getAttribute('aria-checked'),
      date: button ? button.textContent : '',
      ring: getComputedStyle(tr).outlineWidth,
    };
  })()`);
  check('Space ticks the line, keeps its date, and keeps the focus ring on it',
    state.tag === 'TR' && state.checked === 'true' && /^\d{4}-\d{2}-\d{2}$/.test(state.date)
    && parseFloat(state.ring) >= 2, JSON.stringify(state));

  // A line whose running balance is unknown has no difference to show. Editing a transaction
  // into another commodity makes every balance after it unknown, and the box used to show the
  // typed balance as though the line were out by exactly that much. Only a read-only window
  // keeps an edit of its own; a writable one shows what hledger read back.
  await tab.show('reconcile', 'dark', '&writable=no');
  await tab.eval(`(() => {
    const box = document.getElementById('lines');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await tab.eval(`(() => {
    const area = document.querySelector('tr.editor textarea');
    area.value = '2026-09-01 x\\n    A    5 USD\\n    Assets:Bank:Checking';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('tr.editor [data-keep]').click();
    return true;
  })()`);
  const unknown = await tab.eval(`(() => {
    const inputs = [...document.querySelectorAll('#rows td.expect input')];
    const target = inputs[inputs.length - 1];
    target.value = '123456';
    target.dispatchEvent(new Event('input', { bubbles: true }));
    const cell = target.closest('tr').querySelector('td.delta');
    return JSON.stringify({ text: cell.textContent, cls: cell.className });
  })()`);
  check('a typed balance against an unknown running balance shows no difference',
    JSON.parse(unknown).text === '' && JSON.parse(unknown).cls === 'n delta ', unknown);

  // Focus follows the line, not the position it used to be at. The first line is moved to a
  // day after every other one, so it really does leave where it was sitting: an index would
  // hand the ring to whichever line took its place.
  await tab.show('reconcile', 'dark');
  const focusTarget = await tab.eval(`(() => {
    const row = document.querySelector('#rows tr[data-id]');
    row.focus();
    return row.getAttribute('data-id');
  })()`);
  await tab.key('d', { code: 'KeyD', keyCode: 68, text: 'd' });
  const editorOpened = await tab.eval(`(() => {
    const input = document.querySelector('.date-input');
    if (!input) return false;
    input.value = '2026-10-20';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await writesDone(tab);
  const afterMove = await tab.eval("document.activeElement.getAttribute('data-id')");
  const nowAt = await tab.eval(`[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => tr.getAttribute('data-id') === ${JSON.stringify(focusTarget)})`);
  check('after a line moves to another day and re-sorts, focus stays on that line',
    editorOpened === true && Boolean(focusTarget) && focusTarget === afterMove && nowAt > 0,
    JSON.stringify({ focusTarget, afterMove, nowAt, editorOpened }));

  // Tick all does not touch `touched`, so the question is whether a line can vanish after it:
  // a line in the cleared-at-open set that is on screen got there by being touched already, and
  // one that is not in that set is never hidden. Showing them, unticking one and ticking all
  // has to leave every line where it was.
  await tab.show('reconcile', 'dark');
  const countBefore = await tab.eval("document.querySelectorAll('#rows tr[data-id]').length");
  const revealed = await tab.eval(`(() => {
    const toggle = document.querySelector('[data-toggle-hidden]');
    if (toggle) toggle.click();
    return document.querySelectorAll('#rows tr[data-id]').length;
  })()`);
  await tab.eval("(() => { const row = document.querySelector('#rows tr.on'); if (row) row.click(); return true; })()");
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await writesDone(tab);
  const countAfter = await tab.eval("document.querySelectorAll('#rows tr[data-id]').length");
  check('ticking every line leaves every line in view, none disappearing',
    countAfter >= revealed && revealed >= countBefore,
    JSON.stringify({ countBefore, revealed, countAfter }));

  // Keys belong to a line only while a line has focus: a space in the search box is that box's
  // space, and a space in the date editor is the editor's.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.getElementById('search').focus()");
  const tickedBefore = await tab.eval("document.querySelectorAll('#rows tr.on').length");
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  const searchState = await tab.eval(`JSON.stringify({
    value: document.getElementById('search').value,
    on: document.querySelectorAll('#rows tr.on').length,
  })`);
  check('a space typed in the search box is a space, and ticks nothing',
    JSON.parse(searchState).value === ' ' && JSON.parse(searchState).on === tickedBefore, searchState);

  await tab.show('reconcile', 'dark');
  await tab.eval("document.querySelector('#rows tr[data-id] .date-btn').click()");
  const beforeSpace = await tab.eval("document.querySelectorAll('#rows tr.on').length");
  await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
  const editorState = await tab.eval(`JSON.stringify({
    editor: Boolean(document.querySelector('.date-input')),
    on: document.querySelectorAll('#rows tr.on').length,
  })`);
  check('a space in the date editor stays in the editor, and ticks nothing',
    JSON.parse(editorState).editor && JSON.parse(editorState).on === beforeSpace, editorState);

  // After a write there is no editor left standing: the row it was open on was re-read with the
  // rest of the list, and nothing keeps an input on a line that has already been written.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.querySelector('#rows tr[data-id] .date-btn').click()");
  const editing = await tab.eval("Boolean(document.querySelector('.date-input'))");
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  await tab.eval("document.querySelector('#rows tr[data-id]').click()");
  await writesDone(tab);
  const afterSave = await tab.eval(`JSON.stringify({
    editors: document.querySelectorAll('.date-input').length,
    rows: document.querySelectorAll('#rows tr[data-id]').length,
    on: document.querySelector('#rows tr[data-id]').getAttribute('aria-checked'),
    written: window.__changed.length,
  })`);
  check('a written tick leaves the list re-read with no editor standing',
    editing && JSON.parse(afterSave).editors === 0 && JSON.parse(afterSave).rows > 0 && JSON.parse(afterSave).on === 'true' && JSON.parse(afterSave).written === 1, afterSave);

  // Two thousand postings: what the redesign has to survive is the redraw, not the first paint,
  // so the tick-everything path is timed inside the page, where navigation is not counted.
  await tab.show('reconcile', 'dark', '&many=2000');
  const many = await tab.eval(`(() => {
    const rows = document.querySelectorAll('#rows tr[data-id]');
    const start = performance.now();
    document.getElementById('all').click();
    const took = performance.now() - start;
    return JSON.stringify({ rows: rows.length, took: Math.round(took), ticked: document.querySelectorAll('#rows tr.on').length });
  })()`);
  const manyState = JSON.parse(many);
  check('two thousand postings draw, and tick every one of them, within a moment',
    // The statement date is 2026-09-30 and the rows run to December, so ticking every line up
    // to that date has to stop short of all two thousand: both halves of the rule matter.
    manyState.rows === 2000 && manyState.took < 1500
      && manyState.ticked >= 1500 && manyState.ticked < 2000, many);

  // An editor left open over a ticked row is how a date looked like it had disappeared, so a
  // click away from it closes it and does nothing else: one click, one thing.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.querySelector('#rows tr[data-id] .date-btn').click()");
  const opened = await read();
  await tab.eval("document.querySelector('#rows tr[data-id]').children[1].click()");
  const afterClick = await read();
  check('clicking the row while the date editor is open closes it and ticks nothing',
    opened.editor && !afterClick.editor && afterClick.checked === 'false' && onShow(afterClick),
    JSON.stringify({ opened, afterClick }));

  await tab.show('reconcile', 'dark');
  await tab.eval("document.querySelector('#rows tr[data-id] .date-btn').click()");
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  const escaped = await read();
  check('Escape closes the date editor and leaves the date on show',
    !escaped.editor && escaped.checked === 'false' && onShow(escaped), JSON.stringify(escaped));
}

// Changing a transaction's date is an explicit act: the date is a button that opens an editor in
// place, Alt+Up/Down steps it onto a neighbouring day, and both go through the same checks. There
// is no drag and drop, so a row is clicked to tick it and nothing on it can move it.
async function reconcileDates(tab) {
  await tab.show('reconcile', 'dark');
  // Editing a date where it is, and the floor: a date before the asserted balance is refused,
  // because that assertion says what the balance was that day, and a posting earlier is one it
  // did not count.
  const refused = await tab.eval(`(() => {
    document.querySelector('#rows tr[data-id] button[data-date]').click();
    const input = document.querySelector('#rows tr[data-id] .date-input');
    if (!input) return { opened: false };
    const was = input.value;
    input.value = '2026-08-01';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return {
      opened: true, was,
      status: document.getElementById('status').textContent,
      closed: document.querySelector('.date-input') === null,
      dates: [...document.querySelectorAll('#rows button[data-date]')].map((b) => b.textContent),
    };
  })()`);
  check('the date is edited in place, and one before the asserted balance is refused with its reason',
    refused.opened && refused.closed && refused.was === '2026-09-01'
    && /^Cannot move it to 2026-08-01: it is before 2026-08-31, where this account is already asserted\.$/.test(refused.status)
    && refused.dates[0] === '2026-09-01', JSON.stringify(refused));

  // A date the statement allows is accepted, written at once, and said.
  const writing = await tab.eval(`(() => {
    document.querySelector('#rows tr[data-id] button[data-date]').click();
    const input = document.querySelector('#rows tr[data-id] .date-input');
    input.value = '2026-09-03';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const row = document.querySelector('#rows tr[data-id]');
    return { writing: row.classList.contains('writing'), busy: row.getAttribute('aria-busy') };
  })()`);
  await writesDone(tab);
  const moved = await tab.eval(`(() => ({
    status: document.getElementById('status').textContent,
    dates: [...document.querySelectorAll('#rows button[data-date]')].map((b) => b.textContent),
    sent: window.__changed[window.__changed.length - 1],
  }))()`);
  check('a date the statement allows is written at once, the row marked while it is, and said',
    writing.writing && writing.busy === 'true' && /^Moved Coffee to 2026-09-03\./.test(moved.status)
    && moved.dates.filter((date) => date === '2026-09-03').length === 2, JSON.stringify({ writing, moved }));
  check('and it is sent as a date change, with the row as the window saw it',
    moved.sent.kind === 'date' && moved.sent.id === '2:Assets:Bank:Checking:0' && moved.sent.date === '2026-09-03'
    && /^2026-09-01 Coffee\n/.test(moved.sent.targets['2:Assets:Bank:Checking:0'].text), JSON.stringify(moved.sent));
  await tab.eval("document.getElementById('undo').click()");
  await writesDone(tab);
  const undone = await tab.eval("({ status: document.getElementById('status').textContent, first: document.querySelector('#rows button[data-date]').textContent, undo: !!document.getElementById('undo') })");
  check('and Undo puts the date back, with nothing left to undo',
    /^Undid: Moved Coffee to 2026-09-03\.$/.test(undone.status) && undone.first === '2026-09-01' && !undone.undo, JSON.stringify(undone));

  // The date and the insert control are reached from the keyboard, not only by a pointer: Tab
  // from the focused line lands on them in turn, each drawn with a focus ring, and the plus is
  // revealed when it has focus rather than staying invisible until something hovers over it.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40 });
  await tab.key('Tab', { code: 'Tab', keyCode: 9 });
  const firstStop = await tab.eval("(() => { const el = document.activeElement; return { cls: el.className, ring: getComputedStyle(el).outlineWidth }; })()");
  await tab.key('Tab', { code: 'Tab', keyCode: 9 });
  const secondStop = await tab.eval("(() => { const el = document.activeElement; return { cls: el.className, ring: getComputedStyle(el).outlineWidth, opacity: getComputedStyle(el).opacity }; })()");
  check('Tab from a line reaches the date and then the plus, each with a focus ring',
    firstStop.cls === 'date-btn' && parseFloat(firstStop.ring) >= 2
    && secondStop.cls === 'insert' && parseFloat(secondStop.ring) >= 2 && secondStop.opacity === '1',
    JSON.stringify({ firstStop, secondStop }));

  // A date past the statement date is allowed: the statement date is a filter, not a wall, and
  // Finish waits for the date to move rather than refusing the line.
  await tab.show('reconcile', 'dark');
  await tab.eval(`(() => {
    const row = [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Pending transfer/.test(tr.textContent));
    row.querySelector('button[data-date]').click();
    const input = document.querySelector('.date-input');
    input.value = '2026-10-02';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await writesDone(tab);
  const later = await tab.eval(`({
    said: document.getElementById('status').textContent,
    dates: [...document.querySelectorAll('#rows button[data-date]')].map((b) => b.textContent),
  })`);
  check('a date past the statement date is allowed, since Finish simply waits',
    /^Moved Pending transfer to 2026-10-02\./.test(later.said)
    && later.dates.filter((date) => date === '2026-10-02').length === 2, JSON.stringify(later));

  // Alt+Up/Down steps the transaction onto the next day that has postings: the quick way to put
  // it where the statement shows it, without typing a date.
  await tab.show('reconcile', 'dark');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))");
  await writesDone(tab);
  const keys = await tab.eval(`({
    dates: [...document.querySelectorAll('#rows button[data-date]')].map((b) => b.textContent),
    status: document.getElementById('status').textContent,
  })`);
  check('Alt+Down moves the focused transaction to the next day with postings, and says where',
    keys.dates[0] === '2026-09-02' && /^Moved Coffee to 2026-09-02/.test(keys.status), JSON.stringify(keys));

  // Two transactions on one day now: each has the arrow towards the other, and only that one,
  // and moving one moves its transaction in the file, which is the day's order.
  const order = () => tab.eval(`(() => [...document.querySelectorAll('#rows tr[data-id]')].slice(0, 2).map((tr) => ({
    name: tr.children[1].textContent.trim().split(/\\s/)[0],
    up: Boolean(tr.querySelector('button[data-up]')),
    down: Boolean(tr.querySelector('button[data-down]')),
  })))()`);
  const before = await order();
  check('two transactions on a day each get the arrow towards the other, and a lone day gets none',
    JSON.stringify(before) === JSON.stringify([{ name: 'Coffee', up: false, down: true }, { name: 'Salary', up: true, down: false }])
    && (await tab.eval("document.querySelectorAll('#rows button.order').length")) === 2, JSON.stringify(before));
  await tab.eval("document.querySelector('#rows button[data-up]').click()");
  await writesDone(tab);
  const raised = await tab.eval(`({
    names: [...document.querySelectorAll('#rows tr[data-id]')].slice(0, 2).map((tr) => tr.children[1].textContent.trim().split(/\\s/)[0]),
    focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null,
    status: document.getElementById('status').textContent,
    sent: window.__changed[window.__changed.length - 1],
  })`);
  check('the up arrow moves it above its neighbour, sent as a reorder, and the moved row keeps the focus',
    raised.names.join() === 'Salary,Coffee' && raised.focus === '3:Assets:Bank:Checking:0'
    && raised.sent.kind === 'reorder' && raised.sent.direction === 'up' && raised.sent.id === '3:Assets:Bank:Checking:0'
    && /^Moved Salary up within 2026-09-02\./.test(raised.status), JSON.stringify(raised));
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40, modifiers: 8 });
  await writesDone(tab);
  const lowered = await tab.eval(`({
    names: [...document.querySelectorAll('#rows tr[data-id]')].slice(0, 2).map((tr) => tr.children[1].textContent.trim().split(/\\s/)[0]),
    focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null,
    sent: window.__changed[window.__changed.length - 1],
  })`);
  check('Shift+Down moves it back down, and it keeps the focus',
    lowered.names.join() === 'Coffee,Salary' && lowered.focus === '3:Assets:Bank:Checking:0' && lowered.sent.direction === 'down', JSON.stringify(lowered));
  const sentBefore = await tab.eval('window.__changed.length');
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40, modifiers: 8 });
  check('and Shift+Down on the last of its day says it stays, and writes nothing',
    /^Salary stays where it is: it is already the last of 2026-09-02\.$/.test(await tab.eval("document.getElementById('status').textContent"))
    && (await tab.eval('window.__changed.length')) === sentBefore, await tab.eval("document.getElementById('status').textContent"));

  // A transaction can be added in the middle of the list: the plus beside a date opens the
  // editor for that spot, prefilled with that day and this account, so it lands where it looks,
  // beside the whole file with the place it will go marked.
  await tab.show('reconcile', 'dark');
  const added = await tab.eval(`(() => {
    document.querySelectorAll('#rows tr[data-id] button[data-insert]')[0].click();
    const area = document.querySelector('tr.editor textarea');
    const view = document.querySelector('tr.editor .file-view');
    return {
      opened: Boolean(area), text: area ? area.value : '',
      where: view ? view.querySelector('.where').textContent : '',
      here: view && view.querySelector('.here') ? view.querySelector('.here').textContent : '',
    };
  })()`);
  check('the plus beside a date opens a new transaction for that spot, on that day',
    added.opened && /^2026-09-01/.test(added.text) && /Assets:Bank:Checking/.test(added.text),
    JSON.stringify(added));
  check('beside the file, with where it will go marked',
    added.where === 'fixture.journal: it goes after line 9, after 2026-09-01 Coffee' && /^10\s*$/.test(added.here), JSON.stringify(added));
  const moving = await tab.eval(`(() => {
    const area = document.querySelector('tr.editor textarea');
    area.value = '2026-09-04 Bank fee\\n    Assets:Bank:Checking    -75000 IDR\\n    Expenses:Fees';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const view = document.querySelector('tr.editor .file-view');
    return { where: view.querySelector('.where').textContent, here: view.querySelector('.here') ? view.querySelector('.here').textContent : '' };
  })()`);
  check('and the mark follows the date as it is typed',
    moving.where === 'fixture.journal: it goes after line 17, after 2026-09-03 Pending transfer' && /^18\s*$/.test(moving.here), JSON.stringify(moving));
  await tab.eval("document.querySelector('tr.editor [data-close]').click()");
  const viewed = await tab.eval(`(() => {
    document.querySelector('#rows button[data-edit]').click();
    const view = document.querySelector('tr.editor .file-view');
    const scroll = view.querySelector('.scroll');
    const lit = [...view.querySelectorAll('.hl')].map((line) => line.textContent);
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll'));
    const last = [...view.querySelectorAll('.lines > div')].map((line) => line.textContent).filter((line) => /Assets:Cash/.test(line)).pop();
    return { where: view.querySelector('.where').textContent, lit, last: last || '', sourced: window.__sourced };
  })()`);
  check('editing a transaction shows it lit in its whole file, and the file scrolls',
    viewed.where === 'fixture.journal, lines 7 to 9' && viewed.lit.length === 3 && /^7\s*2026-09-01 Coffee$/.test(viewed.lit[0])
    && /Assets:Cash/.test(viewed.last) && viewed.sourced === 'fixture.journal', JSON.stringify(viewed));

  // The keyboard gets there from the line with focus, which is not the same line.
  await tab.show('reconcile', 'dark');
  const byKeyboard = await tab.eval(`(() => {
    document.activeElement && document.activeElement.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
    const area = document.querySelector('tr.editor textarea');
    return { opened: Boolean(area), text: area ? area.value : '' };
  })()`);
  check('i adds a new transaction after the line with focus, prefilled the same way',
    byKeyboard.opened && /^2026-09-02/.test(byKeyboard.text), JSON.stringify(byKeyboard));

  // Read-only: the editor refuses before it opens, with the message the write actions use, and
  // no line can be picked up at all.
  await tab.show('reconcile', 'dark', '&writable=no');
  const locked = await tab.eval(`(() => {
    const row = document.querySelector('#rows tr[data-id]');
    const was = row.querySelector('button[data-date]').textContent;
    row.querySelector('button[data-date]').click();
    return {
      openedEditor: document.querySelector('.date-input') !== null,
      status: document.getElementById('status').textContent,
      draggable: row.getAttribute('draggable'),
      date: row.querySelector('button[data-date]').textContent,
      was,
    };
  })()`);
  check('a read-only journal refuses the date change with the message the write actions use',
    locked.openedEditor === false && /read-only/.test(locked.status) && /run open/.test(locked.status)
    && locked.draggable === null && locked.date === locked.was, JSON.stringify(locked));
  await tab.eval("document.querySelector('#rows tr[data-id]').focus()");
  await tab.key('ArrowDown', { code: 'ArrowDown', keyCode: 40, modifiers: 8 });
  check('and the order within a day too',
    /^The journal is read-only, so the order cannot be changed: run open in the terminal to edit it\.$/.test(await tab.eval("document.getElementById('status').textContent"))
    && (await tab.eval('window.__changed.length')) === 0, await tab.eval("document.getElementById('status').textContent"));
}

// Where the cleared marks are written is the person's choice, and the window has to show it,
// carry it in every request, and remember it.
async function reconcileStyle(tab) {
  await tab.show('reconcile', 'dark', '&balance=5670000');
  const initial = await tab.eval("({ value: document.getElementById('style').value, options: [...document.querySelectorAll('#style option')].map((o) => o.value) })");
  check('the marking style is a visible choice, with both styles offered',
    initial.value === 'posting' && initial.options.join() === 'posting,transaction', JSON.stringify(initial));
  // A transaction with two postings to this account ticks as one in transaction mode.
  await tab.eval(`(() => {
    const select = document.getElementById('style');
    select.value = 'transaction';
    select.dispatchEvent(new Event('change'));
    [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Split/.test(tr.textContent)).click();
  })()`);
  await writesDone(tab);
  const together = await tab.eval(`(() => ({
    splitRows: [...document.querySelectorAll('#rows tr[data-id]')].filter((tr) => /Split/.test(tr.textContent)).length,
    splitTicked: [...document.querySelectorAll('#rows tr[data-id]')].filter((tr) => /Split/.test(tr.textContent) && tr.classList.contains('on')).length,
    remembered: window.__styleSet,
    sent: window.__changed[window.__changed.length - 1],
  }))()`);
  check('in transaction mode one click ticks every row of that transaction, and the choice is remembered',
    together.splitRows === 2 && together.splitTicked === 2 && together.remembered === 'transaction',
    JSON.stringify(together));
  check('and the tick is sent in that style',
    together.sent.kind === 'tick' && together.sent.style === 'transaction' && together.sent.changes.length === 1, JSON.stringify(together.sent));
  // The preview says which kind of change it would make.
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await writesDone(tab);
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  const previewText = await tab.eval("document.getElementById('preview').innerText");
  check('and the preview says it marks transactions, and asks in that style',
    /Marks transactions/.test(previewText) && /transaction's own line/.test(previewText) && (await tab.eval('window.__lastPreview.style')) === 'transaction', previewText.slice(0, 120));
  await tab.eval("document.getElementById('cancel').click()");
  await tab.eval(`(() => {
    window.__conflicts = [{ id: '5:Assets:Bank:Checking:0', date: '2026-09-05', description: 'Split', why: 'one posting is cleared and the other is not' }];
    const select = document.getElementById('style');
    select.value = 'posting';
    select.dispatchEvent(new Event('change'));
    document.getElementById('finish').click();
  })()`);
  await tab.until("!document.getElementById('preview').hidden");
  const postingPreview = await tab.eval("document.getElementById('preview').innerText");
  check('and in posting mode it says it marks postings, and that is what it would write',
    (await tab.eval("document.getElementById('style').value")) === 'posting' && /Marks postings/.test(postingPreview) && /each posting's own line/.test(postingPreview)
    && (await tab.eval('window.__lastPreview.style')) === 'posting', postingPreview.slice(0, 120));
  check('and the transactions whose marks disagree are listed before anything is asserted over them',
    /1 transaction with marks that disagree/.test(postingPreview) && /2026-09-05 Split: one posting is cleared and the other is not/.test(postingPreview), postingPreview);
  await tab.eval("document.querySelector('.conflicts p[data-id]') && document.getElementById('cancel').click()");
}

// A journal kept by marking transactions, with its balance last asserted a while back: the
// window has to show that finished work as done, say where the list starts, and open at what is
// left. It gets a window of its own because it opens in a different state from the rest.
async function reconcileAlreadyCleared(tab) {
  await tab.show('reconcile', 'dark', '&marked=yes&balance=5670000');
  const opened = await tab.eval(`(() => ({
    on: document.querySelectorAll('#rows tr.on').length,
    total: document.querySelectorAll('#rows tr[data-id]').length,
    hidden: document.getElementById('hidden').innerText,
    sub: document.getElementById('sub').innerText,
    notes: document.getElementById('notes').innerText,
    focus: document.activeElement.dataset ? document.activeElement.dataset.id : null,
    firstLeft: [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => !tr.classList.contains('on')).dataset.id,
  }))()`);
  // They are cleared, so the window hides them and says so, rather than listing work already done.
  check('a marked transaction\'s postings are hidden as already cleared, and counted',
    opened.on === 0 && opened.total === 4 && /^2 cleared postings hidden, 2026-09-01 to 2026-09-02/.test(opened.hidden), JSON.stringify(opened));
  check('and where the list starts is in the header, and what is done is in the hidden line, one line each',
    /since the balance asserted on 2026-08-31/.test(opened.sub) && /^2 cleared postings hidden, 2026-09-01 to 2026-09-02/.test(opened.hidden)
    && !/starts at/.test(opened.notes), JSON.stringify({ sub: opened.sub, hidden: opened.hidden }));
  check('and it opens on the first posting still to do, not on the finished ones',
    opened.focus === opened.firstLeft, `${opened.focus} vs ${opened.firstLeft}`);
  // The owner's situation: every line up to the statement date is already cleared, so there is
  // nothing to tick, and telling him to tick lines would send him looking for work that is not
  // there. The next step says so, and says what is left: the closing balance.
  const nothingLeft = await tab.eval(`(() => {
    const date = document.getElementById('date');
    date.value = '2026-09-02';
    date.dispatchEvent(new Event('input'));
    const balance = document.getElementById('balance');
    balance.value = '';
    balance.dispatchEvent(new Event('input'));
    return document.getElementById('next').innerText;
  })()`);
  check('when every line up to the statement date is cleared, the next step says so and asks only for the balance',
    /^Everything up to 2026-09-02 is cleared\. Type the statement's closing balance/.test(nothingLeft) && !/tick the lines/i.test(nothingLeft), nothingLeft);
  // The control that brings them back has to work, and show them as they are: cleared and ticked.
  const revealed = await tab.eval(`(() => {
    document.querySelector('[data-toggle-hidden]').click();
    return {
      total: document.querySelectorAll('#rows tr[data-id]').length,
      on: document.querySelectorAll('#rows tr.on').length,
      line: document.getElementById('hidden').innerText,
    };
  })()`);
  check('and the control that shows them brings them back, still ticked',
    revealed.total === 6 && revealed.on === 2 && /hide them/.test(revealed.line), JSON.stringify(revealed));
  // Editing works in the filtered view too, where the rows on screen are not the rows in the
  // file: the visible rows carry their own dates, and the hidden ones stay hidden.
  await tab.show('reconcile', 'dark', '&marked=yes&balance=5670000');
  const filteredBefore = await tab.eval(`(() => {
    const button = document.querySelector('#rows tr[data-id] button[data-date]');
    const before = button.textContent;
    button.click();
    const input = document.querySelector('.date-input');
    input.value = '2026-09-05';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return before;
  })()`);
  await writesDone(tab);
  const filtered = await tab.eval(`({
    before: ${JSON.stringify(filteredBefore)},
    said: document.getElementById('status').textContent,
    dates: [...document.querySelectorAll('#rows button[data-date]')].map((b) => b.textContent),
    hidden: document.getElementById('hidden').innerText,
  })`);
  check('a date is edited in the filtered view, on the rows that are actually shown',
    filtered.before === '2026-09-03' && /^Moved Pending transfer to 2026-09-05\./.test(filtered.said)
    && filtered.dates.filter((date) => date === '2026-09-05').length === 3 && /hidden/.test(filtered.hidden),
    JSON.stringify(filtered));
  // The rule that makes an assertion trustworthy still holds: at a difference of zero, Finish
  // waits for the postings before the statement date that are not ticked. Ticking the marked
  // ones by default must not become a way of finishing on a partial month.
  const zero = await tab.eval(`(() => {
    const balance = document.getElementById('balance');
    balance.value = '5,979,000';
    balance.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      difference: document.querySelector('#difference b').textContent.trim(),
      disabled: document.getElementById('finish').disabled,
      notes: document.getElementById('notes').innerText,
    };
  })()`);
  check('at a zero difference Finish still waits for the postings left unticked',
    zero.difference === '0.00 IDR' && zero.disabled && /^3 lines up to the statement date are not ticked/.test(zero.notes),
    JSON.stringify(zero));
}

async function reconcileRunning(tab) {
  const text = (id) => tab.eval(`document.getElementById('${id}').innerText`);
  const cell = (row, column) => tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${row}].children[${column}].textContent.trim()`);
  const expect = (row, value) => tab.eval(`(() => { const input = document.querySelectorAll('#rows tr[data-id] input[data-expect]')[${row}]; input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const area = () => tab.eval("document.querySelector('tr.editor textarea').value");
  const typeIn = (value) => tab.eval(`(() => { const t = document.querySelector('tr.editor textarea'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const rows = () => tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].map((tr) => tr.children[1].textContent.trim().split('\\n')[0] + '=' + tr.children[3].textContent.trim()).join(' | ')");
  const rowOf = (pattern) => tab.eval(`[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => ${pattern}.test(tr.textContent))`);
  const last = () => tab.eval('window.__changed[window.__changed.length - 1]');
  const done = () => writesDone(tab);
  await tab.show('reconcile', 'dark', '&lines=on');
  check('each posting shows the balance after it', [await cell(0, 3), await cell(1, 3), await cell(2, 3)].join(' | ') === '979,000.00 | 5,979,000.00 | 5,679,000.00',
    [await cell(0, 3), await cell(1, 3), await cell(2, 3)].join(' | '));
  await expect(0, '979,000');
  await expect(1, '5,979,000');
  await expect(3, '5,679,000');
  check('a typed statement balance shows its difference at that line', (await cell(0, 5)) === '✓' && (await cell(1, 5)) === '✓' && (await cell(3, 5)) === '4,000.00 IDR',
    [await cell(0, 5), await cell(1, 5), await cell(3, 5)].join(' | '));
  check('the first line where they part is marked', await tab.eval("document.querySelectorAll('#rows tr.first').length === 1 && document.querySelectorAll('#rows tr[data-id]')[3].classList.contains('first')"));
  check('and the hint says where, and that it may be the posting before',
    /part at 2026-09-05 Split, by 4,000\.00 IDR: 2026-09-05 Split \(-4,000\.00 IDR\) is exactly that/.test(await text('hints')), await text('hints'));
  // Off, line by line writes nothing: its columns go and the figures typed stay. On again, they
  // are all still there. That nothing typed is sent while it is off is checked at Finish, below.
  const gated = await tab.eval(`(() => {
    const box = document.getElementById('lines');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    const off = {
      columns: getComputedStyle(document.querySelector('thead th.line')).display,
      said: document.getElementById('status').textContent,
      remembered: window.__linesSet,
    };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    return { off, on: window.__linesSet, kept: [...document.querySelectorAll('#rows input[data-expect]')].filter((input) => input.value).length };
  })()`);
  check('with line by line off, its columns go, the figures are kept, and the choice is remembered',
    gated.off.columns === 'none' && /kept, and not written/.test(gated.off.said) && gated.kept === 3
    && gated.off.remembered === false && gated.on === true, JSON.stringify(gated));
  await expect(3, '5,675,000');
  check('typing it right clears the mismatch', (await cell(3, 5)) === '✓' && (await tab.eval("document.querySelectorAll('#rows tr.first').length")) === 0, await cell(3, 5));
  await expect(3, '5,600,000');
  const add = await tab.eval("!!document.querySelector('#hints button[data-add]')");
  check('a difference no posting explains offers to add one for it', add, await text('hints'));
  await tab.eval("document.querySelector('#hints button[data-add]').click()");
  check('which opens the text of a new transaction, with that amount and date, the cursor where its description goes',
    (await area()) === '2026-09-05 \n    Assets:Bank:Checking    -75000.00 IDR\n    ' && (await tab.eval("document.activeElement.tagName === 'TEXTAREA' && document.activeElement.selectionStart === 11")), JSON.stringify(await area()));
  check('beside the file, marked where it will go: after the transaction where they part',
    (await tab.eval("document.querySelector('tr.editor .file-view .where').textContent")) === 'fixture.journal: it goes after line 23, after 2026-09-05 Split',
    await tab.eval("document.querySelector('tr.editor .file-view .where').textContent"));
  check('and says what it lacks as it is typed', /needs another posting/.test(await text('reading')), await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('so keeping it as it is is refused', /needs another posting/.test(await text('status')), await text('status'));
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees    70000 IDR');
  check('an amount that does not balance is said', /does not balance: its amounts add up to -5,000\.00 IDR/.test(await text('reading')), await text('reading'));
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees');
  check('and a whole one is read back as it would be written', (await text('reading')) === '2026-09-05: -75,000.00 IDR to Assets:Bank:Checking, against Expenses:Fees.', await text('reading'));
  const keeping = await tab.eval(`(() => {
    document.querySelector('tr.editor textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    const button = document.querySelector('tr.editor [data-keep]');
    return { label: button.textContent, disabled: button.disabled };
  })()`);
  check('Ctrl+Enter writes it: its button says so and cannot be pressed twice', keeping.label === 'Writing…' && keeping.disabled, JSON.stringify(keeping));
  await done();
  const inserted = await last();
  check('it is sent as an insert, after the posting where they parted, with that row as the window saw it',
    inserted.kind === 'insert' && inserted.text === '2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees'
    && inserted.after === '5:Assets:Bank:Checking:0' && /^2026-09-05 Split\n/.test(inserted.targets['5:Assets:Bank:Checking:0'].text), JSON.stringify(inserted));
  check('and it comes back as hledger reads the file: after its transaction, ticked, the balances following, and the editor closed',
    /[^|]*Split[^|]*=5,675,000\.00 \| [^|]*Split[^|]*=5,670,000\.00 \| [^|]*Bank fee[^|]*=5,595,000\.00 \| [^|]*After the statement[^|]*=5,592,500\.00/.test(await rows())
    && (await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Bank fee/.test(tr.textContent)).classList.contains('on')"))
    && (await tab.eval("document.querySelectorAll('tr.editor').length")) === 0, await rows());
  const feeRow = await rowOf('/Bank fee/');
  const moved = await tab.eval(`(() => {
    const inputs = [...document.querySelectorAll('#rows tr[data-id] input[data-expect]')];
    return { fee: inputs[${feeRow}].value, split: inputs[3].value, focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id || null : null };
  })()`);
  check('and the statement balance typed where they parted moves to the new line',
    moved.fee === '5,600,000.00' && moved.split === '', JSON.stringify(moved));
  // Edit a transaction as text: e on the first row, reached from the new one.
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('j', { code: 'KeyJ', keyCode: 74, text: 'j' });
  for (let step = 0; step < 7; step += 1) await tab.key('k', { code: 'KeyK', keyCode: 75, text: 'k' });
  await tab.key('e', { code: 'KeyE', keyCode: 69, text: 'e' });
  check('e opens the transaction as it is written in the journal', (await area()) === '2026-09-01 Coffee\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking', JSON.stringify(await area()));
  await typeIn('2026-09-01 * Coffee beans  ; for the office\n    Expenses:Food:Coffee    25000 IDR\n    Assets:Bank:Checking');
  check('the reading follows the text, the amount worked out as hledger would', (await text('reading')) === '2026-09-01: -25,000.00 IDR to Assets:Bank:Checking, against Expenses:Food:Coffee.', await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await done();
  const edited = await last();
  check('an edit is sent as one, with the text and the row as the window saw it',
    edited.kind === 'edit' && edited.id === '2:Assets:Bank:Checking:0' && /Coffee beans/.test(edited.text)
    && edited.targets['2:Assets:Bank:Checking:0'].text === '2026-09-01 Coffee\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking', JSON.stringify(edited));
  check('and the window shows it as read back: the amount and every balance after it',
    (await cell(0, 2)) === '-25,000.00' && (await cell(0, 3)) === '975,000.00' && /^Coffee beans/.test(await cell(0, 1)) && !/edited/.test(await cell(0, 1))
    && /^Rewrote 2026-09-01 Coffee beans\./.test(await text('status')),
    `${await cell(0, 2)} ${await cell(0, 3)} ${await cell(0, 1)} ${await text('status')}`);
  // The per-row control is a word, and it lives beside the description instead of in a column of
  // its own: a column for one small control cost width on every row, and on a narrow window that
  // is the width the difference needs. What matters is the name, so the name is asserted.
  const editControl = await tab.eval(`(() => {
    const button = document.querySelector('#rows button[data-edit]');
    button.focus();
    const cell = document.querySelector('#rows tr[data-id]').children[1];
    return {
      text: button.textContent.trim(),
      label: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      ascii: /^[ -~]+$/.test(button.textContent.trim()),
      focusable: document.activeElement === button,
      inDescription: button.closest('td') === cell && cell.textContent.trim().length > 0,
      columns: document.querySelectorAll('thead th').length,
      editColumn: document.querySelector('thead th[aria-label="edit"]') !== null,
      width: Math.round(button.getBoundingClientRect().width),
    };
  })()`);
  check('the edit control is a word beside the description, with a name and a focus',
    editControl.text === 'edit' && editControl.label === 'edit' && editControl.title === 'edit (e)'
    && editControl.ascii && editControl.focusable && editControl.inDescription
    && editControl.width <= 40, JSON.stringify(editControl));
  check('and there is no column of its own for it any more',
    editControl.editColumn === false && editControl.columns === 6, `${editControl.columns} columns, edit column ${editControl.editColumn}`);
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  check('a written edit reopens with what the file now says', /Coffee beans/.test(await area()) && !(await tab.eval("document.querySelector('tr.editor [data-undo]')")), JSON.stringify(await area()));
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('z', { code: 'KeyZ', keyCode: 90, text: 'z', modifiers: 2 });
  await done();
  check('and Ctrl+Z takes it back out of the file', (await cell(0, 2)) === '-21,000.00' && /^Undid: Rewrote/.test(await text('status')), `${await cell(0, 2)} ${await text('status')}`);
  // A transaction with two postings to the account is edited whole.
  const split = await rowOf('/Split/');
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${split}].querySelector('button[data-edit]').click()`);
  check('a transaction of several postings is edited whole, comments and all', (await area()).includes('    ; a comment line\n    Assets:Bank:Checking    -4000 IDR\n    Assets:Bank:Checking'), JSON.stringify(await area()));
  await tab.key('Escape', { keyCode: 27 });
  check('Escape closes an editor', (await tab.eval("document.querySelectorAll('tr.editor').length")) === 0, '');
  // Emptied, a transaction is deleted from the file, and Undo puts it back.
  const pendingRow = await rowOf('/Pending transfer/');
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${pendingRow}].querySelector('button[data-edit]').click()`);
  await typeIn('');
  check('emptying the text says it will delete the transaction', /Empty: the transaction will be deleted/.test(await text('reading')), await text('reading'));
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await done();
  check('kept, it is sent as an empty edit and the transaction leaves the list',
    !/Pending transfer/.test(await rows()) && (await last()).kind === 'edit' && (await last()).text === '' && /^Deleted 2026-09-03 Pending transfer\./.test(await text('status')), `${await rows()} ${await text('status')}`);
  await tab.eval("document.getElementById('undo').click()");
  await done();
  check('and Undo brings it back', /Pending transfer/.test(await rows()), await rows());
  // n adds a posting; what it lacks is refused before anything is sent.
  const sentBefore = await tab.eval('window.__changed.length');
  await tab.eval("document.activeElement && document.activeElement.blur()");
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
  await typeIn('2026-08-01 Too early\n    Assets:Bank:Checking    -1 IDR\n    Expenses:Fees');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('and one dated before the asserted balance', /^Not added: 2026-08-01 is before 2026-08-31/.test(await text('status')), await text('status'));
  await tab.eval("document.querySelector('tr.editor [data-close]').click()");
  check('and none of them was sent to be written', (await tab.eval('window.__changed.length')) === sentBefore && (await tab.eval("document.querySelectorAll('tr.editor').length")) === 0, '');
  const fee = await rowOf('/Bank fee/');
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${fee}].querySelector('button[data-edit]').click()`);
  check('a written new one reopens with its text, as any other', /Bank fee/.test(await area()) && !(await tab.eval("document.querySelector('tr.editor [data-drop]')")), '');
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  // A refused edit leaves the editor open with what was typed, and says why under it.
  await tab.eval("window.__refuse = 'hledger refused it, so fixture.journal was put back as it was.'");
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await typeIn('2026-09-01 Coffee\n    Expenses:Food    21000 IDR  ; refused\n    Assets:Bank:Checking');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await done();
  const refusedEdit = await tab.eval("({ open: !!document.querySelector('tr.editor'), text: (document.querySelector('tr.editor textarea') || {}).value, reading: document.getElementById('reading').textContent, label: document.querySelector('tr.editor [data-keep]').textContent })");
  check('a refused edit keeps its editor open with the text, says why, and can be written again',
    refusedEdit.open && /; refused/.test(refusedEdit.text) && /put back as it was/.test(refusedEdit.reading) && refusedEdit.label === 'Write it', JSON.stringify(refusedEdit));
  await tab.eval("window.__refuse = ''");
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  // A hint is followed to its posting.
  await expect(1, '5,979,000');
  await expect(2, '5,979,000');
  const pointing = await tab.eval("!!document.querySelector('#hints p[data-id]')");
  if (pointing) await tab.eval("document.querySelector('#hints p[data-id]').click()");
  check('a hint that names a posting moves to it', !pointing || (await tab.eval("document.activeElement && document.activeElement.dataset.id")) !== undefined, await text('hints'));
  await expect(2, '');
  // Finish sends the typed running balances, line by line, keyed by the rows they were typed
  // against and with those rows as the window saw them; with line by line off, none.
  await tab.eval("(() => { const b = document.getElementById('balance'); b.value = '5,595,000'; b.dispatchEvent(new Event('input')); })()");
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await done();
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  const asked = await tab.eval('window.__lastPreview');
  const feeId = await tab.eval(`[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Bank fee/.test(tr.textContent)).dataset.id`);
  check('Finish asks with the typed running balances, each with its row as the window saw it',
    asked.kind === 'finish' && Object.keys(asked.expected).length === 3 && asked.expected[feeId] === 560000000
    && asked.expected['2:Assets:Bank:Checking:0'] === 97900000 && asked.targets[feeId] && /Bank fee/.test(asked.targets[feeId].text), JSON.stringify(asked));
  await tab.eval("document.getElementById('apply').click()");
  await tab.until("/reconciled/.test(document.getElementById('status').textContent)");
  const finished = await last();
  check('and writes them with the finish', finished.kind === 'finish' && finished.expected[feeId] === 560000000 && Object.keys(finished.expected).length === 3, JSON.stringify(finished));
  await tab.eval(`(() => {
    const box = document.getElementById('lines');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    document.getElementById('finish').click();
  })()`);
  await tab.until("!document.getElementById('preview').hidden");
  check('with line by line off, Finish sends none of the figures typed',
    Object.keys(await tab.eval('window.__lastPreview.expected')).length === 0 && Object.keys(await tab.eval('window.__lastPreview.targets')).length === 3, JSON.stringify(await tab.eval('window.__lastPreview')));
  await tab.eval("document.getElementById('cancel').click()");

  // Read-only, the window keeps its own changes: edits, deletions and new lines are drawn in it
  // and sent only to be shown as the assertion to copy.
  await tab.show('reconcile', 'dark', '&lines=on&writable=no');
  await expect(3, '5,600,000');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('n', { code: 'KeyN', keyCode: 78, text: 'n' });
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees');
  check('read-only, the editor says its changes stay in the window',
    /keeps it in this window\. The file cannot be written from here/.test(await tab.eval("document.querySelector('tr.editor .buttons').textContent"))
    && (await tab.eval("document.querySelector('tr.editor [data-keep]').textContent")) === 'Keep', await tab.eval("document.querySelector('tr.editor .buttons').textContent"));
  await tab.eval("document.querySelector('tr.editor textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
  check('Ctrl+Enter keeps it in the window: ticked, marked new, placed after the day\'s last, the balances following, and nothing sent',
    // A line's state now sits at the front of its description, so an entry may begin with it:
    // what is being asserted here is the order and the balances, not where the text starts.
    /[^|]*Split[^|]*=5,675,000\.00 \| [^|]*Split[^|]*=5,670,000\.00 \| [^|]*Bank feenew[^|]*=5,595,000\.00 \| [^|]*After the statement[^|]*=5,592,500\.00/.test(await rows())
    && (await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Bank fee/.test(tr.textContent)).classList.contains('on')"))
    && (await tab.eval('window.__changed.length')) === 0, await rows());
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await typeIn('2026-09-01 * Coffee beans  ; for the office\n    Expenses:Food:Coffee    25000 IDR\n    Assets:Bank:Checking');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('an edit changes the amount and every balance after it, and is marked',
    (await cell(0, 2)) === '-25,000.00' && (await cell(0, 3)) === '975,000.00' && /Coffee beansedited/.test(await cell(0, 1)),
    `${await cell(0, 2)} ${await cell(0, 3)} ${await cell(0, 1)}`);
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  check('an edit reopens with what was typed, and can be undone', /Coffee beans/.test(await area()) && (await tab.eval("!!document.querySelector('tr.editor [data-undo]')")), '');
  await tab.eval("document.querySelector('tr.editor [data-undo]').click()");
  check('and is as it was', (await cell(0, 2)) === '-21,000.00', await cell(0, 2));
  const pendingKept = await rowOf('/Pending transfer/');
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${pendingKept}].querySelector('button[data-edit]').click()`);
  await typeIn('');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  check('kept empty, the transaction leaves the list and is listed to restore', !/Pending transfer/.test(await rows()) && /Deleted: 2026-09-03 Pending transfer/.test(await text('notes')), await text('notes'));
  await tab.eval("document.querySelector('#notes button[data-restore]').click()");
  check('and restore brings it back', /Pending transfer/.test(await rows()) && !/Deleted/.test(await text('notes')), await text('notes'));
  const keptFee = await rowOf('/Bank fee/');
  await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${keptFee}].querySelector('button[data-edit]').click()`);
  check('a new one reopens with its text', /Bank fee/.test(await area()), '');
  await tab.eval("document.querySelector('tr.editor [data-drop]').click()");
  check('and can be removed', !/Bank fee/.test(await rows()), await rows());
  // Show the assertion sends the window's own changes with the statement, to be shown.
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('n', { code: 'KeyN', keyCode: 78, text: 'n' });
  await typeIn('2026-09-05 Bank fee\n    Assets:Bank:Checking    -75000.00 IDR\n    Expenses:Fees');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await tab.eval("document.querySelector('#rows button[data-edit]').click()");
  await typeIn('2026-09-01 * Coffee\n    Expenses:Food    21000 IDR  ; checked\n    Assets:Bank:Checking');
  await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
  await tab.eval("(() => { const b = document.getElementById('balance'); b.value = '5,595,000'; b.dispatchEvent(new Event('input')); })()");
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('a', { code: 'KeyA', keyCode: 65, text: 'a' });
  await tab.eval("document.getElementById('finish').click()");
  await tab.until("!document.getElementById('preview').hidden");
  check('its preview shows the rewritten transaction and the added one', /1 transaction rewritten, 1 transaction added/.test(await text('preview')) && /; checked/.test(await text('preview')) && /after line 23:/.test(await text('preview')),
    await text('preview'));
  check('Show the assertion sends the new transaction\'s text and the typed balances with the statement',
    await tab.eval("(() => { const r = window.__lastPreview; return !r.kind && r.inserts.length === 1 && /Bank fee/.test(r.inserts[0].text) && !r.inserts[0].after && Object.keys(r.expected).length === 1 && r.expected['5:Assets:Bank:Checking:0'] === 560000000 && Object.keys(r.edits).length === 1 && r.finish.balance === 559500000 && r.ticked.length === 6; })()"),
    await tab.eval('JSON.stringify(window.__lastPreview)'));
  await tab.eval("document.getElementById('cancel').click()");

  // Finding a transaction booked to another account, from the hint where they part.
  await tab.show('reconcile', 'dark', '&lines=on');
  await expect(3, '5,600,000');
  await tab.eval("document.querySelector('#hints button[data-find]').click()");
  await tab.until("document.querySelectorAll('#found li').length > 0");
  const found = await tab.eval(`(() => {
    const view = document.getElementById('find-file');
    return {
      open: !document.getElementById('find').hidden,
      amount: document.getElementById('find-amount').value,
      date: document.getElementById('find-date').value,
      asked: window.__found,
      said: document.getElementById('find-said').textContent,
      item: document.querySelector('#found li').innerText,
      moves: document.querySelectorAll('#found button[data-move]').length,
      chosen: document.querySelector('#found li').classList.contains('chosen'),
      where: view.hidden ? '' : view.querySelector('.where').textContent,
      lit: [...view.querySelectorAll('.hl')].map((line) => line.textContent),
    };
  })()`);
  check('Find it opens the search with the amount where they part and its date, and asks for it',
    found.open && found.amount === '-75,000.00' && found.date === '2026-09-05'
    && found.asked.amount === -7500000 && found.asked.date === '2026-09-05' && found.asked.words === '', JSON.stringify(found));
  check('and lists what it found, why, and a way to move each posting',
    /^1 transaction under other accounts\. Moving a posting changes its account to Assets:Bank:Checking in place/.test(found.said)
    && /2026-09-04 Bank fee/.test(found.item) && /1 day from the date/.test(found.item) && found.moves === 2 && found.chosen, JSON.stringify(found));
  check('with the first shown, lit, in its whole file',
    found.where === 'fixture.journal, lines 29 to 31' && found.lit.length === 3 && /^29\s*2026-09-04 Bank fee$/.test(found.lit[0]), JSON.stringify(found));
  await tab.eval("(() => { document.querySelector('#found li').click(); document.querySelector('#found li').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()");
  check('a click or Enter on it shows it', await tab.eval("document.querySelector('#found li').classList.contains('chosen') && !document.getElementById('find-file').hidden"), '');
  await tab.eval("document.querySelectorAll('#found button[data-move]')[1].click()");
  await done();
  const account = await last();
  const after = await tab.eval(`({
    said: document.getElementById('find-said').textContent,
    found: document.querySelectorAll('#found li').length,
    file: document.getElementById('find-file').hidden,
    row: ([...document.querySelectorAll('#rows tr[data-id]')].find((tr) => /Bank fee/.test(tr.textContent)) || {}).innerText || '',
  })`);
  check('moving a posting sends the transaction as found and the line of the posting',
    account.kind === 'account' && account.at === 2 && account.candidate.text === FOUND_TEXT && account.candidate.first === 29 && account.candidate.file === 'fixture.journal', JSON.stringify(account));
  check('and it is in this account now, said, and gone from the list of finds',
    /^Moved: 2026-09-04 Bank fee is in Assets:Bank:Checking now, and no longer in Assets:Cash\.$/.test(after.said)
    && after.found === 0 && after.file && /Bank fee/.test(after.row) && /-75,000\.00/.test(after.row), JSON.stringify(after));
  await tab.eval("(() => { const words = document.getElementById('find-words'); words.value = 'nothing like it'; words.focus(); })()");
  await tab.key('Enter', { code: 'Enter', keyCode: 13 });
  await tab.until("/^Nothing/.test(document.getElementById('find-said').textContent)");
  check('Enter in a field searches, and finding nothing says what to do instead',
    /^Nothing under another account matches\. It may be missing from the journal: add it instead\.$/.test(await tab.eval("document.getElementById('find-said').textContent")), await tab.eval("document.getElementById('find-said').textContent"));
  await tab.eval("(() => { document.getElementById('find-amount').value = ''; document.getElementById('find-words').value = ''; document.getElementById('find-go').click(); })()");
  await tab.until("/^Give/.test(document.getElementById('find-said').textContent)");
  check('and a search with nothing to look for says what it needs', true, '');
  await tab.eval(`(() => {
    window.opener.__reconcileBridges.check.source = () => null;
    const data = window.__current();
    data.rows[0].description = 'Coffee, read again';
    window.__outside = data;
    window.dispatchEvent(new Event('focus'));
  })()`);
  await tab.until("/changed outside/.test(document.getElementById('status').textContent)");
  await tab.eval("(() => { document.getElementById('find-amount').value = '75,000'; document.getElementById('find-go').click(); })()");
  await tab.until("!document.getElementById('find-file').hidden");
  check('a file the app cannot show is said in place of it',
    /^fixture\.journal cannot be shown here\.$/.test(await tab.eval("document.getElementById('find-file').textContent")), await tab.eval("document.getElementById('find-file').textContent"));
  await tab.eval("document.getElementById('find-amount').focus()");
  await tab.key('Escape', { code: 'Escape', keyCode: 27 });
  check('Escape in the search puts it away', await tab.eval("document.getElementById('find').hidden"), '');
  await tab.eval("document.activeElement && document.activeElement.blur()");
  await tab.key('f', { code: 'KeyF', keyCode: 70, text: 'f' });
  check('f opens it again, at the amount still unaccounted for',
    (await tab.eval("!document.getElementById('find').hidden && document.activeElement.id === 'find-amount'")), await tab.eval("document.getElementById('find-amount').value"));
  await tab.eval("document.getElementById('find-close').click()");
  await tab.eval("document.getElementById('find-open').click()");
  check('and Close and the button do the same', !(await tab.eval("document.getElementById('find').hidden")), '');
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
  // The refusal is a confirmation rather than the first time the visitor learns it: the
  // status says so as soon as there is a change, not only when a save is attempted.
  await tab.send('Input.insertText', { text: 'x' });
  await sleep(100);
  check('typing in a read-only file says so straight away, not on save',
    (await status()) === 'read-only: nothing typed here is saved', await status());

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
  // ONLY=reconcile runs the reconcile checks alone, for working on them; the coverage floor is
  // then not checked, since most of the measured files were never loaded.
  if (!ONLY) {
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
  }
  if (!ONLY || ONLY === 'reconcile' || ONLY === 'live') await liveChecks(tab, check);
  if (ONLY === 'live') throw Object.assign(new Error('only the live checks were asked for'), { quiet: true });
  await reconciling(tab);
  await reconcileRunning(tab);
  await reconcileDates(tab);
  await reconcileDateEditing(tab);
  await reconcileNarrow(tab);
  await reconcileGeneric(tab);
  await reconcileStyle(tab);
  await reconcileAlreadyCleared(tab);
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
if (failure && !failure.quiet) {
  console.log(`FAIL the browser check stopped: ${failure.stack || failure}`);
  process.exit(1);
}

for (const { name, share } of ONLY ? [] : coverage.report()) {
  check(`${name} is ${(100 * share).toFixed(1)}% executed (at least ${100 * FLOOR}%)`, share >= FLOOR, '');
}

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} browser checks passed`);
process.exit(failed === 0 ? 0 : 1);
