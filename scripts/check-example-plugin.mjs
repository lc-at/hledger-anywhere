// Checks the bundled chart plugin, its window, and the repository they ship in.
//
// The plugin is the worked example in docs/plugins.md and the only plugin most people will
// ever see, so it has to keep working. None of this needs a browser: the plugin's job is
// turning arguments into a command and a CSV into data, and the renderer's job is turning data
// into markup, and both are functions.
//
// What cannot be checked here is the interacting: clicking a type, dragging a range, drilling
// into a series. That is `mount`, and it is verified in the browser.
//
// The CSVs below are copied from the shipped engine, not invented:
//
//   hledger balance expenses -M -O csv
//   "account","2024-01","2024-02","2024-03"
//   "expenses:food:coffee","0","$12.50","$0"
//   ...
//   "Total:","$1200.00","$1250.00","$1286.40"
//
// Periods are columns and accounts are rows, which is the opposite of the obvious guess and
// the reason the first version of this plugin charted nothing.
//
// Run with: node scripts/check-example-plugin.mjs

import { readFile } from 'node:fs/promises';

import Chart, { build, money, read } from '../assets/plugins/chart.js';
import {
  columns,
  donut,
  draw,
  format,
  group,
  legendFor,
  line,
  ordered,
  page,
  palette,
  ranking,
  stacked,
  ticks,
  typesFor,
  windowed,
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

/** A host that records what the plugin did, in the order it did it. */
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

// ------------------------------------------------------------------ the named questions

check('nothing asks for monthly expenses', build('').command === 'balance expenses -M -O csv', build('').command);
check('spending is the same question said out loud', build('spending').command === 'balance expenses -M -O csv', build('spending').command);
check('income asks for income', build('income').command === 'balance income -M -O csv', build('income').command);
check('cashflow puts income against expenses', build('cashflow').command === 'balance income expenses -M -O csv', build('cashflow').command);
check('net worth runs a running total of assets and liabilities',
  build('networth').command === 'balance assets liabilities -H -M -O csv', build('networth').command);
check('and it is drawn as one line, not two', build('networth').options.total === true, JSON.stringify(build('networth').options));
check('balances asks for every account', build('balances').command === 'balance -H -M -O csv', build('balances').command);
check('payees pivots by payee', build('payees').command === 'balance expenses --pivot payee -M -O csv', build('payees').command);
check('a preset account can be named', build('payees income').command === 'balance income --pivot payee -M -O csv', build('payees income').command);
check('top is a ranking, so no months', build('top').command === 'balance expenses -O csv', build('top').command);
check('a period the caller named is not overridden',
  build('spending -p 2024').command === 'balance expenses -M -p 2024 -O csv', build('spending -p 2024').command);
check('an account is charted over months', build('expenses:food').command === 'balance expenses:food -M -O csv', build('expenses:food').command);
check('and a period flag stops the months being added',
  build('expenses:food -p 2024').command === 'balance expenses:food -p 2024 -O csv', build('expenses:food -p 2024').command);
check('a report command is passed through whole',
  build('balance assets -M').command === 'balance assets -M -O csv', build('balance assets -M').command);
check('a format the caller chose is left alone',
  build('balance assets -O json').command === 'balance assets -O json', build('balance assets -O json').command);

// ------------------------------------------------------------------ reading hledger

{
  const report = read(MONTHLY_CSV);
  check('a monthly report is periods and series', report.periods.length === 3 && report.series.length === 3,
    JSON.stringify({ periods: report.periods.length, series: report.series.length }));
  check('the Total row is not a series', !report.series.some((series) => /total/i.test(series.label)), '');
  check('the commodity is taken from an amount that has one', report.unit.prefix === '$', JSON.stringify(report.unit));
  check('amounts keep their value', report.series[1].amounts[2].value === 1286.4, String(report.series[1].amounts[2].value));
}

{
  const report = read(RANKING_CSV);
  check('a one-column report is one period', report.periods.length === 1 && report.periods[0] === 'balance', report.periods.join(','));
  check('with a series per account', report.series.length === 3, String(report.series.length));
}

{
  const report = read(STATEMENT_CSV);
  check('a statement finds its header under the title', report && report.periods[0] === '2024-02-03', report ? report.periods.join(',') : 'null');
  check('and skips its section rows', report.series.length === 2 && report.series[0].label === 'assets:bank:checking',
    report.series.map((series) => series.label).join(', '));
}

check('a European decimal mark is read', money('1.234,56 EUR').value === 1234.56, JSON.stringify(money('1.234,56 EUR')));
check('and the commodity after it is kept', money('1.234,56 EUR').suffix === 'EUR', JSON.stringify(money('1.234,56 EUR')));
check('a negative amount keeps its sign and loses it from the prefix',
  money('-$12.00').value === -12 && money('-$12.00').prefix === '$', JSON.stringify(money('-$12.00')));
check('an empty cell is recognisable as empty', money('').raw === '' && money('0').raw === '0', '');
check('nothing to read is null', read('') === null && read('"account","x"\n') === null, '');

// ------------------------------------------------------------------ drawing

const report = read(MONTHLY_CSV);
const rankingReport = read(RANKING_CSV);

check('a line is drawn with a dot per period', (line(report, COLORS).match(/<circle/g) || []).length === 9,
  String((line(report, COLORS).match(/<circle/g) || []).length));
check('the axis is round numbers with the commodity on them',
  line(report, COLORS).includes('$500') && line(report, COLORS).includes('$1.0k'), '');
check('a single-line chart fills the area under it', line(report, COLORS, { total: true }).includes('<polygon'), '');
check('stacked draws one band per series', (stacked(report, COLORS).match(/<polygon/g) || []).length === 3,
  String((stacked(report, COLORS).match(/<polygon/g) || []).length));
check('columns draws a bar per period', (columns(report, COLORS).match(/<rect/g) || []).length === 9,
  String((columns(report, COLORS).match(/<rect/g) || []).length));
check('a ranking is one bar per account', (ranking(rankingReport, COLORS).match(/<rect/g) || []).length === 3, '');
check('largest first',
  ranking(rankingReport, COLORS).indexOf('expenses:housing:rent') < ranking(rankingReport, COLORS).indexOf('expenses:reading:books'), '');
check('a ranking says what share each is', ranking(rankingReport, COLORS).includes('%'), '');
check('a donut is one arc per account', (donut(rankingReport, COLORS).match(/<path/g) || []).length === 3,
  String((donut(rankingReport, COLORS).match(/<path/g) || []).length));
check('and it carries a legend', donut(rankingReport, COLORS).includes('<rect') && donut(rankingReport, COLORS).includes('expenses:reading:books'), '');
check('every type is reachable by name',
  ['line', 'stacked', 'columns', 'ranking', 'donut'].every((type) => draw(type, report, COLORS).includes('<svg')), '');
check('a one-period report offers only what makes sense',
  typesFor(rankingReport).map((type) => type.id).join(',') === 'ranking,donut',
  typesFor(rankingReport).map((type) => type.id).join(','));
check('the theme colours the series', palette(COLORS, 3).length === 3 && palette(COLORS, 3)[0] !== palette(COLORS, 3)[1],
  palette(COLORS, 3).join(' '));
check('ticks are round numbers', ticks(0, 1286.4).join(',') === '0,500,1000,1500', ticks(0, 1286.4).join(','));
check('and a flat report does not fall over', ticks(5, 5).length === 1, ticks(5, 5).join(','));
check('thousands are grouped, and only thousands', group(1234567.891) === '1,234,567.89', group(1234567.891));
check('an amount is written as a person writes it', format(money('-$1234.56')) === '-$1,234.56', format(money('-$1234.56')));

// ------------------------------------------------------------------ what the window can do

{
  const many = read(MONTHLY_CSV);
  check('a range slices the periods', windowed(many, '3').periods.length === 3 && windowed(many, 'all').periods.length === 3, '');
  const long = { periods: Array.from({ length: 24 }, (_, index) => `2024-${index}`), series: [{ label: 'a', amounts: Array.from({ length: 24 }, () => money('$1')) }], unit: { prefix: '$', suffix: '' } };
  check('the last three of twenty-four', windowed(long, '3').periods.length === 3 && windowed(long, '3').periods[0] === '2024-21', windowed(long, '3').periods.join(','));
  check('and all of them when asked', windowed(long, 'all').periods.length === 24, '');
}

{
  const many = { periods: ['p'], unit: { prefix: '$', suffix: '' }, series: Array.from({ length: 10 }, (_, index) => ({ label: `s${index}`, amounts: [money(`$${index + 1}`)] })) };
  const ordered_ = ordered(many, 7);
  check('more series than fit are added up as other', ordered_.length === 7 && ordered_[6].label.startsWith('other ('), ordered_.map((series) => series.label).join(','));
  check('and the biggest are the ones kept', ordered_[0].label === 's9', ordered_[0].label);
}

{
  // A colour key that does not match the chart is worse than no key.
  const lineLegend = legendFor(report, COLORS, 'line');
  check('the legend names the series in the order they are drawn',
    (lineLegend.match(/data-legend/g) || []).length === 3 && lineLegend.indexOf('expenses:housing:rent') < lineLegend.indexOf('expenses:food:coffee'),
    lineLegend.slice(0, 120));
  check('and gives each one its own colour',
    new Set([...lineLegend.matchAll(/background:([^"]+)/g)].map((match) => match[1])).size === 3, '');
  check('a ranking has no second colour key', legendFor(rankingReport, COLORS, 'ranking') === '', '');
  check('and neither does a donut', legendFor(rankingReport, COLORS, 'donut') === '', '');
}

{
  const html = page({
    report,
    colors: COLORS,
    title: 'spending',
    command: 'balance expenses -M -O csv',
    token: 'token-1',
    module: '/plugins/chart-window.js',
  });
  check('the page draws the first chart before any script runs', html.includes('<svg') && html.includes('<polyline'), '');
  check('it has a button per type', html.includes('data-type="line"') && html.includes('data-type="donut"'), '');
  check('it has a range button', html.includes('data-range="all"'), '');
  check('it carries the data, the colours and its token',
    html.includes('token-1') && html.includes(COLORS.accent) && html.includes('2024-01'), '');
  check('and it imports the module that makes it interactive', html.includes('chart-window.js') && html.includes('mount()'), '');
  check('the numbers are there as a table', html.includes('<table') && html.includes('2024-02'), '');
  check('it escapes anything that could close a script element',
    !page({ report: { ...report, series: [{ label: '</script><script>', amounts: report.series[0].amounts }] }, colors: COLORS, title: 'x', command: 'c', token: 't', module: 'm' }).includes('</script><script>'), '');
}

// ------------------------------------------------------------------ running the plugin

{
  const { host, log, last } = stub();
  await Chart.run('', host);
  check('it opens the window before asking hledger', log.events[0] === 'window' && log.events.includes('hledger'), log.events.join(','));
  check('it shows something while it waits', log.pages[0].includes('Reading hledger'), '');
  check('it titles the window after what it is charting', log.title === 'hledger: expenses', log.title);
  check('it registers a bridge for the window to ask through', typeof globalThis.__chartBridges === 'object', '');
  check('it remembers the account', log.said.includes('remember account=expenses'), JSON.stringify(log.said));
  check('and says what it drew', log.said.some((line_) => line_.includes('3 periods of expenses') && line_.includes('$1,286.40')), JSON.stringify(log.said));
  check('the page it wrote can draw', last().includes('<polyline'), '');
}

{
  const { host, log } = stub({ hledger: async () => { throw new Error('no journal is loaded'); } });
  await Chart.run('spending', host);
  check('a failed run is on the page', log.pages[log.pages.length - 1].includes('no journal is loaded'), '');
  check('and in the terminal', log.said.some((line_) => line_.includes('no journal is loaded')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ hledger: async () => '"account","2024-01"\n' });
  await Chart.run('spending', host);
  check('an empty report is reported, not charted', log.said.some((line_) => line_.includes('no amounts')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ window: () => null });
  await Chart.run('spending', host);
  check('a blocked window is reported', log.said.some((line_) => line_.includes('blocked')), JSON.stringify(log.said));
}

{
  // net worth is one line of the running total, which is the whole point of the preset.
  const { host, last } = stub();
  await Chart.run('networth', host);
  check('a running-total query draws one line, not one per account',
    (last().match(/<polyline/g) || []).length === 1, String((last().match(/<polyline/g) || []).length));
  check('and asks hledger for the running total',
    host.hledger && last().includes('balance assets liabilities -H -M -O csv'), '');
}

{
  const { host, last } = stub({ colors: undefined });
  await Chart.run('spending', host);
  check('a host without colors() still gets a readable page', last().includes('#000000') && last().includes('<polyline'), '');
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
let modulesThere = true;
for (const plugin of manifest.plugins || []) {
  for (const named of [plugin.module, './chart-window.js']) {
    try {
      await readFile(new URL(named, new URL('../assets/plugins/plugins.json', import.meta.url)));
    } catch {
      modulesThere = false;
    }
  }
}
check('and every plugin names a module that exists, window included', modulesThere, `${manifest.plugins?.length} plugins`);

// ------------------------------------------------------------------ the verdict

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
