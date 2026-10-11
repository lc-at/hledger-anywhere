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
 * The command is shown in the window, so what was asked for is never a mystery. Drawing lives
 * in ./chart-window.js, which the window imports too: the same code draws the first page and
 * every redraw after it.
 */

import { page } from './chart-window.js';

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
      report = read(await host.hledger(query.command));
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
      options: query.options,
      preset: query.preset,
      presets: PRESETS.map((entry) => ({ id: entry.names[0], name: entry.title })),
      module: new URL('./chart-window.js', import.meta.url).href,
    }));
    if (query.account) host.remember('account', query.account);
    host.say(`${host.name}: ${summary(query, report)}, in a new window.`);
  },
};

/**
 * What the window asked for, as a command hledger can run.
 *
 * A request is a preset name, an account of your own, a period, or a bare account string from a
 * drill-down. An account overrides a preset, because typing one is a more specific thing to say
 * than pressing a button, and a period is passed to hledger as `-p`, quoted so a period
 * expression with spaces in it arrives as one argument.
 */
export function compose(request) {
  if (typeof request === 'string') return build(request);
  const parts = [];
  if (request.account) parts.push(request.account);
  else if (request.preset) parts.push(request.preset);
  if (request.period) parts.push('-p', quote(request.period));
  return build(parts.join(' '));
}

/** One argument, quoted if it has spaces in it. */
function quote(text) {
  const trimmed = String(text).trim();
  return /\s/.test(trimmed) ? `"${trimmed.replace(/"/g, '')}"` : trimmed;
}

/** What the caller asked for, as a command hledger can run. */
export function build(args) {
  const words = String(args == null ? '' : args).trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  const preset = PRESETS.find((entry) => entry.names.includes(first));

  if (preset) {
    let account = preset.account;
    let flags = rest;
    if (account && rest.length > 0 && !rest[0].startsWith('-')) {
      [account, ...flags] = rest;
    }
    const report = preset.report(account);
    return {
      command: csv(`${report} ${flags.join(' ')}`.trim()),
      title: account && preset.account ? `${preset.title} of ${account}` : preset.title,
      account,
      preset: preset.names[0],
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

/** One CSV line, honouring quoted cells. */
export function split(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { cells.push(cell); cell = ''; }
    else cell += character;
  }
  cells.push(cell);
  return cells;
}

/**
 * An amount, with the commodity hledger wrote around it kept.
 *
 * hledger writes "$1,286.40", "-$12.00" or "1234.56 EUR" depending on the journal, and the
 * currency belongs on the chart. Both decimal styles are read, since `--decimal-mark` is a
 * thing a journal can set. `raw` is kept so a section row can be told from a row of zeroes.
 */
export function money(text) {
  const raw = String(text == null ? '' : text).trim();
  const empty = { value: 0, prefix: '', suffix: '', raw: '' };
  if (raw === '') return empty;

  // The sign is read before the digits are looked for, because hledger puts the commodity
  // between them: `-$12.00` is negative, and a digit match that never saw the minus read it
  // as twelve. `$12.00-` and the accounting `(12.00)` are read too.
  let body = raw;
  let sign = 1;
  if (/^\(.*\)$/.test(body)) {
    sign = -1;
    body = body.slice(1, -1).trim();
  }
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1).trim();
  } else if (body.endsWith('-')) {
    sign = -1;
    body = body.slice(0, -1).trim();
  }

  const found = body.match(/[\d.,]+/);
  if (!found) return { ...empty, raw };
  let digits = found[0];
  const comma = digits.lastIndexOf(',');
  const dot = digits.lastIndexOf('.');
  digits = comma > dot
    ? digits.replace(/\./g, '').replace(',', '.')   // 1.234,56
    : digits.replace(/,/g, '');                     // 1,234.56
  const value = Number(digits);
  if (!Number.isFinite(value)) return { ...empty, raw };

  return {
    value: sign * value,
    prefix: body.slice(0, found.index).trim(),
    suffix: body.slice(found.index + found[0].length).trim(),
    raw,
  };
}

/** The commodity to label an axis with: the first one hledger actually wrote. */
function unitOf(amounts) {
  const found = amounts.find((amount) => amount.prefix || amount.suffix);
  return { prefix: found ? found.prefix : '', suffix: found ? found.suffix : '' };
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
    async requery(request) {
      const query = compose(request);
      const report = read(await host.hledger(query.command));
      if (!report) {
        throw new Error(`hledger had nothing to chart for ${query.title}`);
      }
      return {
        report,
        command: query.command,
        options: query.options || {},
        title: query.title,
        preset: query.preset || null,
      };
    },
  };
  return token;
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
