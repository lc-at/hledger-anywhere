/**
 * A balance chart, in a window of its own.
 *
 * This ships with the app as the worked example of the plugin API, so it is written the way
 * the docs tell an author to write one. Nothing here is part of the app's core: it runs in
 * the page, with the API it is handed.
 *
 *     host.name                  this plugin's word, "chart"
 *     host.hledger(command)      run hledger (read-only) and resolve with its stdout
 *     host.say(text)             print a line, the way the app prints its own
 *     host.window(title)         open a window now, and fill it in later
 *     host.colors()              the colours of the theme in use, so the window matches
 *     host.setting(key)          a setting this plugin remembered
 *     host.remember(key, value)  remember it for next time
 *
 * The window is opened before anything is awaited, because a pop-up opened after an await is
 * blocked. That is the whole reason `window()` returns a handle rather than taking content.
 *
 * Named questions, each one hledger's own report:
 *
 *     chart                     what spending did, month by month
 *     chart spending            the same, said out loud
 *     chart income              what came in
 *     chart cashflow            income against expenses, per month
 *     chart networth            assets against liabilities, running total
 *     chart balances            every account, end of month
 *     chart payees              spending by payee, month by month
 *     chart top                 where it all went, largest first
 *     chart expenses:food -p 2024   any account, any period
 *     chart balance assets -M   any hledger report, verbatim
 *
 * And the four charts D3 draws, each asking for the report its shape needs:
 *
 *     chart treemap [account]   where the money went, as a treemap
 *     chart calendar [-p 2024]  a year of daily spending
 *     chart waterfall           income, each expense category, and net
 *     chart multiples           a sparkline per account, month by month
 *
 * The command is shown in the window, so what was asked for is never a mystery. Drawing lives
 * in ./chart-window.js, which the window imports too: the same code draws the first page and
 * every redraw after it.
 */

import { page } from './chart-window.js';
import { money, split, unitOf } from './chart-data.js';
import { byDay, headlineFor, isD3Kind, multiples, readRegister, readTree, waterfall } from './chart-d3.js';

// The check script imports the amount parser from here, because a plugin is where a parser
// lives. It is defined once, in chart-data.js, and shared with the window and the D3 chart.
export { money, split } from './chart-data.js';

const FALLBACK_COLORS = {
  background: '#000000',
  foreground: '#d8d8d8',
  cursor: '#ff9f1c',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

/** Flags that mean the caller has already chosen a period, so months are not added. */
const PERIOD_FLAGS = [
  '-D', '--daily', '-W', '--weekly', '-M', '--monthly',
  '-Q', '--quarterly', '-Y', '--yearly', '-p', '--period',
];

/** hledger's report commands, so `chart balance assets -M` is read as a report. */
const REPORTS = [
  'balance', 'bal', 'bs', 'balancesheet', 'is', 'incomestatement', 'cashflow',
  'register', 'reg', 'aregister', 'print', 'stats',
];

/**
 * The named questions.
 *
 * `account` means the preset takes one: everything else the caller typed is passed through to
 * hledger, which is how `chart spending -p 2024` asks for a year of months.
 */
const PRESETS = [
  { names: ['spending'], title: 'spending', report: () => 'balance expenses -M' },
  { names: ['income'], title: 'income', report: () => 'balance income -M' },
  { names: ['cashflow', 'savings'], title: 'cashflow', report: () => 'balance income expenses -M' },
  {
    names: ['networth', 'nw'],
    title: 'net worth',
    options: { total: true, label: 'net worth' },
    report: () => 'balance assets liabilities -H -M',
  },
  { names: ['balances', 'everything'], title: 'balances', report: () => 'balance -H -M' },
  {
    names: ['payees'],
    title: 'payees',
    account: 'expenses',
    report: (account) => `balance ${account} --pivot payee -M`,
  },
  { names: ['top'], title: 'top', account: 'expenses', report: (account) => `balance ${account}` },
  {
    names: ['shares'],
    title: 'shares',
    account: 'expenses',
    kind: 'shares',
    report: (account) => `balance ${account}`,
  },
  // The charts D3 draws. Each asks hledger for the report its shape needs: a tree for the
  // treemap, the register for the calendar and the waterfall, monthly balances for the
  // sparklines.
  {
    names: ['treemap'],
    title: 'where the money went',
    kind: 'treemap',
    account: 'expenses',
    report: (account) => `balance --tree ${account}`,
  },
  { names: ['calendar'], title: 'daily spending', kind: 'calendar', report: () => 'register' },
  { names: ['waterfall'], title: 'income to net', kind: 'waterfall', report: () => 'register' },
  {
    names: ['multiples', 'sparklines'],
    title: 'accounts over time',
    kind: 'multiples',
    report: () => 'balance -M',
  },
];

export default {
  async run(args, host) {
    const asked = String(args == null ? '' : args).trim();
    const query = build(asked);
    const colors = typeof host.colors === 'function' ? host.colors() : FALLBACK_COLORS;

    // Opened first, filled when the numbers arrive.
    const view = host.window(`hledger: ${query.title}`);
    if (!view) {
      host.say(`${host.name}: the browser blocked the window for ${query.title}.`);
      return;
    }
    view.write(shell(colors, query.title, 'Reading hledger…'));

    let report;
    try {
      // -O csv is the only hledger output that keeps periods, accounts and amounts apart
      // without parsing a table whose columns move.
      report = parseReport(query.kind, await host.hledger(query.command));
    } catch (error) {
      const why = error && error.message ? error.message : String(error);
      view.write(shell(colors, query.title, why));
      host.say(`${host.name}: ${why}`);
      return;
    }

    if (!report) {
      view.write(shell(colors, query.title, 'hledger returned nothing to chart.'));
      host.say(`${host.name}: ${query.title} has no amounts to chart.`);
      return;
    }

    const token = listen(host, query, colors);
    view.write(page({
      report,
      colors,
      title: query.title,
      command: query.command,
      token,
      kind: query.kind,
      options: query.options,
      module: beside('chart-window.js'),
      // A D3 chart needs one file and no plugins; a Chart.js chart needs the three it has
      // always needed. The window only loads what it draws with.
      scripts: isD3Kind(query.kind)
        ? [beside('vendor/d3/d3.min.js')]
        : [
          beside('vendor/chart.umd.js'),
          beside('vendor/hammer.min.js'),
          beside('vendor/chartjs-plugin-zoom.umd.js'),
        ],
    }));
    if (query.account) host.remember('account', query.account);
    host.say(`${host.name}: ${summary(query, report)}, in a new window.`);
  },
};

/** What the caller asked for, as a command hledger can run. */
export function build(args) {
  const words = String(args == null ? '' : args).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  const preset = PRESETS.find((entry) => entry.names.includes(first));

  if (preset) {
    let account = preset.account;
    let flags = rest;
    let asked = false;
    if (account && rest.length > 0 && !rest[0].startsWith('-')) {
      [account, ...flags] = rest;
      asked = true;
    }
    const report = preset.report(account);
    return {
      command: csv(`${report} ${flags.join(' ')}`.trim()),
      title: asked ? `${preset.title} of ${account}` : preset.title,
      account,
      kind: preset.kind || null,
      options: preset.options || {},
    };
  }

  if (REPORTS.includes(first)) {
    return { command: csv(words.join(' ')), title: words.join(' '), options: {} };
  }

  // Anything else is an account: for example `chart expenses:food`.
  const named = words.join(' ');
  const account = named || 'expenses';
  return {
    command: csv(`balance ${account}${monthly(named) ? ' -M' : ''}`),
    title: account,
    account,
    options: {},
  };
}

/** Add the CSV output format, unless the caller asked for one of their own. */
function csv(report) {
  const words = report.split(/\s+/).filter(Boolean);
  const chosen = words.some((word) => word === '-O' || word === '--output-format');
  return chosen ? words.join(' ') : `${words.join(' ')} -O csv`;
}

/** Whether to ask hledger for months: yes unless the caller named a period themselves. */
function monthly(args) {
  const words = args.split(/\s+/).filter(Boolean);
  return !words.some((word) => PERIOD_FLAGS.includes(word));
}

/**
 * Read hledger's balance CSV.
 *
 * The shape is one row per account and one column per period, with a Total row:
 *
 *   "account","2024-01","2024-02"
 *   "expenses:food:coffee","0","$12.50"
 *   "Total:","$1286.40","$47.49"
 *
 * The header row is *found* rather than assumed to be first, because balancesheet,
 * incomestatement and cashflow put a title above it and section rows between, and a section
 * row has no amounts. The Total row is skipped: it is the sum of the rows, and adding it
 * would count everything twice. Returns null when there is nothing to draw.
 */
export function read(text) {
  const rows = String(text == null ? '' : text).trim().split('\n').map(split);
  const start = rows.findIndex((cells) => (cells[0] || '').trim().toLowerCase() === 'account');
  if (start < 0) return null;

  const periods = rows[start].slice(1).map((cell) => cell.trim());
  if (periods.length === 0) return null;

  const series = [];
  for (const cells of rows.slice(start + 1)) {
    const label = (cells[0] || '').trim();
    if (!label || /^total:?$/i.test(label)) continue;
    if (cells.length < periods.length + 1) continue;
    const amounts = periods.map((_, index) => money(cells[index + 1]));
    // A section title such as "Assets" or "Cash flows" has no amounts of its own.
    if (amounts.every((amount) => amount.raw === '')) continue;
    series.push({ label, amounts });
  }
  if (series.length === 0) return null;

  return {
    periods,
    series,
    unit: unitOf(series.flatMap((entry) => entry.amounts)),
  };
}

/**
 * Parse the report a kind asked for, and reduce it to what the chart draws.
 *
 * Chart.js kinds read hledger's balance CSV: one row per account, one column per period. A D3
 * kind reads the shape it needs and then aggregates: the treemap draws the tree itself, the
 * calendar draws days, the waterfall draws the walk from income to net, and the sparklines
 * draw the largest accounts. Aggregating here means the window, the headline and the table all
 * receive the same finished data.
 */
export function parseReport(kind, text) {
  if (kind === 'treemap') return readTree(text);
  if (kind === 'calendar' || kind === 'waterfall') {
    const register = readRegister(text);
    if (!register) return null;
    return kind === 'calendar' ? byDay(register) : waterfall(register);
  }
  if (kind === 'multiples') {
    const report = read(text);
    return report ? multiples(report) : null;
  }
  return read(text);
}

/**
 * Let this window ask for another report.
 *
 * Only one thing does: clicking a series charts it on its own, which needs hledger again and
 * therefore the plugin on this side of the window. The window is a page with no API of its
 * own, so the bridge is a function on the opener, kept by a token the page carries.
 */
function listen(host, query, colors) {
  const token = `chart-${(listen.count = (listen.count || 0) + 1)}-${Date.now().toString(36)}`;
  // `window` in a browser, `globalThis` anywhere else: this runs in the app's page, and the
  // check runs it in node to see what it would have written.
  const scope = typeof window === 'undefined' ? globalThis : window;
  const bridges = (scope.__chartBridges = scope.__chartBridges || {});
  bridges[token] = {
    async requery(account) {
      const query = build(account);
      const report = read(await host.hledger(query.command));
      if (!report) {
        throw new Error(`hledger had nothing to chart for ${query.title}`);
      }
      return {
        report,
        command: query.command,
        options: query.options || {},
        kind: query.kind || null,
        title: query.title,
      };
    },
  };
  return token;
}

/**
 * A file beside this plugin, as an absolute URL.
 *
 * The window is a `blob:` document, so a relative path in it would resolve against nothing, and
 * a repository may live anywhere: everything the plugin needs travels with the plugin.
 */
function beside(name) {
  return new URL(`./${name}`, import.meta.url).href;
}

/** The window before there is anything to show, and when something went wrong. */
function shell(colors, title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(title)}</title></head>
<body style="margin:0;background:${colors.background};color:${colors.foreground};
  font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:960px;margin:0 auto;padding:24px">
  <h1 style="font-size:18px;font-weight:600;margin:0 0 4px">${escape(title)}</h1>
  <p style="color:${colors.dim};margin:0">${escape(message)}</p>
</main>
</body></html>`;
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

/** One line for the terminal, so the window is not the only place the answer lives. */
function summary(query, report) {
  // The D3 charts already have a sentence for their data; using it keeps the terminal and the
  // window saying the same thing.
  if (isD3Kind(query.kind)) return headlineFor(query.kind, report);
  const total = (amounts) => amounts.reduce((sum, amount) => sum + amount.value, 0);
  const unit = report.unit;
  if (report.periods.length > 1) {
    const perPeriod = report.periods.map((_, index) => ({
      value: total(report.series.map((series) => series.amounts[index])),
      ...unit,
    }));
    const first = perPeriod[0].value;
    const last = perPeriod[perPeriod.length - 1];
    const change = last.value - first;
    const sign = change >= 0 ? 'up' : 'down';
    return `${report.periods.length} periods of ${query.title}, ${
      formatAmount(last)}, ${sign} ${formatAmount({ value: Math.abs(change), ...unit })}`;
  }
  const biggest = report.series
    .map((series) => ({ label: series.label, amount: series.amounts[0] }))
    .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value))[0];
  return `${report.series.length} accounts, ${formatAmount(biggest.amount)} in ${biggest.label}`;
}

function formatAmount(amount) {
  const sign = amount.value < 0 ? '-' : '';
  const fixed = Math.abs(amount.value).toFixed(2);
  const [whole, fraction] = fixed.split('.');
  return `${sign}${amount.prefix || ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}${amount.suffix || ''}`;
}
