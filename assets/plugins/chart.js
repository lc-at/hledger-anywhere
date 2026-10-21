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
 * And the charts that ask for the report their shape needs:
 *
 *     chart stacked [account]   spending by category, stacked month by month
 *     chart treemap [account]   where the money went, as a treemap
 *     chart sankey              income flowing into each kind of spending, and what was saved
 *     chart calendar [-p 2024]  a year of daily spending
 *     chart waterfall           income, each expense category, and net
 *     chart multiples           a sparkline per account, month by month
 *
 * The command is shown in the window, so what was asked for is never a mystery. Every chart is
 * drawn with D3, the one library the window loads. The page and the model live in
 * ./chart-window.js, the drawing in ./chart-d3.js, and the tooltip, legend, keys and saving in
 * ./chart-ui.js; the window imports them too, so the same code draws the first page and every
 * redraw after it.
 */

import { page } from './chart-window.js';
import { format, money, periodTotal, split, unitOf } from './chart-data.js';
import { beside, bridge, colorsOf, shell } from './window-kit.js';
import { byDay, flows, headlineFor, isCustom, multiples, readRegister, readTree, waterfall } from './chart-d3.js';

/**
 * hledger's balance reports, so `chart balance assets -M` is read as a report.
 *
 * Only reports whose CSV is accounts by periods can be drawn. `cashflow` is missing on
 * purpose: it is also a preset, and the preset wins; `cf` is hledger's report.
 */
const REPORTS = [
  'balance', 'bal', 'bs', 'balancesheet', 'bse', 'balancesheetequity',
  'is', 'incomestatement', 'cf',
];

/**
 * Reports that come back in a shape no chart reads, and what to ask for instead.
 *
 * These used to be passed through and then charted nothing, which said "no amounts" about a
 * register that was full of them.
 */
const NOT_CHARTS = {
  register: 'chart calendar or chart waterfall',
  reg: 'chart calendar or chart waterfall',
  aregister: 'chart <account>',
  areg: 'chart <account>',
  print: 'chart calendar',
  stats: 'chart',
  accounts: 'chart treemap',
};

/**
 * The named questions.
 *
 * `account` means the preset takes one: everything else the caller typed is passed through to
 * hledger, which is how `chart spending -p 2024` asks for a year of months. `named` is the title
 * when the caller named an account, for a preset whose title does not take "of <account>".
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
  // A stacked area wants categories, not leaves: one level below the account asked for, so
  // `chart stacked` stacks food, housing and reading rather than coffee and groceries.
  {
    names: ['stacked', 'area'],
    title: 'spending by category',
    named: (account) => `${account} by category`,
    account: 'expenses',
    kind: 'stacked',
    report: (account) => `balance ${account} -M --depth ${account.split(':').length + 1}`,
  },
  // The shaped charts. Each asks hledger for the report its picture needs: a tree for the
  // treemap, income and expense categories for the Sankey, the register for the calendar and
  // the waterfall, monthly balances for the sparklines.
  {
    names: ['treemap'],
    title: 'where the money went',
    named: (account) => `${account}, as a treemap`,
    kind: 'treemap',
    account: 'expenses',
    report: (account) => `balance --tree ${account}`,
  },
  {
    names: ['sankey', 'flows'],
    title: 'where income went',
    kind: 'sankey',
    report: () => 'balance income expenses --depth 2',
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
    const colors = colorsOf(host);

    // Said before any window opens: there is nothing to show in one.
    if (query.refusal) {
      host.say(`${host.name}: ${query.refusal}`);
      return;
    }

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
      // A word that is close to a question was probably meant as one: `chart spendng` asks
      // hledger about an account nobody has, and the answer should say what was likely meant.
      const meant = query.account ? closestQuestion(query.account) : null;
      const hint = meant ? ` Did you mean chart ${meant}?` : '';
      view.write(shell(colors, query.title, `hledger returned nothing to chart.${hint}`));
      host.say(`${host.name}: ${query.title} has no amounts to chart.${hint}`);
      return;
    }

    const token = listen(host);
    view.write(page({
      report,
      colors,
      title: query.title,
      command: query.command,
      token,
      kind: query.kind,
      options: query.options,
      related: query.related || [],
      module: beside('chart-window.js'),
      // Every chart is drawn with D3, so the window loads one library and nothing else.
      scripts: [beside('vendor/d3/d3.min.js')],
    }));
    if (query.account) host.remember('account', query.account);
    // The first chart most people ask for is the bare word, so that is where the rest of
    // them are pointed out; once is enough after that, so the others do not repeat it.
    const next = asked ? '' : ` Tab after ${host.name} lists the other questions.`;
    const note = query.note ? ` ${query.note}` : '';
    host.say(`${host.name}: ${summary(query, report)}, in a new window.${note}${next}`);
  },
};

/** The words that set the interval, and the flag each one means to hledger. */
const INTERVALS = {
  daily: '-D', weekly: '-W', monthly: '-M', quarterly: '-Q', yearly: '-Y', annually: '-Y',
};
const INTERVAL_FLAGS = ['-D', '--daily', '-W', '--weekly', '-M', '--monthly', '-Q', '--quarterly', '-Y', '--yearly'];

/** hledger's flags that take the next word as their value, so that word is left with them. */
const VALUED_FLAGS = [
  '-p', '--period', '-b', '--begin', '-e', '--end', '--depth', '--pivot', '-O', '--output-format',
  '-X', '--exchange', '--value', '-f', '--file', '--format', '--alias',
];

/** A word that is a date or a named stretch of one: 2024, 2024-03, 2024q1, 2024-03-15. */
const DATE = /^\d{4}(?:-\d{1,2}(?:-\d{1,2})?|[qQ][1-4])?$/;
const SPANS = ['day', 'week', 'month', 'quarter', 'year'];

/**
 * The words of a period and an interval, read out of the rest.
 *
 * People say when they mean in words, so that is what is read: `2024`, `2024q1`, `last year`,
 * `this month`, `since 2024-06`, `2023 to 2024`, `today`; and `weekly`, `monthly` and the
 * rest for how to split it. Each is turned into what hledger expects, `-p "last year"` and
 * `-W`, and the words that were neither are handed back in order. A flag is passed through
 * with its value untouched, so `-p 2024` is never read twice.
 */
export function understand(words) {
  const rest = [];
  const flags = [];
  let period = null;
  let interval = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const lower = word.toLowerCase();
    const next = (words[index + 1] || '').toLowerCase();
    if (word.startsWith('-')) {
      flags.push(word);
      if (VALUED_FLAGS.includes(word) && index + 1 < words.length) flags.push(words[(index += 1)]);
      continue;
    }
    if (INTERVALS[lower]) {
      interval = { word: lower, flag: INTERVALS[lower] };
      continue;
    }
    if (period) {
      rest.push(word);
      continue;
    }
    if (['this', 'last', 'next'].includes(lower) && SPANS.includes(next)) {
      period = `${lower} ${next}`;
      index += 1;
    } else if (lower === 'today' || lower === 'yesterday') {
      period = lower;
    } else if (['since', 'from'].includes(lower) && DATE.test(next)) {
      period = `from ${words[index + 1]}`;
      index += 1;
    } else if (lower === 'until' && DATE.test(next)) {
      period = `to ${words[index + 1]}`;
      index += 1;
    } else if (DATE.test(word) && ['to', 'until'].includes(next) && DATE.test(words[index + 2] || '')) {
      period = `from ${word} to ${words[index + 2]}`;
      index += 2;
    } else if (DATE.test(word)) {
      period = word;
    } else {
      rest.push(word);
    }
  }
  return { rest, flags, period, interval };
}

/**
 * The split a period wants when none was asked for: a day or a week by the day, anything
 * longer by the month. A week split into months is one column that starts on the wrong day.
 */
function defaultSplit(period) {
  return period && /^(today|yesterday|(this|last|next) week|\d{4}-\d{1,2}-\d{1,2})$/.test(period) ? '-D' : '-M';
}

/** "spending" with what was asked of it: "spending, 2024, weekly". */
function titled(base, period, interval) {
  return [base, period, interval && interval.word].filter(Boolean).join(', ');
}

/** Put a period on a command, quoted when it has a space in it. */
function periodFlag(period) {
  return period ? (/\s/.test(period) ? `-p "${period}"` : `-p ${period}`) : '';
}

/**
 * What the caller asked for, as a command hledger can run.
 *
 * The question can come first or after the account (`chart treemap food`, `chart food
 * treemap`), periods and intervals are words anywhere, and flags still pass through to
 * hledger. An interval replaces a question's monthly default; on a chart that draws one
 * period it would draw something else entirely, so it is left out and `note` says so.
 */
export function build(args) {
  const words = String(args == null ? '' : args).trim().split(/\s+/).filter(Boolean);
  const first = words[0];

  if (NOT_CHARTS[first]) {
    return {
      refusal: `${first} is not a report a chart can draw; try ${NOT_CHARTS[first]}.`,
      title: first,
      options: {},
    };
  }

  const { rest, flags, period, interval } = understand(words);
  const flagged = flags.some((flag) => INTERVAL_FLAGS.includes(flag));
  const tail = (command) => csv([command, periodFlag(period), ...flags].filter(Boolean).join(' '));

  if (REPORTS.includes(rest[0])) {
    const command = [...rest, interval && interval.flag].filter(Boolean).join(' ');
    return { command: tail(command), title: titled(rest.join(' '), period, interval), options: {}, related: [] };
  }

  const at = rest.findIndex((word) => PRESETS.some((entry) => entry.names.includes(word)));
  const preset = at >= 0 ? PRESETS.find((entry) => entry.names.includes(rest[at])) : null;
  if (preset) {
    const others = rest.filter((_, index) => index !== at);
    const asked = Boolean(preset.account && others.length > 0);
    const account = asked ? others.join(' ') : preset.account;
    let report = preset.report(account);
    let note = '';
    const monthly = / -M\b/.test(report);
    if (monthly && (interval || flagged)) {
      report = report.replace(/ -M\b/, interval ? ` ${interval.flag}` : '');
    } else if (monthly && defaultSplit(period) !== '-M') {
      report = report.replace(/ -M\b/, ` ${defaultSplit(period)}`);
    } else if (!monthly && interval) {
      note = `${interval.word} was left out: ${preset.names[0]} draws one period, not a series.`;
    }
    const base = asked ? (preset.named ? preset.named(account) : `${preset.title} of ${account}`) : preset.title;
    return {
      command: tail(report),
      title: titled(base, period, monthly ? interval : null),
      account: preset.account ? account : undefined,
      kind: preset.kind || null,
      options: preset.options || {},
      note,
      related: related(preset.names[0], preset.account ? account : null, words),
    };
  }

  // Anything else is an account: for example `chart expenses:food`. Months, unless an
  // interval was asked for in words or as a flag.
  const named = rest.join(' ');
  const account = named || 'expenses';
  const split = interval ? interval.flag : flagged ? '' : defaultSplit(period);
  return {
    command: tail([`balance ${account}`, split].filter(Boolean).join(' ')),
    title: titled(account, period, interval),
    account,
    options: {},
    related: related(null, account, words),
  };
}

/**
 * Charts worth trying next, from this one: the same account asked other ways, or the questions
 * that answer the same kind of thing. Each is the command a person would type, period and all,
 * so following one also shows how to ask for it.
 */
export function related(question, account, words) {
  const kept = understand(words);
  const when = [kept.period].filter(Boolean).join(' ');
  const make = (args) => ({ label: `chart ${args}${when ? ` ${when}` : ''}`, args: `${args}${when ? ` ${when}` : ''}` });
  if (account) {
    const ways = [[null, account], ['top', `top ${account}`], ['shares', `shares ${account}`],
      ['treemap', `treemap ${account}`], ['stacked', `stacked ${account}`]];
    return ways.filter(([name]) => name !== question).map(([, args]) => make(args));
  }
  const families = [
    ['income', 'cashflow', 'sankey', 'waterfall'],
    ['networth', 'balances', 'multiples'],
    ['calendar', 'spending', 'treemap'],
  ];
  const family = families.find((names) => names.includes(question)) || [];
  return family.filter((name) => name !== question).map((name) => make(name));
}

/** Every word that names a question, as `chart?` lists them. */
export function questions() {
  return PRESETS.flatMap((preset) => preset.names);
}

/**
 * The question a mistyped word was probably meant to be, or null.
 *
 * Only a single word without a colon is considered, since `expenses:fod` is an account
 * question, and only a near miss: at most two letters off, and fewer for short words.
 */
export function closestQuestion(word) {
  const text = String(word || '').toLowerCase();
  if (!text || /[\s:]/.test(text)) return null;
  let best = null;
  for (const name of questions()) {
    const distance = editDistance(text, name);
    const allowed = name.length <= 4 ? 1 : 2;
    if (distance > 0 && distance <= allowed && (!best || distance < best.distance)) best = { name, distance };
  }
  return best ? best.name : null;
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

/** Add the CSV output format, unless the caller asked for one of their own. */
function csv(report) {
  const words = report.split(/\s+/).filter(Boolean);
  const chosen = words.some((word) => word === '-O' || word === '--output-format');
  return chosen ? words.join(' ') : `${words.join(' ')} -O csv`;
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
 * The balance charts read hledger's balance CSV: one row per account, one column per period. A
 * shaped chart reads the report it needs and then aggregates: the treemap draws the tree
 * itself, the calendar draws days, the waterfall draws the walk from income to net, the
 * sparklines draw the largest accounts, and the Sankey draws income into spending. Aggregating
 * here means the window, the headline and the table all receive the same finished data.
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
  if (kind === 'sankey') {
    const report = read(text);
    return report ? flows(report) : null;
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
function listen(host) {
  return bridge('__chartBridges', 'chart', {
    async requery(account) {
      // A window asks for an account, or for one of the charts it suggests, which is any
      // line `chart` itself would take.
      const query = build(account);
      if (query.refusal) throw new Error(query.refusal);
      const report = parseReport(query.kind, await host.hledger(query.command));
      if (!report) {
        throw new Error(`hledger had nothing to chart for ${query.title}`);
      }
      return {
        report,
        command: query.command,
        options: query.options || {},
        kind: query.kind || null,
        title: query.title,
        related: query.related || [],
      };
    },
  });
}


/** One line for the terminal, so the window is not the only place the answer lives. */
function summary(query, report) {
  // The D3 charts already have a sentence for their data; using it keeps the terminal and the
  // window saying the same thing.
  if (isCustom(query.kind)) return headlineFor(query.kind, report);
  const unit = report.unit;
  if (report.periods.length > 1) {
    const first = periodTotal(report, 0).value;
    const last = periodTotal(report, report.periods.length - 1).value;
    const change = last - first;
    return `${report.periods.length} periods of ${query.title}, ${format({ value: last, ...unit })}, ${
      change >= 0 ? 'up' : 'down'} ${format({ value: Math.abs(change), ...unit })}`;
  }
  const biggest = report.series
    .map((series) => ({ label: series.label, amount: series.amounts[0] }))
    .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value))[0];
  return `${report.series.length} accounts, ${format(biggest.amount)} in ${biggest.label}`;
}
