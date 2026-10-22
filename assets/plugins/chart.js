/**
 * A chart of hledger's numbers, in a window of its own.
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
 *
 * The window is opened before anything is awaited, because a pop-up opened after an await is
 * blocked. That is the whole reason `window()` returns a handle rather than taking content.
 *
 *     chart [chart options] <type> [hledger arguments]
 *     chart --log bar -p 2026 coffee
 *
 * The grammar lives in ./chart-args.js. The command is shown in the window, so what was asked
 * for is never a mystery. Every chart is drawn with D3, the one library the window loads. The
 * page and the model live in ./chart-window.js, the drawing in ./chart-d3.js, and the tooltip,
 * legend, keys and saving in ./chart-ui.js; the window imports them too, so the same code draws
 * the first page and every redraw after it.
 */

import { page } from './chart-window.js';
import { command, line, parse, related, title } from './chart-args.js';
import { counted, format, money, periodTotal, shape, split, unitOf } from './chart-data.js';
import { beside, bridge, colorsOf, shell } from './window-kit.js';
import { byDay, flows, headlineFor, isCustom, readRegister, readTree, waterfall } from './chart-d3.js';

export default {
  async run(args, host) {
    const query = build(args);
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
      view.write(shell(colors, query.title, 'hledger returned nothing to chart.'));
      host.say(`${host.name}: ${query.title} has no amounts to chart. The command was: hledger ${query.command}`);
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
      args: query.args,
      related: query.related,
      module: beside('chart-window.js'),
      // Every chart is drawn with D3, so the window loads one library and nothing else.
      scripts: [beside('vendor/d3/d3.min.js')],
    }));
    host.say(`${host.name}: ${summary(query, report)}, in a new window.`);
  },
};

/**
 * A line after `chart`, as everything the plugin and the window need: the hledger command,
 * the window's title, the type and options that draw it, the line itself for following marks
 * and links from, and the related charts. Or a refusal that says what to type instead.
 */
export function build(args) {
  const parsed = parse(args);
  if (parsed.error) return { refusal: parsed.error, title: 'chart', options: {} };
  return {
    command: command(parsed),
    title: title(parsed),
    kind: parsed.type,
    options: parsed.options,
    args: line(parsed),
    related: related(parsed),
  };
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
 * Parse the report a type asked for, and reduce it to what the chart draws.
 *
 * The balance charts read hledger's balance CSV: one row per account, one column per period,
 * and the window shapes it by the chart options. The treemap reads the tree, the calendar and
 * the waterfall the register, and the Sankey reduces a balance report to flows; aggregating
 * here means the window, the headline and the table all receive the same finished data.
 */
export function parseReport(kind, text) {
  if (kind === 'treemap') return readTree(text);
  if (kind === 'calendar' || kind === 'waterfall') {
    const register = readRegister(text);
    if (!register) return null;
    return kind === 'calendar' ? byDay(register) : waterfall(register);
  }
  if (kind === 'sankey') {
    const report = read(text);
    return report ? flows(report) : null;
  }
  return read(text);
}

/**
 * Let this window ask for another chart.
 *
 * A click on a mark, or on a related chart, needs hledger again and therefore the plugin on
 * this side of the window. The window works out the line to ask for, with the same grammar,
 * and the bridge runs it: the window is a page with no API of its own, so the bridge is a
 * function on the opener, kept by a token the page carries.
 */
function listen(host) {
  return bridge('__chartBridges', 'chart', {
    async requery(args) {
      const query = build(args);
      if (query.refusal) throw new Error(query.refusal);
      const report = parseReport(query.kind, await host.hledger(query.command));
      if (!report) throw new Error(`hledger had nothing to chart for ${query.title}`);
      return {
        report,
        command: query.command,
        options: query.options,
        kind: query.kind,
        title: query.title,
        args: query.args,
        related: query.related,
      };
    },
  });
}

/** One line for the terminal, so the window is not the only place the answer lives. */
function summary(query, report) {
  // The shaped charts already have a sentence for their data; using it keeps the terminal and
  // the window saying the same thing.
  // Sparklines read a balance report, which the window shapes, so they are summed up as one.
  if (isCustom(query.kind) && query.kind !== 'multiples') return `${query.kind}, ${headlineFor(query.kind, report)}`;
  // Said of the numbers as the chart shows them: an inverted running total is summed up as
  // one, not as the raw report the window reshaped.
  const shown = shape(report, query.options);
  const unit = shown.unit;
  const accounts = counted(shown.series.length, 'account');
  if (shown.periods.length > 1) {
    const first = periodTotal(shown, 0).value;
    const last = periodTotal(shown, shown.periods.length - 1).value;
    const change = last - first;
    return `${query.kind} of ${accounts} over ${shown.periods.length} periods, the last ${
      format({ value: last, ...unit })}, ${change >= 0 ? 'up' : 'down'} ${format({ value: Math.abs(change), ...unit })}`;
  }
  const biggest = shown.series
    .map((series) => ({ label: series.label, amount: series.amounts[0] }))
    .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value))[0];
  return `${query.kind} of ${accounts}, the largest ${format(biggest.amount)} in ${biggest.label}`;
}
