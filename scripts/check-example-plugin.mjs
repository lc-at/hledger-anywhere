// Checks the bundled chart plugin, its window, and the repository they ship in.
//
// The plugin is the worked example in docs/plugins.md and the only plugin most people will ever
// see, so it has to keep working. None of this needs a browser: the plugin's job is turning
// arguments into a command and a CSV into data, and the window's job is turning that data into a
// Chart.js config, and both are functions.
//
// What cannot be checked here is the drawing and the interacting — a real canvas, a tooltip, a
// wheel zoom, a click that asks hledger again. Those are verified in a browser.
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

import Chart, { build, money, read } from '../assets/plugins/chart.js';
import {
  accountAt,
  configFor,
  format,
  group,
  headline,
  page,
  palette,
  tableView,
  themeFor,
  typeFor,
} from '../assets/plugins/chart-window.js';

const MONTHLY_CSV = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses:food:coffee","0","$12.50","$0"',
  '"expenses:housing:rent","$1200.00","$1237.50","$1286.40"',
  '"expenses:reading:books","0","$0","$0"',
  '"Total:","$1200.00","$1250.00","$1286.40"',
  '',
].join('\n');

const RANKING_CSV = [
  '"account","balance"',
  '"expenses:housing:rent","$1,200.00"',
  '"expenses:food:groceries","$86.40"',
  '"expenses:reading:books","$34.99"',
  '"Total:","$1,321.39"',
  '',
].join('\n');

/** A statement: a title above the header, and section rows with no amounts. */
const STATEMENT_CSV = [
  '"Balance Sheet 2024-02-03",""',
  '"Account","2024-02-03"',
  '"Assets",""',
  '"assets:bank:checking","$4,278.61"',
  '"assets:cash","$107.50"',
  '"Liabilities",""',
  '"Total:","$4,386.11"',
  '',
].join('\n');

const COLORS = {
  background: '#fbf1c7',
  foreground: '#3c3836',
  cursor: '#af3a03',
  accent: '#b57614',
  dim: '#7c6f64',
};

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

// ------------------------------------------------------------------ the Chart.js config

{
  const config = configFor({ report, colors: COLORS, title: 'spending' });
  const dataset = (label) => config.data.datasets.find((entry) => entry.label === label);
  check('a line chart is a line chart', config.type === 'line', config.type);
  check('with one dataset per series', config.data.datasets.length === 3, String(config.data.datasets.length));
  check('labelled by period', config.data.labels.join(',') === '2024-01,2024-02,2024-03', config.data.labels.join(','));
  check('biggest first, so the legend reads in order of size',
    config.data.datasets[0].label === 'expenses:housing:rent', config.data.datasets[0].label);
  check('and the values are the amounts',
    dataset('expenses:housing:rent').data.join(',') === '1200,1237.5,1286.4',
    dataset('expenses:housing:rent').data.join(','));
  check('each series has its own colour',
    new Set(config.data.datasets.map((dataset) => dataset.borderColor)).size === 3, '');
  check('the tooltip writes an amount the way a person does',
    config.options.plugins.tooltip.callbacks.label({ dataset: { label: 'rent' }, parsed: { y: 1286.4 } }) === ' rent: $1,286.40',
    config.options.plugins.tooltip.callbacks.label({ dataset: { label: 'rent' }, parsed: { y: 1286.4 } }));
  check('the legend is the library\'s, and is left switched on',
    config.options.plugins.legend.display !== false && config.options.plugins.legend.labels.usePointStyle === true, '');
  check('zoom and pan are on',
    config.options.plugins.zoom.zoom.wheel.enabled === true && config.options.plugins.zoom.pan.enabled === true, '');
  check('the axis labels are themed', config.options.scales.x.ticks.color === COLORS.dim, '');
}

{
  const config = configFor({ report, colors: COLORS, title: 'net worth', options: { total: true, label: 'net worth' } });
  check('a running total is one line, not one per account', config.data.datasets.length === 1, String(config.data.datasets.length));
  check('filled, because there is nothing to compare it with', config.data.datasets[0].fill === true, '');
}

{
  const config = configFor({ report: ranking, colors: COLORS, title: 'top' });
  check('a ranking is a bar chart', config.type === 'bar', config.type);
  check('drawn horizontally', config.options.indexAxis === 'y', config.options.indexAxis);
  check('largest first', config.data.labels[0] === 'expenses:housing:rent', config.data.labels[0]);
  check('with no legend, since the bars are labelled', config.options.plugins.legend.display === false, '');
  check('and the tooltip gives the share',
    config.options.plugins.tooltip.callbacks.label({ parsed: { x: 1200 } }).includes('90.8%'),
    config.options.plugins.tooltip.callbacks.label({ parsed: { x: 1200 } }));
}

{
  const config = configFor({ report: ranking, colors: COLORS, title: 'shares', kind: 'shares' });
  check('shares is a doughnut', config.type === 'doughnut', config.type);
  check('one slice per account', config.data.datasets[0].data.length === 3, String(config.data.datasets[0].data.length));
  check('slices are separate colours',
    new Set(config.data.datasets[0].backgroundColor).size === 3, '');
  check('and the tooltip gives the share',
    config.options.plugins.tooltip.callbacks.label({ parsed: 1200 }).includes('90.8%'),
    config.options.plugins.tooltip.callbacks.label({ parsed: 1200 }));
}

check('a series colour comes from the theme, and they are all different',
  new Set(palette(COLORS, 5)).size === 5 && palette(COLORS, 1)[0].startsWith('hsl('), palette(COLORS, 3).join(' '));
check('the theme reaches the tooltip and the grid',
  themeFor(COLORS).plugins.tooltip.backgroundColor === COLORS.foreground && themeFor(COLORS).scales.y.grid.color.startsWith(COLORS.dim),
  themeFor(COLORS).scales.y.grid.color);

// ------------------------------------------------------------------ clicking a point

{
  const config = configFor({ report: ranking, colors: COLORS, title: 'top' });
  check('a click on a bar names that account', accountAt(config, { datasetIndex: 0, index: 0 }) === 'expenses:housing:rent',
    accountAt(config, { datasetIndex: 0, index: 0 }));
}
{
  const config = configFor({ report, colors: COLORS, title: 'spending' });
  const index = config.data.datasets.findIndex((dataset) => dataset.label === 'expenses:food:coffee');
  check('a click on a line names that series', accountAt(config, { datasetIndex: index, index: 0 }) === 'expenses:food:coffee',
    accountAt(config, { datasetIndex: index, index: 0 }));
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
  const config = configFor({ report: many, colors: COLORS, title: 'many' });
  check('more series than fit are added up as other', config.data.datasets.length === 7, String(config.data.datasets.length));
  check('the biggest are the ones kept and the rest are summed',
    config.data.datasets[0].label === 's9' && config.data.datasets[6].label === 'other (4)',
    config.data.datasets.map((dataset) => dataset.label).join(', '));
  check('and other is not something to drill into', accountAt(config, { datasetIndex: 6, index: 0 }) === null,
    String(accountAt(config, { datasetIndex: 6, index: 0 })));
  check('a click on nothing is nothing', accountAt(config, undefined) === null, '');
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
    scripts: ['/plugins/vendor/chart.umd.js', '/plugins/vendor/hammer.min.js', '/plugins/vendor/chartjs-plugin-zoom.umd.js'],
  });
  // The whole point of this round: the chart is the chart.
  check('the window has no buttons', !html.includes('<button'), '');
  check('no fields', !html.includes('<input') && !html.includes('<select'), '');
  check('and nothing hidden behind a disclosure', !html.includes('<details'), '');
  check('it has a canvas to draw on', html.includes('<canvas id="chart"'), '');
  check('it loads the charting library', html.includes('/plugins/vendor/chart.umd.js'), '');
  check('and the zoom plugin, and what that needs',
    html.includes('/plugins/vendor/chartjs-plugin-zoom.umd.js') && html.includes('/plugins/vendor/hammer.min.js'), '');
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
  check('the page it wrote is the chart', last().includes('<canvas') && !last().includes('<button'), '');
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
  const { host, last } = stub({ colors: undefined });
  await Chart.run('spending', host);
  check('a host without colors() still gets a readable page', last().includes('#000000') && last().includes('<canvas'), '');
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
let filesThere = true;
for (const file of [
  '../assets/plugins/chart.js',
  '../assets/plugins/chart-window.js',
  '../assets/plugins/vendor/chart.umd.js',
  '../assets/plugins/vendor/hammer.min.js',
  '../assets/plugins/vendor/chartjs-plugin-zoom.umd.js',
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

// ------------------------------------------------------------------ the verdict

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
