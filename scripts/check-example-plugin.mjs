// Checks the bundled chart plugin, its window, and the repository they ship in.
//
// The plugin is the worked example in docs/plugins.md and the only plugin most people will ever
// see, so it has to keep working. None of this needs a browser: the plugin's job is turning
// arguments into a command and a CSV into data, and the window's job is turning that data into a
// model of what to draw, and both are functions.
//
// What cannot be checked here is the drawing and the interacting — real SVG, a tooltip, a wheel
// zoom, a click that asks hledger again. Those are verified in a browser.
//
// The CSVs below are copied from the shipped engine, not invented:
//
//   hledger balance expenses -M -O csv
//   "account","2024-01","2024-02","2024-03"
//   "expenses:food:coffee","0","$12.50","$0"
//   ...
//   "Total:","$1200.00","$1250.00","$1286.40"
//
// Periods are columns and accounts are rows, which is the opposite of the obvious guess and the
// reason the first version of this plugin charted nothing.
//
// Run with: node scripts/check-example-plugin.mjs

import { readFile } from 'node:fs/promises';

import {
  COLORS,
  FLOWS_CSV,
  MONTHLY_CSV,
  NBSP,
  RANKING_CSV,
  REGISTER_CSV,
  STATEMENT_CSV,
  TREE_CSV,
} from './chart-fixtures.mjs';

import Chart, { build, closestQuestion, parseReport, questions, read } from '../assets/plugins/chart.js';
import Edit from '../assets/plugins/edit.js';
import { page as editPage } from '../assets/plugins/edit-window.js';
import { FALLBACK_COLORS, beside, bridge, colorsOf, escape, isLight, mix, shell } from '../assets/plugins/window-kit.js';
import {
  CUSTOM,
  byDay,
  flows,
  headlineFor,
  heightFor,
  isCustom,
  multiples,
  readRegister,
  readTree,
  sankeyLayout,
  tableFor,
  tick,
  waterfall,
} from '../assets/plugins/chart-d3.js';
import {
  accountAt,
  headline,
  keysLine,
  modelFor,
  page,
  pointText,
  shareText,
  tableView,
  typeFor,
  viewOf,
} from '../assets/plugins/chart-window.js';
import { format, group, money, palette, percent } from '../assets/plugins/chart-data.js';
import { KEYS, fileName, header, keyFor } from '../assets/plugins/chart-ui.js';

/** A statement: a title above the header, and section rows with no amounts. */

const checks = [];
const check = (what, ok, detail = '') => checks.push([what, ok, detail]);
const report = read(MONTHLY_CSV);
const ranking = read(RANKING_CSV);

// ------------------------------------------------------------------ the named questions

check('nothing asks for monthly expenses', build('').command === 'balance expenses -M -O csv', build('').command);
check('spending is the same question said out loud', build('spending').command === 'balance expenses -M -O csv', build('spending').command);
check('income asks for income', build('income').command === 'balance income -M -O csv', build('income').command);
check('cashflow puts income against expenses', build('cashflow').command === 'balance income expenses -M -O csv', build('cashflow').command);
check('net worth runs a running total of assets and liabilities',
  build('networth').command === 'balance assets liabilities -H -M -O csv', build('networth').command);
check('and asks to be drawn as one line', build('networth').options.total === true, JSON.stringify(build('networth').options));
check('balances asks for every account', build('balances').command === 'balance -H -M -O csv', build('balances').command);
check('payees pivots by payee', build('payees').command === 'balance expenses --pivot payee -M -O csv', build('payees').command);
check('shares is a single column, for a doughnut', build('shares').command === 'balance expenses -O csv', build('shares').command);
check('and says it wants shares drawn', build('shares').kind === 'shares', JSON.stringify(build('shares').kind));
check('top is a ranking, so no months', build('top').command === 'balance expenses -O csv', build('top').command);
check('a preset account can be named', build('shares income').command === 'balance income -O csv', build('shares income').command);
check('a period the caller named is not overridden',
  build('spending -p 2024').command === 'balance expenses -M -p 2024 -O csv', build('spending -p 2024').command);
check('an account is charted over months', build('expenses:food').command === 'balance expenses:food -M -O csv', build('expenses:food').command);
check('a report command is passed through whole',
  build('balance assets -M').command === 'balance assets -M -O csv', build('balance assets -M').command);
check('a format the caller chose is left alone',
  build('balance assets -O json').command === 'balance assets -O json', build('balance assets -O json').command);

// ------------------------------------------------------------------ reading hledger

check('a monthly report is periods and series', report.periods.length === 3 && report.series.length === 3,
  JSON.stringify({ periods: report.periods.length, series: report.series.length }));
check('the Total row is not a series', !report.series.some((series) => /total/i.test(series.label)), '');
check('the commodity is taken from an amount that has one', report.unit.prefix === '$', JSON.stringify(report.unit));
check('amounts keep their value', report.series[1].amounts[2].value === 1286.4, String(report.series[1].amounts[2].value));
check('a statement finds its header under the title',
  read(STATEMENT_CSV).periods[0] === '2024-02-03', read(STATEMENT_CSV).periods.join(','));
check('and skips its section rows', read(STATEMENT_CSV).series.length === 2, String(read(STATEMENT_CSV).series.length));
check('a European decimal mark is read', money('1.234,56 EUR').value === 1234.56, JSON.stringify(money('1.234,56 EUR')));
check('a negative amount keeps its sign and loses it from the prefix',
  money('-$12.00').value === -12 && money('-$12.00').prefix === '$', JSON.stringify(money('-$12.00')));
check('an empty cell is recognisable as empty', money('').raw === '' && money('0').raw === '0', '');
check('nothing to read is null', read('') === null && read('"account","x"\n') === null, '');

// ------------------------------------------------------------------ which chart

check('several periods is a line', typeFor(report) === 'line', typeFor(report));
check('one period is a ranking', typeFor(ranking) === 'bar', typeFor(ranking));
check('and shares is a doughnut', typeFor(ranking, 'shares') === 'doughnut', typeFor(ranking, 'shares'));
check('the subtitle counts periods when there are several',
  headline(report, 'line') === '3 periods, 2024-01 to 2024-03', headline(report, 'line'));
check('and accounts when there is one', headline(ranking, 'bar').startsWith('3 accounts'), headline(ranking, 'bar'));

// ------------------------------------------------------------------ the model the charts draw

{
  const model = modelFor({ report, colors: COLORS, title: 'spending' });
  const series = (label) => model.series.find((entry) => entry.label === label);
  check('a monthly report is a line chart', model.type === 'line', model.type);
  check('with one line per series', model.series.length === 3, String(model.series.length));
  check('labelled by period', model.periods.join(',') === '2024-01,2024-02,2024-03', model.periods.join(','));
  check('biggest first, so the legend reads in order of size',
    model.series[0].label === 'expenses:housing:rent', model.series[0].label);
  check('and the values are the amounts',
    series('expenses:housing:rent').values.join(',') === '1200,1237.5,1286.4',
    series('expenses:housing:rent').values.join(','));
  check('each series has its own colour', new Set(model.series.map((entry) => entry.colour)).size === 3, '');
  check('the tooltip writes an amount the way a person does',
    pointText('rent', 1286.4, model.unit) === 'rent: $1,286.40', pointText('rent', 1286.4, model.unit));
  check('several lines are not filled, so none hides another', model.fill === false, '');
  check('and a click on one opens it', accountAt(model, { series: 0 }) === 'expenses:housing:rent',
    String(accountAt(model, { series: 0 })));
}

{
  const model = modelFor({ report, colors: COLORS, title: 'net worth', options: { total: true, label: 'net worth' } });
  check('a running total is one line, not one per account', model.series.length === 1, String(model.series.length));
  check('filled, because there is nothing to compare it with', model.fill === true, '');
  check('and not something to drill into, since it is not an account', accountAt(model, { series: 0 }) === null,
    String(accountAt(model, { series: 0 })));
}

{
  const model = modelFor({ report, colors: COLORS, title: 'by category', kind: 'stacked' });
  check('a stacked report is a stacked area', model.type === 'stacked', model.type);
  check('whose layers are not filled as one line', model.fill === false, '');
  check('one period of it is a ranking, since there is nothing to stack over',
    typeFor(ranking, 'stacked') === 'bar', typeFor(ranking, 'stacked'));
}

{
  const model = modelFor({ report: ranking, colors: COLORS, title: 'top' });
  check('a ranking is a bar chart', model.type === 'bar', model.type);
  check('largest first', model.rows[0].label === 'expenses:housing:rent', model.rows[0].label);
  check('in the accent colour, since every bar is labelled', model.rows.every((row) => row.colour === COLORS.accent), '');
  check('and each bar knows its share', model.rows[0].shareText === '90.8%', model.rows[0].shareText);
  check('which the tooltip says', shareText(1200, model.total, model.unit) === '$1,200.00 (90.8%)',
    shareText(1200, model.total, model.unit));
}

{
  const model = modelFor({ report: ranking, colors: COLORS, title: 'shares', kind: 'shares' });
  check('shares is a doughnut', model.type === 'doughnut', model.type);
  check('one slice per account', model.rows.length === 3, String(model.rows.length));
  check('slices are separate colours', new Set(model.rows.map((row) => row.colour)).size === 3, '');
  check('and a slice knows its share', model.rows[0].shareText === '90.8%', model.rows[0].shareText);
  const signed = read('"account","balance"\n"a","$10"\n"b","$-5"\n"c","$30"\n');
  check('a negative balance is not a slice', modelFor({ report: signed, colors: COLORS, title: 'x', kind: 'shares' }).rows.length === 2, '');
}

check('a series colour comes from the theme, and they are all different',
  new Set(palette(COLORS, 5)).size === 5 && palette(COLORS, 1)[0].startsWith('hsl('), palette(COLORS, 3).join(' '));
check('a sliver of a share is not rounded to nothing', percent(0.01, 1000) === '<0.1%' && percent(25, 100) === '25.0%',
  `${percent(0.01, 1000)} ${percent(25, 100)}`);
check('an axis label is short: $1,200, $12.5k, $1.5M',
  tick(1200, { prefix: '$', suffix: '' }) === '$1,200' && tick(12500, { prefix: '$', suffix: '' }) === '$12.5k'
  && tick(20000, { prefix: '$', suffix: '' }) === '$20k' && tick(1.5e6, { prefix: '$', suffix: '' }) === '$1.5M'
  && tick(-2500, { prefix: '$', suffix: '' }) === '-$2,500' && tick(100, { prefix: '', suffix: 'EUR' }) === '100 EUR',
  [1200, 12500, 20000, 1.5e6, -2500].map((value) => tick(value, { prefix: '$', suffix: '' })).join(' '));

// ------------------------------------------------------------------ clicking a mark

{
  const model = modelFor({ report: ranking, colors: COLORS, title: 'top' });
  check('a click on a bar names that account', accountAt(model, { row: 0 }) === 'expenses:housing:rent',
    String(accountAt(model, { row: 0 })));
}
{
  const many = {
    periods: ['p1', 'p2'],
    unit: { prefix: '$', suffix: '' },
    series: Array.from({ length: 10 }, (_, index) => ({
      label: `s${index}`,
      amounts: [money(`$${index + 1}`), money(`$${index + 1}`)],
    })),
  };
  const model = modelFor({ report: many, colors: COLORS, title: 'many' });
  check('more series than fit are added up as other', model.series.length === 7, String(model.series.length));
  check('the biggest are the ones kept and the rest are summed',
    model.series[0].label === 's9' && model.series[6].label === 'other (4)',
    model.series.map((entry) => entry.label).join(', '));
  check('and other is not something to drill into', accountAt(model, { series: 6 }) === null,
    String(accountAt(model, { series: 6 })));
  check('a click on nothing is nothing', accountAt(model, undefined) === null, '');
}

// ------------------------------------------------------------------ what the window shows

{
  const line = viewOf({ report, colors: COLORS, title: 'spending', kind: null });
  check('a line chart has a legend, one entry per series', line.draw === 'line' && line.items.length === 3,
    `${line.draw} ${line.items && line.items.length}`);
  const bar = viewOf({ report: ranking, colors: COLORS, title: 'top', kind: null });
  check('a ranking has none, since its bars are labelled', bar.draw === 'bar' && bar.items === null, String(bar.items));
  check('and grows with its rows rather than squeezing them',
    heightFor('bar', { rows: new Array(20).fill({}) }) > heightFor('bar', { rows: new Array(3).fill({}) }), '');
}

check('the keys are the ones the footer lists',
  keyFor({ key: 'Escape' }) === 'back' && keyFor({ key: 'ArrowLeft' }) === 'previous'
  && keyFor({ key: 'ArrowRight' }) === 'next' && keyFor({ key: '+' }) === 'zoom-in'
  && keyFor({ key: '-' }) === 'zoom-out' && keyFor({ key: '0' }) === 'reset'
  && keyFor({ key: 's' }) === 'save-svg' && keyFor({ key: 'p' }) === 'save-png'
  && KEYS.every(([key]) => keysLine().includes(key)), keysLine());
check('and a key with a modifier is left to the browser',
  keyFor({ key: 's', ctrlKey: true }) === null && keyFor({ key: 'p', metaKey: true }) === null && keyFor({ key: 'a' }) === null, '');

{
  const items = Array.from({ length: 9 }, (_, index) => ({ label: `expenses:category:${index}`, colour: '#000000' }));
  const top = header({ width: 420, title: 'spending', subtitle: '3 periods', items });
  check('a saved picture carries its title and subtitle',
    top.lines[0].text === 'spending' && top.lines[1].text === '3 periods', JSON.stringify(top.lines));
  check('and a legend that wraps rather than running off the edge',
    new Set(top.entries.map((entry) => entry.y)).size > 1
    && top.entries.every((entry) => entry.x === 20 || entry.x + entry.label.length * 6.4 + 18 <= 420 - 20),
    JSON.stringify(top.entries.map((entry) => [entry.x, entry.y])));
  check('a chart of one series needs no legend in the picture',
    header({ width: 420, title: 't', items: items.slice(0, 1) }).entries.length === 0, '');
  check('the file is named after the chart',
    fileName('Where the money went', 'svg') === 'hledger-where-the-money-went.svg' && fileName('', 'png') === 'hledger-chart.png',
    fileName('Where the money went', 'svg'));
}

check('the numbers are a table, with a row per period',
  (tableView(report).match(/<tr>/g) || []).length === 4, String((tableView(report).match(/<tr>/g) || []).length));
check('thousands are grouped', group(1234567.891) === '1,234,567.89', group(1234567.891));
check('an amount is written as a person writes it', format(money('-$1234.56')) === '-$1,234.56', format(money('-$1234.56')));

// ------------------------------------------------------------------ the page

{
  const html = page({
    report,
    colors: COLORS,
    title: 'spending',
    command: 'balance expenses -M -O csv',
    token: 'token-1',
    kind: null,
    module: '/plugins/chart-window.js',
    scripts: ['/plugins/vendor/d3/d3.min.js'],
  });
  // The whole point of this round: the chart is the chart.
  check('the window has no buttons', !html.includes('<button'), '');
  check('no fields', !html.includes('<input') && !html.includes('<select'), '');
  check('and nothing hidden behind a disclosure', !html.includes('<details'), '');
  check('it has an svg to draw on', html.includes('<svg class="chart" id="chart"') && !html.includes('<canvas'), '');
  check('it loads D3, and only D3', html.includes('/plugins/vendor/d3/d3.min.js')
    && !/chart\.umd|hammer|chartjs-plugin-zoom/.test(html), '');
  check('a legend has somewhere to go', html.includes('id="legend"'), '');
  check('and the keys are written under the chart', html.includes(keysLine()), '');
  check('and then the module that mounts it', html.includes('chart-window.js') && html.includes('mount()'), '');
  check('the numbers are in the page already, not left to a script', html.includes('<table') && html.includes('2024-02'), '');
  check('with the heading and the range above them', html.includes('spending') && html.includes('3 periods'), '');
  check('and the command that produced it', html.includes('balance expenses -M -O csv'), '');
  check('the data carries the token and the colours', html.includes('token-1') && html.includes(COLORS.accent), '');
  check('and the theme is declared to the browser', html.includes('color-scheme: light'), '');
  check('it escapes anything that could close a script element',
    !page({
      report: { ...report, series: [{ label: '</script><script>', amounts: report.series[0].amounts }] },
      colors: COLORS, title: 'x', command: 'c', token: 't', module: 'm',
    }).includes('</script><script>'), '');
}

// ------------------------------------------------------------------ running the plugin

/**
 * A host that records what the plugin did, in the order it did it.
 *
 * The plugin writes a page and registers a bridge; both are per run, and the bridge is what a
 * window asks through, so a stub keeps them.
 */
function stub(overrides = {}) {
  const log = { said: [], pages: [], asked: [], events: [] };
  const host = {
    name: 'chart',
    colors: () => COLORS,
    setting: () => null,
    say: (text) => log.said.push(text),
    remember: (key, value) => log.said.push(`remember ${key}=${value}`),
    window: (title) => {
      log.events.push('window');
      log.title = title;
      return { write: (html) => log.pages.push(html), close() {} };
    },
    hledger: async (command) => {
      log.events.push('hledger');
      log.asked.push(command);
      return MONTHLY_CSV;
    },
    ...overrides,
  };
  return { host, log, last: () => log.pages[log.pages.length - 1] || '' };
}

{
  const { host, log, last } = stub();
  await Chart.run('', host);
  check('it opens the window before asking hledger', log.events[0] === 'window' && log.events.includes('hledger'), log.events.join(','));
  check('it shows something while it waits', log.pages[0].includes('Reading hledger'), '');
  check('it titles the window after what it is charting', log.title === 'hledger: expenses', log.title);
  check('it registers a bridge for a click to ask through', typeof globalThis.__chartBridges === 'object', '');
  check('it remembers the account', log.said.includes('remember account=expenses'), JSON.stringify(log.said));
  check('and says what it drew', log.said.some((line) => line.includes('3 periods of expenses') && line.includes('$1,286.40')), JSON.stringify(log.said));
  check('the page it wrote is the chart', last().includes('<svg class="chart"') && !last().includes('<button'), '');
  check('and it loads D3 from beside the plugin', last().includes('vendor/d3/d3.min.js') && !last().includes('chart.umd'), '');
}

{
  // The plugin's half of a drill-down: the bridge a window calls with an account, which asks
  // hledger again and hands back a report the window can draw.
  const { host, log } = stub();
  await Chart.run('top', host);
  const token = /"token":"([^"]+)"/.exec(log.pages[log.pages.length - 1])[1];
  const bridge = globalThis.__chartBridges[token];
  const answer = await bridge.requery('expenses:housing:rent');
  check('a window\'s drill-down asks hledger for that account, month by month',
    log.asked[log.asked.length - 1] === 'balance expenses:housing:rent -M -O csv', log.asked.join(' | '));
  check('and gets back a report it can draw, titled after the account',
    answer.title === 'expenses:housing:rent' && answer.report.periods.length === 3 && answer.command.endsWith('-O csv'),
    JSON.stringify({ title: answer.title, command: answer.command }));
  const sankey = await bridge.requery('sankey');
  check('a drill-down into a question is parsed the way that question is', sankey.kind === 'sankey' && 'sinks' in sankey.report,
    String(sankey.kind));
  host.hledger = async () => '"account","2024-01"\n';
  let refused = '';
  try {
    await bridge.requery('expenses:nothing');
  } catch (error) {
    refused = error.message;
  }
  check('and an account with nothing in it is an error the window can show', /nothing to chart for expenses:nothing/.test(refused), refused);
}

{
  const { host, log } = stub({ hledger: async () => RANKING_CSV });
  await Chart.run('top', host);
  check('a ranking is summed up by its largest account',
    log.said.some((line) => line.includes('3 accounts, $1,200.00 in expenses:housing:rent')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ hledger: async () => { throw new Error('<bad> & worse'); } });
  await Chart.run('spending', host);
  check('a message is escaped before it is written into the window',
    log.pages[log.pages.length - 1].includes('&lt;bad&gt; &amp; worse'), log.pages[log.pages.length - 1]);
}

{
  const { host, log } = stub({ hledger: async () => { throw new Error('no journal is loaded'); } });
  await Chart.run('spending', host);
  check('a failed run is on the page', log.pages[log.pages.length - 1].includes('no journal is loaded'), '');
  check('and in the terminal', log.said.some((line) => line.includes('no journal is loaded')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ hledger: async () => '"account","2024-01"\n' });
  await Chart.run('spending', host);
  check('an empty report is reported, not charted', log.said.some((line) => line.includes('no amounts')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ window: () => null });
  await Chart.run('spending', host);
  check('a blocked window is reported', log.said.some((line) => line.includes('blocked')), JSON.stringify(log.said));
}

{
  const { host, log } = stub();
  await Chart.run('register -p 2024', host);
  check('a report no chart can draw is refused, and says what to ask instead',
    log.events.length === 0 && log.said.some((line) => /register is not a report a chart can draw; try chart calendar/.test(line)),
    JSON.stringify(log))
}

{
  const { host, log } = stub({ hledger: async () => '"account","balance"\n"Total:","0"\n' });
  await Chart.run('spendng', host);
  check('a near miss of a question is answered with the question it was probably meant to be',
    log.said.some((line) => line.includes('Did you mean chart spending?')), JSON.stringify(log.said));
}

check('only a near miss is a near miss',
  closestQuestion('incme') === 'income' && closestQuestion('sankee') === 'sankey'
  && closestQuestion('expenses:fod') === null && closestQuestion('groceries') === null
  && closestQuestion('top') === null && closestQuestion('') === null,
  ['incme', 'sankee', 'expenses:fod', 'groceries'].map((word) => `${word}=${closestQuestion(word)}`).join(' '));
check('balance statements are reports a chart can draw',
  build('bs').command === 'bs -O csv' && build('cf -p 2024').command === 'cf -p 2024 -O csv' && !build('bs').refusal,
  `${build('bs').command} ${build('cf -p 2024').command}`);

{
  const { host, last } = stub({ colors: undefined });
  await Chart.run('spending', host);
  check('a host without colors() still gets a readable page', last().includes('#000000') && last().includes('<svg class="chart"'), '');
}

// ------------------------------------------------------------------ the edit plugin

/** A host with loaded files, recording what the edit plugin did with them. */
function editHost({ files, contents = {}, save, window: open } = {}) {
  const log = { said: [], pages: [], saved: [] };
  const host = {
    name: 'edit',
    colors: () => COLORS,
    say: (text) => log.said.push(text),
    files: () => files,
    read: (path) => (path in contents ? contents[path] : null),
    save: save || (async (path, text) => { log.saved.push([path, text]); return { ok: true }; }),
    window: open || ((title) => {
      log.title = title;
      return { write: (html) => log.pages.push(html), close() {} };
    }),
  };
  return { host, log, last: () => log.pages[log.pages.length - 1] || '' };
}

const FILES = [
  { path: 'prices.journal', writable: true, main: false },
  { path: 'hledger.journal', writable: true, main: true },
  { path: 'uploaded.journal', writable: false, main: false },
];
const CONTENTS = { 'hledger.journal': '2024-01-01 opening\n', 'uploaded.journal': '; </script> & more\n', 'prices.journal': 'P 2024-01-01 EUR $1.10\n' };

{
  const { host, log, last } = editHost({ files: FILES, contents: CONTENTS });
  await Edit.run('', host);
  check('edit alone opens the journal hledger is reading, not the first file',
    log.title === 'hledger: hledger.journal' && last().includes('hledger.journal'), log.title);
  check('and says so, in terminal text', log.said.some((line) => line === 'edit: hledger.journal in a new window.')
    && !log.said.some((line) => /[`\u2014]/.test(line)), JSON.stringify(log.said));
  check('the page loads Ace from beside the plugin, and the file travels in the page',
    last().includes('vendor/ace/ace.js') && last().includes('2024-01-01 opening'), '');
  check('a writable file says how to save it', last().includes('Ctrl+S or Cmd+S saves it to disk'), '');

  const token = /"token":"([^"]+)"/.exec(last())[1];
  await globalThis.__editBridges[token].save('changed\n');
  check('the window saves through the plugin, to the file it opened',
    JSON.stringify(log.saved) === JSON.stringify([['hledger.journal', 'changed\n']]), JSON.stringify(log.saved));
}

{
  const { host, log, last } = editHost({ files: FILES, contents: CONTENTS });
  await Edit.run('uploaded.journal', host);
  check('a named file opens, and one from an upload is read-only, and says why',
    log.said.some((line) => line === 'edit: uploaded.journal in a new window, read-only.')
    && last().includes('read-only: this file came from an upload'), JSON.stringify(log.said));
  check('its contents cannot close the script they travel in',
    !last().includes('; </script>') && last().includes('\\u003c/script>'), '');
}

{
  const refusing = editHost({ files: FILES, contents: CONTENTS, save: async () => ({ error: 'it changed on disk since it was opened' }) });
  await Edit.run('', refusing.host);
  const token = /"token":"([^"]+)"/.exec(refusing.last())[1];
  let refused = '';
  try {
    await globalThis.__editBridges[token].save('x');
  } catch (error) {
    refused = error.message;
  }
  check('a save the app refuses is an error the window can show', refused === 'it changed on disk since it was opened', refused);
}

{
  const { host, log } = editHost({ files: FILES, contents: CONTENTS });
  await Edit.run('missing.journal', host);
  check('a file that is not loaded is named, with the ones that are',
    log.said[0] === 'edit: missing.journal is not loaded. Loaded: prices.journal, hledger.journal, uploaded.journal.' && log.pages.length === 0,
    log.said[0]);
  const empty = editHost({ files: [] });
  await Edit.run('', empty.host);
  check('with nothing loaded, it says what to do, in terminal text',
    empty.log.said[0] === 'edit: nothing is loaded. Run open or upload first.', empty.log.said[0]);
  const blocked = editHost({ files: FILES, contents: CONTENTS, window: () => null });
  await Edit.run('', blocked.host);
  check('a blocked window is reported', /blocked the window for hledger.journal/.test(blocked.log.said[0]), blocked.log.said[0]);
  const unreadable = editHost({ files: FILES, contents: {} });
  await Edit.run('', unreadable.host);
  check('a file that cannot be read says so, in the window and the terminal',
    unreadable.last().includes('could not be read') && /could not be read/.test(unreadable.log.said[0]), unreadable.log.said[0]);
}

{
  const html = editPage({ path: 'a&b.journal', contents: 'x', writable: true, colors: COLORS, token: 't', module: 'm', scripts: [] });
  check('the editor page escapes the file name and follows the theme',
    html.includes('a&amp;b.journal') && html.includes('color-scheme: light') && html.includes(COLORS.background), '');
}

// ------------------------------------------------------------------ what every window shares

check('escape makes text safe in HTML and in an attribute', escape('<a href="x">&</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;', escape('<a href="x">&</a>'));
check('light and dark are told apart by the same measure as the app',
  isLight('#fbf1c7') && !isLight('#000000') && !isLight('not a colour'), '');
check('a colour mixed into another goes the right way and the right distance',
  mix('#000000', '#ffffff', 50) === '#808080' && mix('#000000', '#ffffff', 0) === '#000000' && mix('#102030', '#102030', 30) === '#102030',
  mix('#000000', '#ffffff', 50));
check('a host without colors gets the built-in theme', colorsOf({}) === FALLBACK_COLORS && colorsOf({ colors: () => COLORS }) === COLORS, '');
check('the waiting page is the theme, with its title escaped',
  shell(COLORS, '<x>', 'Reading hledger…').includes('&lt;x&gt;') && shell(COLORS, 't', 'm').includes(COLORS.background), '');
check('a file beside the plugins is an absolute URL', /^file:\/\/.*\/assets\/plugins\/vendor\/d3\/d3\.min\.js$/.test(beside('vendor/d3/d3.min.js')), beside('vendor/d3/d3.min.js'));
{
  const first = bridge('__checkBridges', 'check', { a: 1 });
  const second = bridge('__checkBridges', 'check', { a: 2 });
  check('every bridge gets a token of its own, and keeps its api under it',
    first !== second && globalThis.__checkBridges[first].a === 1 && globalThis.__checkBridges[second].a === 2, `${first} ${second}`);
}

// ------------------------------------------------------------------ the repository itself

const manifest = JSON.parse(
  await readFile(new URL('../assets/plugins/plugins.json', import.meta.url), 'utf8'),
);
const themeNames = (manifest.themes || []).map((theme) => theme.name);
check('the bundled manifest offers gruvbox dark and light',
  themeNames.includes('gruvbox') && themeNames.includes('gruvbox-light'), themeNames.join(', '));
const colours = (manifest.themes || []).flatMap((theme) => Object.entries(theme.colors || {}));
check('every colour it declares is a hex colour',
  colours.length > 0 && colours.every(([, value]) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)),
  colours.map(([role, value]) => `${role}=${value}`).join(' '));
const roles = new Set(colours.map(([role]) => role));
check('and every role is one the app knows',
  [...roles].every((role) => ['background', 'foreground', 'cursor', 'accent', 'dim'].includes(role)),
  [...roles].join(', '));

// WCAG AA, so a theme offered to other people is actually readable rather than merely
// pretty on the author's monitor. The Rust side holds the built-in theme to this too.
const luminance = (hex) => {
  const digits = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((at) => {
    let value = parseInt(digits.slice(at, at + 2), 16) / 255;
    value = value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return value;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (one, other) => {
  const [a, b] = [luminance(one), luminance(other)];
  const [hi, lo] = [Math.max(a, b), Math.min(a, b)];
  return (hi + 0.05) / (lo + 0.05);
};
const unreadable = (manifest.themes || []).flatMap((theme) =>
  ['foreground', 'dim', 'accent', 'cursor']
    .filter((role) => theme.colors[role] && contrast(theme.colors[role], theme.colors.background) < 4.5)
    .map((role) => `${theme.name}.${role}=${contrast(theme.colors[role], theme.colors.background).toFixed(2)}`));
check('every theme role is readable (WCAG AA, 4.5:1)', unreadable.length === 0, unreadable.join(', '));

// ------------------------------------------------------------------ the shaped charts

const register = readRegister(REGISTER_CSV);
check('the register parser finds its header and its rows', register && register.postings.length === 8);
check('an amount written $-2200.00 is negative, not positive',
  money('$-2200.00').value === -2200 && money('$1,234.56').value === 1234.56,
  `${money('$-2200.00').value}`);

const days = byDay(register);
check('the calendar sums expenses per day, and only expenses',
  days.days.length === 3 && days.days[0].date === '2024-01-05' && days.days[0].value === 600
  && Math.abs(days.total - 698.90) < 0.005,
  JSON.stringify(days.days));

const falls = waterfall(register);
check('the waterfall is income, expense categories and net',
  falls.income === 2200 && Math.abs(falls.spent - 698.90) < 0.005
  && Math.abs(falls.net - 1501.10) < 0.005,
  JSON.stringify(falls));
check('no asset transfer counts as income or expense',
  falls.steps.length === 4 && !falls.steps.some((step) => /bank|checking/.test(step.label)),
  JSON.stringify(falls.steps));

const tree = readTree(TREE_CSV);
check('the tree parser reads indentation as depth',
  tree && tree.rows.length === 5 && tree.rows[1].depth === 1 && tree.rows[2].depth === 2
  && Math.abs(tree.total - 698.90) < 0.005,
  JSON.stringify(tree && tree.rows));
check('a chain written in one row becomes a chain of nodes', tree.rows[4].label === 'housing:rent');
check('indentation in plain spaces is read the same way',
  readTree(TREE_CSV.replaceAll(NBSP, ' ')).rows.map((row) => row.depth).join() === tree.rows.map((row) => row.depth).join(),
  readTree(TREE_CSV.replaceAll(NBSP, ' ')).rows.map((row) => row.depth).join());

const monthly = read(MONTHLY_CSV);
const spark = multiples(monthly);
check('the sparklines take the largest accounts and keep the periods',
  spark.rows.length === Math.min(monthly.series.length, 8)
  && spark.periods.length === monthly.periods.length);

check('a kind picks its parser',
  parseReport('treemap', TREE_CSV).rows.length === 5
  && parseReport('calendar', REGISTER_CSV).days.length === 3
  && parseReport('line', MONTHLY_CSV).periods.length === 3);

check('the new presets ask for the report their shape needs',
  build('treemap').command === 'balance --tree expenses -O csv'
  && build('calendar -p 2024').command === 'register -p 2024 -O csv'
  && build('waterfall').command === 'register -O csv'
  && build('multiples').command === 'balance -M -O csv',
  [build('treemap').command, build('calendar -p 2024').command, build('multiples').command].join(' | '));
check('a named account still overrides a preset that takes one',
  build('treemap assets').command === 'balance --tree assets -O csv'
  && build('treemap assets').title === 'assets, as a treemap',
  build('treemap assets').title);
check('stacked asks for one level of categories below the account',
  build('stacked').command === 'balance expenses -M --depth 2 -O csv'
  && build('stacked expenses:food').command === 'balance expenses:food -M --depth 3 -O csv'
  && build('stacked expenses:food').title === 'expenses:food by category',
  `${build('stacked').command} | ${build('stacked expenses:food').command} | ${build('stacked expenses:food').title}`);
check('the Sankey asks for income and expense categories, and a period passes through',
  build('sankey').command === 'balance income expenses --depth 2 -O csv'
  && build('sankey -p 2024').command === 'balance income expenses --depth 2 -p 2024 -O csv',
  build('sankey -p 2024').command);
check('five charts read a report of their own, and every other is a balance chart',
  CUSTOM.length === 5 && isCustom('sankey') && isCustom('treemap') && !isCustom('stacked') && !isCustom(null),
  CUSTOM.join(','));

const d3Page = page({
  report: tree,
  colors: COLORS,
  title: 'where the money went',
  command: 'balance --tree expenses -O csv',
  token: 't',
  kind: 'treemap',
  module: 'about:blank',
  scripts: ['https://example.invalid/d3.min.js'],
});
check('a shaped chart draws into an svg and keeps the table',
  d3Page.includes('<svg class="chart" id="chart"') && d3Page.includes('<table>')
  && !d3Page.includes('<canvas'));
check('and so does a balance chart',
  page({
    report: monthly, colors: COLORS, title: 'spending', command: 'balance expenses -M -O csv',
    token: 't', kind: null, module: 'about:blank', scripts: [],
  }).includes('<svg class="chart"'));
check('the treemap headline counts leaves, not parents',
  headlineFor('treemap', tree) === '3 accounts, $698.90 at the leaves',
  headlineFor('treemap', tree));
check('the waterfall headline reads like a sentence',
  headlineFor('waterfall', falls) === 'income $2,200.00, spent $698.90, net $1,501.10',
  headlineFor('waterfall', falls));
check('the treemap table carries every row',
  ['food', 'coffee', 'housing'].every((name) => tableFor('treemap', tree).includes(name)));

// ------------------------------------------------------------------ the Sankey

{
  const flow = flows(read(FLOWS_CSV));
  check('income is the source, turned the right way round',
    flow.sources.length === 1 && flow.sources[0].label === 'salary' && flow.sources[0].value === 3200,
    JSON.stringify(flow.sources));
  check('each expense category is a sink, largest first',
    flow.sinks.slice(0, 3).map((node) => node.label).join() === 'housing,food,reading', flow.sinks.map((node) => node.label).join());
  check('and what was not spent flows to saved',
    flow.sinks[3].kind === 'saved' && Math.abs(flow.sinks[3].value - 1866.11) < 0.005, JSON.stringify(flow.sinks[3]));
  check('so both sides add up to the income',
    Math.abs(flow.sinks.reduce((sum, node) => sum + node.value, 0) - 3200) < 0.005, '');
  check('the headline says where it went',
    headlineFor('sankey', flow) === 'income $3,200.00 into 3 categories, $1,866.11 saved', headlineFor('sankey', flow));
  check('and the table lists every flow',
    ['from salary', 'to housing', 'to reading', 'saved'].every((text) => tableFor('sankey', flow).includes(text)), '');
  check('a node opens its own account', flow.sinks[0].account === 'expenses:housing' && flow.sinks[3].account === null,
    `${flow.sinks[0].account} ${flow.sinks[3].account}`);

  const short = flows(read('"account","balance"\n"expenses:rent","$150"\n"income:job","$-100"\n"assets:bank","$-50"\n'));
  check('spending above income is drawn from savings, not hidden',
    short.sources.some((node) => node.kind === 'drawn' && node.value === 50) && !short.sinks.some((node) => node.kind === 'saved'),
    JSON.stringify(short.sources));
  check('and an asset row is neither a source nor a sink',
    ![...short.sources, ...short.sinks].some((node) => /assets/.test(node.account || '')), '');
  check('the headline says so', /\$50\.00 more spent than came in/.test(headlineFor('sankey', short)), headlineFor('sankey', short));

  const layout = sankeyLayout(flow, 800, 400, { left: 100, right: 100, top: 10, bottom: 10 });
  const hub = layout.nodes.find((node) => node.column === 1);
  const into = layout.links.filter((link) => link.to === 'income').reduce((sum, link) => sum + link.thickness, 0);
  const out = layout.links.filter((link) => link.from === 'income').reduce((sum, link) => sum + link.thickness, 0);
  check('every source and sink has one link through the middle',
    layout.links.length === flow.sources.length + flow.sinks.length, String(layout.links.length));
  check('what flows in is as thick as the middle, and so is what flows out',
    Math.abs(into - hub.h) < 1e-6 && Math.abs(out - hub.h) < 1e-6, `${into} ${out} ${hub.h}`);
  check('every node is drawn at the same scale',
    layout.nodes.every((node) => Math.abs(node.h / node.value - layout.scale) < 1e-9), '');
  check('and every node fits inside the chart',
    layout.nodes.every((node) => node.y >= 10 - 1e-6 && node.y + node.h <= 390 + 1e-6 && node.x >= 100 && node.x + node.w <= 700),
    JSON.stringify(layout.nodes.map((node) => [node.label, Math.round(node.y), Math.round(node.h)])));
  check('a link is a closed band', layout.links.every((link) => /^M.*C.*L.*C.*Z$/.test(link.path)), '');
  check('a parse of the report is the flow itself', parseReport('sankey', FLOWS_CSV).income === 3200, '');
}

let filesThere = true;
for (const file of [
  '../assets/plugins/chart.js',
  '../assets/plugins/chart-window.js',
  '../assets/plugins/chart-data.js',
  '../assets/plugins/chart-d3.js',
  '../assets/plugins/chart-ui.js',
  '../assets/plugins/window-kit.js',
  '../assets/plugins/vendor/d3/d3.min.js',
  '../assets/plugins/vendor/d3/LICENSE',
  '../assets/plugins/edit.js',
  '../assets/plugins/edit-window.js',
  '../assets/plugins/vendor/ace/ace.js',
]) {
  try {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    if (source.length < 100) filesThere = false;
  } catch {
    filesThere = false;
  }
}
check('every plugin names a module that exists, library included', filesThere, '');

const plugins = manifest.plugins || [];
const documented = plugins.filter((plugin) => plugin.usage && plugin.help && plugin.help.length > 40);
check('every bundled plugin documents itself for `<command>?`',
  plugins.length > 0 && documented.length === plugins.length,
  plugins.map((plugin) => `${plugin.name}:${plugin.usage ? 'usage' : 'no usage'}/${plugin.help ? 'help' : 'no help'}`).join(' '));

// The help page is written in the manifest and the questions in chart.js, so a question can be
// added to one and forgotten in the other. This is what keeps `chart?` complete.
{
  const chartEntry = plugins.find((plugin) => plugin.name === 'chart');
  const forms = (chartEntry.sections || []).flatMap((section) => section.rows.map(([form]) => form));
  const listed = (name) => forms.some((form) => form === `chart ${name}` || form.startsWith(`chart ${name} `))
    || (name === 'spending' && forms.includes('chart'));
  const aliases = new Set(['savings', 'nw', 'everything', 'area', 'sparklines', 'flows']);
  const missing = questions().filter((name) => !aliases.has(name) && !listed(name));
  check('chart? lists every question the plugin answers to', missing.length === 0, missing.join(', '));
  const rows = plugins.flatMap((plugin) => [...(plugin.sections || []).flatMap((section) => section.rows), ...(plugin.examples || [])]);
  check('every row on a help page is a form and what it does',
    rows.length > 0 && rows.every((row) => Array.isArray(row) && row.length === 2 && row.every((cell) => typeof cell === 'string' && cell.trim())),
    JSON.stringify(rows.filter((row) => !(Array.isArray(row) && row.length === 2))));
  check('and every example is a command the plugin builds without a refusal',
    (chartEntry.examples || []).every(([command]) => !build(command.replace(/^chart\s*/, '')).refusal), '');
  const text = JSON.stringify(plugins);
  check('nothing printed in the terminal has a backtick or an em dash', !/[`\u2014]/.test(text), '');
}

// ------------------------------------------------------------------ the verdict

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
