// Checks the bundled chart plugin, its window, and the repository they ship in.
//
// The plugin is the worked example in docs/plugins.md and the only plugin most people will ever
// see, so it has to keep working. None of this needs a browser: the plugin's job is turning
// arguments into a command and a CSV into data, and the window's job is turning that data into a
// model of what to draw, and both are functions.
//
// What cannot be checked here is the drawing and the interacting: real SVG, a tooltip, a wheel
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

import Chart, { build, parseReport, read } from '../assets/plugins/chart.js';
import { OPTIONS, TYPES, closestType, command, drill, line, matchField, parse, pivotOf, quote, related, title, tokenize, typeOf } from '../assets/plugins/chart-args.js';
import { amountsIn, chosen, inOneCommodity, leftOut, shape, trimmed } from '../assets/plugins/chart-data.js';
import { beeswarm, bins, budgetView, cashflowOf, categoryOf, edge, intensity, ranks, readBudget, transactionsOf, viewMore } from '../assets/plugins/chart-more.js';
import { HOLD, MOVE, ease, periodOf, positionAt, timeline } from '../assets/plugins/chart-play.js';
import { cardColour, cascade, groupsOf, leafTotal, nestTree, readTreeSeries, treeAt } from '../assets/plugins/chart-d3.js';
import Edit from '../assets/plugins/edit.js';
import Reconcile, { fileFor, fingerprint, parseLine, resolveAccount } from '../assets/plugins/reconcile.js';
import { assertionText, checkpoints, formatHeader, formatPosting, hints, journalAmount, moveRefusal, ordered, parseHeader, parsePosting, parseInput, plan, readAmount, readPrint, readTransaction, readable, remark, summarize, template, toMinor, visibleRows } from '../assets/plugins/reconcile-data.js';
import { matching, page as reconcilePage, partHint } from '../assets/plugins/reconcile-window.js';
import { RECONCILE_JOURNAL, RECONCILE_PRINT } from './reconcile-fixtures.mjs';

import { page as editPage } from '../assets/plugins/edit-window.js';
import { alsoLine } from '../assets/plugins/chart-window.js';
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
  logTicks,
  tick,
  waterfall,
} from '../assets/plugins/chart-d3.js';
import {
  headline,
  keysLine,
  modelFor,
  page,
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

// ------------------------------------------------------------------ the grammar

{
  const asked = (args) => build(args).command;
  check('the example from the request asks hledger for exactly the query',
    asked('--log bar -p 2026 coffee') === 'balance -p 2026 coffee -O csv' && build('--log bar -p 2026 coffee').options.log === true
    && build('--log bar -p 2026 coffee').kind === 'bar', asked('--log bar -p 2026 coffee'));
  check('the query is passed as written, in its order', asked('bar --depth 2 -H assets liabilities') === 'balance --depth 2 -H assets liabilities -O csv',
    asked('bar --depth 2 -H assets liabilities'));
  check('a quoted period stays one argument, quoted again for hledger',
    asked('bar -p "last year" food') === 'balance -p "last year" food -O csv' && tokenize('-p "last year" food').length === 3,
    asked('bar -p "last year" food'));
  check('a chart over time is monthly unless the query names an interval',
    asked('line expenses') === 'balance expenses -M -O csv' && asked('line -W expenses') === 'balance -W expenses -O csv'
    && asked('stacked --quarterly expenses') === 'balance --quarterly expenses -O csv' && asked('multiples') === 'balance -M -O csv',
    asked('line -W expenses'));
  check('a bar chart and a pie are not split unless asked',
    asked('bar expenses') === 'balance expenses -O csv' && asked('bar -M expenses') === 'balance -M expenses -O csv' && asked('pie expenses') === 'balance expenses -O csv', '');
  check('each shaped type reads the report its picture needs',
    asked('treemap expenses') === 'balance --tree expenses -O csv' && asked('calendar -p 2026') === 'register -p 2026 -O csv'
    && asked('waterfall') === 'register -O csv' && asked('sankey -p 2026') === 'balance -p 2026 --depth 2 -O csv'
    && asked('sankey --depth 3') === 'balance --depth 3 -O csv',
    [asked('treemap expenses'), asked('sankey -p 2026')].join(' | '));
  check('a format the caller chose is left alone', asked('bar -O json') === 'balance -O json', asked('bar -O json'));
  check('every option is read, with or without =',
    JSON.stringify(parse('--log --percent --cumulative --top 3 --sort=name --invert line').options)
      === JSON.stringify({ log: true, percent: true, cumulative: true, top: 3, sort: 'name', invert: true }),
    JSON.stringify(parse('--log --percent --cumulative --top 3 --sort=name --invert line').options));
  check('an alias names its type', typeOf('doughnut') === 'pie' && typeOf('AREA') === 'stacked' && typeOf('sparklines') === 'multiples' && typeOf('food') === null, '');
  check('every type and option is documented in code', Object.values(TYPES).every((type) => type.says) && Object.values(OPTIONS).every((option) => option.says), '');
}

{
  const refused = (args) => build(args).refusal || '';
  check('nothing after chart asks which chart, and lists the types', /^which chart\? Name a type: line, bar, .* or multiples\./.test(refused('')), refused(''));
  check('a word that is not a type says where the type goes', /coffee is not a chart type; the type comes before the query, as in chart bar coffee/.test(refused('coffee')), refused('coffee'));
  check('a misspelt type is offered the one it was probably meant to be, swaps included',
    refused('lien expenses') === 'lien is not a chart type. Did you mean line?' && closestType('stakced') === 'stacked' && closestType('pei') === 'pie'
    && closestType('expenses') === null && closestType('food:x') === null, refused('lien expenses'));
  check('an unknown option lists the real ones', /--wat is not a chart option\. Chart options are --log, --percent, --cumulative, --top N, --sort name\|value, --invert/.test(refused('--wat bar')), refused('--wat bar'));
  check('a chart option after the type is moved, not handed to hledger',
    refused('bar --log coffee') === '--log is a chart option, so it goes before the type: chart --log bar ...', refused('bar --log coffee'));
  check('an option that does not apply to a type is refused, with the ones that do',
    refused('--log pie expenses') === '--log does not apply to a pie; it takes --top, --sort, --invert, --cumulative, --animate.'
    && refused('--log --percent treemap') === '--log and --percent do not apply to a treemap; it takes --cumulative, --animate.'
    && refused('--top 2 calendar') === '--top does not apply to a calendar; it takes no chart options.', refused('--log --percent treemap'));
  check('a value an option needs is asked for',
    refused('--top bar') === '--top takes a number of accounts, such as --top 5, not bar.' && refused('--sort') === '--sort needs a value: --sort name|value.'
    && refused('--sort size bar') === '--sort takes name or value, not size.' && refused('--top 0 bar').startsWith('--top takes a number'), refused('--sort size bar'));
  check('every refusal is terminal text', ['', 'coffee', 'lien', '--wat bar', 'bar --log x', '--log pie', '--top bar'].every((args) => !/[`\u2014]/.test(refused(args))), '');
}

{
  const parsed = parse('--log --percent --top 3 bar -p "last year" -M food');
  check('the title reads as it would be said', title(parse('--log bar -p 2026 coffee')) === 'bar: coffee, -p 2026 (log scale)'
    && title(parse('line')) === 'line: all accounts' && title(parsed) === 'bar: food, -p "last year" -M (log scale, percent, top 3)', title(parsed));
  check('a parsed line is written back as the line that asks for it', line(parsed) === '--log --percent --top 3 bar -p "last year" -M food', line(parsed));
  check('a click on an account charts it over time, in the same period, with the options that still mean something',
    drill(parsed, 'expenses:food:coffee') === '--log line -p "last year" -M expenses:food:coffee'
    && drill(parse('treemap --tree expenses'), 'expenses:food') === 'line expenses:food', drill(parsed, 'expenses:food:coffee'));
  const links = related(parse('--log --top 3 bar -p 2026 coffee'));
  check('related charts are the same query as the other types of its family, each with the options it takes',
    links.map((link) => link.label).join(' | ') === 'chart --top 3 pie -p 2026 coffee | chart treemap -p 2026 coffee | chart sunburst -p 2026 coffee | chart pack -p 2026 coffee | chart --log --top 3 line -p 2026 coffee',
    links.map((link) => link.label).join(' | '));
  check('a flow suggests the other flows', related(parse('sankey -p 2026')).map((link) => link.args).join() === 'cashflow -p 2026,waterfall -p 2026,budget -p 2026,calendar -p 2026',
    related(parse('sankey -p 2026')).map((link) => link.args).join());
  check('every suggestion and every drill is a line the plugin builds',
    ['--log bar coffee', 'sankey', 'calendar', '--top 2 pie', '--percent stacked'].every((args) => build(args).related.every((link) => !build(link.args).refusal)
      && !build(drill(parse(args), 'expenses:x')).refusal), '');
  check('a word with a space is quoted, and one without is not', quote('last year') === '"last year"' && quote('2026') === '2026', '');
  check('command and parse agree', command(parse('line food')) === 'balance food -M -O csv', '');
  check('the links are escaped, and say their command',
    alsoLine([{ label: 'chart <x>', args: 'a"b' }]) === 'Also: <a href="#" data-args="a&quot;b">chart &lt;x&gt;</a>' && alsoLine([]) === '',
    alsoLine([{ label: 'chart <x>', args: 'a"b' }]));
}

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

check('a line is a line when it has periods', typeFor(report, 'line') === 'line' && typeFor(report) === 'line', typeFor(report, 'line'));
check('a bar chart ranks one period, and makes columns of several',
  typeFor(ranking, 'bar') === 'bar' && typeFor(report, 'bar') === 'columns', typeFor(report, 'bar'));
check('a pie is a doughnut', typeFor(ranking, 'pie') === 'doughnut', typeFor(ranking, 'pie'));
check('a line of one period is drawn as the ranking, not one point', typeFor(ranking, 'line') === 'bar', typeFor(ranking, 'line'));
check('the subtitle counts periods when there are several',
  headline(report, 'line') === '3 periods, 2024-01 to 2024-03', headline(report, 'line'));
check('and accounts when there is one', headline(ranking, 'bar').startsWith('3 accounts'), headline(ranking, 'bar'));
check('and one account is one', headline(read('"account","balance"\n"a","$1"\n'), 'bar').startsWith('1 account,'), '');

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
  check('the unit is the report\'s, for the axis and the tooltip', model.unit.prefix === '$', JSON.stringify(model.unit));
  check('several lines are not filled, so none hides another', model.fill === false, '');
  check('and a click on one can open it', model.drillable === true && !model.series[0].other, '');
}

// ------------------------------------------------------------------ the chart options

{
  const inverted = shape(report, { invert: true });
  check('--invert flips every amount, and leaves the report it was given alone',
    inverted.series[1].amounts.map((amount) => amount.value).join() === '-1200,-1237.5,-1286.4' && report.series[1].amounts[0].value === 1200, '');
  const running = shape(report, { cumulative: true });
  check('--cumulative is a running total, period by period',
    running.series[1].amounts.map((amount) => amount.value).join() === '1200,2437.5,3723.9', running.series[1].amounts.map((amount) => amount.value).join());
  const shares = shape(report, { percent: true });
  check('--percent is each account\'s share of its period, and the unit becomes %',
    shares.series[0].amounts[1].value === 1 && shares.series[1].amounts[0].value === 100 && shares.unit.suffix === '%' && shares.unit.prefix === '',
    shares.series.map((series) => series.amounts.map((amount) => amount.value.toFixed(1)).join('/')).join(' '));
  const both = shape(report, { cumulative: true, percent: true });
  check('and of running totals, each account\'s share of everything so far',
    Math.abs(both.series[0].amounts[2].value - (100 * 12.5) / 3736.4) < 1e-9, String(both.series[0].amounts[2].value));
  check('a period with nothing in it is 0%, not a division by zero',
    shape(read('"account","a","b"\n"x","$1","0"\n'), { percent: true }).series[0].amounts[1].value === 0, '');

  const rows = [{ label: 'b', value: 5 }, { label: 'a', value: -9 }, { label: 'c', value: 1 }, { label: 'd', value: 2 }];
  const combine = (rest) => ({ label: `other (${rest.length})`, value: rest.reduce((sum, row) => sum + row.value, 0), other: true });
  const size = (row) => row.value;
  check('--top keeps the largest by size, whatever their sign, and adds up the rest',
    chosen(rows, { top: 2, size, combine }).map((row) => `${row.label}=${row.value}`).join() === 'a=-9,b=5,other (2)=3', '');
  check('--sort name orders what was kept, with the other last',
    chosen(rows, { top: 2, sort: 'name', size, combine }).map((row) => row.label).join() === 'a,b,other (2)', '');
  check('without --top, a chart keeps what fits and never an other for one account',
    chosen(rows, { fits: 4, size, combine }).length === 4 && chosen(rows, { fits: 3, size, combine }).map((row) => row.label).join() === 'a,b,other (2)', '');

  const logBar = modelFor({ report: ranking, colors: COLORS, title: 't', kind: 'bar', options: { log: true, top: 1 } });
  check('the model carries --log, and --top folds the ranking',
    logBar.log === true && logBar.rows.map((row) => row.label).join() === 'expenses:housing:rent,other (2)' && logBar.rows[1].colour === COLORS.dim,
    logBar.rows.map((row) => row.label).join());
  const percentBar = modelFor({ report: ranking, colors: COLORS, title: 't', kind: 'bar', options: { percent: true } });
  check('--percent on a ranking is each account\'s share', Math.abs(percentBar.rows[0].value - 90.81) < 0.01 && percentBar.unit.suffix === '%',
    String(percentBar.rows[0].value));
  const columns = modelFor({ report, colors: COLORS, title: 't', kind: 'bar', options: { top: 1, sort: 'name' } });
  check('columns are series per period, chosen the same way', columns.type === 'columns' && columns.series.length === 2 && columns.series[1].other, '');
  check('an axis tick for a percentage has no space before the sign', tick(45, { prefix: '', suffix: '%' }) === '45%', tick(45, { prefix: '', suffix: '%' }));
  check('a logarithmic axis is ticked at the powers of ten, either side of zero',
    logTicks(-100, 1000).join() === '-100,-10,-1,0,1,10,100,1000' && logTicks(0, 1e12).length <= 9
    && logTicks(0, 1e12).includes(0) && logTicks(0, 1e12).includes(1e12),
    `${logTicks(-100, 1000).join()} / ${logTicks(0, 1e12).join()}`);
}

{
  const model = modelFor({ report, colors: COLORS, title: 'by category', kind: 'stacked' });
  check('a stacked report is a stacked area', model.type === 'stacked', model.type);
  check('whose layers are not filled as one line', model.fill === false, '');
  check('one period of it is a ranking, since there is nothing to stack over',
    typeFor(ranking, 'stacked') === 'bar', typeFor(ranking, 'stacked'));
  const single = modelFor({ report: { ...report, series: report.series.slice(1, 2) }, colors: COLORS, title: 'x', kind: 'line' });
  check('a line of one account is filled, since there is nothing to compare it with', single.fill === true, '');
}

{
  const model = modelFor({ report: ranking, colors: COLORS, title: 'top' });
  check('a ranking is a bar chart', model.type === 'bar', model.type);
  check('largest first', model.rows[0].label === 'expenses:housing:rent', model.rows[0].label);
  check('in the accent colour, since every bar is labelled', model.rows.every((row) => row.colour === COLORS.accent), '');
  check('and each bar knows its share', model.rows[0].shareText === '90.8%', model.rows[0].shareText);
  check('of a total the tooltip can say', Math.abs(model.total - 1321.39) < 0.005, String(model.total));
}

{
  const model = modelFor({ report: ranking, colors: COLORS, title: 'shares', kind: 'pie' });
  check('shares is a doughnut', model.type === 'doughnut', model.type);
  check('one slice per account', model.rows.length === 3, String(model.rows.length));
  check('slices are separate colours', new Set(model.rows.map((row) => row.colour)).size === 3, '');
  check('and a slice knows its share', model.rows[0].shareText === '90.8%', model.rows[0].shareText);
  const signed = read('"account","balance"\n"a","$10"\n"b","$-5"\n"c","$30"\n');
  check('a negative balance is not a slice', modelFor({ report: signed, colors: COLORS, title: 'x', kind: 'pie' }).rows.length === 2, '');
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
  check('a bar names its account', model.rows[0].label === 'expenses:housing:rent' && !model.rows[0].other, model.rows[0].label);
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
  check('and other is marked as one, so it is not something to drill into', model.series[6].other === true && !model.series[0].other, '');
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

check('a period with nothing in it is written in the report\'s commodity',
  tableView(read('"account","2024-01","2024-02"\n"expenses:food","0","$12.50"\n')).includes('$0.00')
  && !tableView(read('"account","2024-01","2024-02"\n"expenses:food","0","$12.50"\n')).includes('>0.00<'), '');
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
  await Chart.run('line expenses', host);
  check('it opens the window before asking hledger', log.events[0] === 'window' && log.events.includes('hledger'), log.events.join(','));
  check('it shows something while it waits', log.pages[0].includes('Reading hledger'), '');
  check('it titles the window after what it is charting', log.title === 'hledger: line: expenses', log.title);
  check('it asks hledger for the query, monthly', log.asked[0] === 'balance expenses -M -O csv', log.asked[0]);
  check('it registers a bridge for a click to ask through', typeof globalThis.__chartBridges === 'object', '');
  check('and says what it drew', log.said[0] === 'chart: line of 3 accounts over 3 periods, the last $1,286.40, up $86.40, in a new window.', log.said[0]);
  check('the page it wrote is the chart', last().includes('<svg class="chart"') && !last().includes('<button'), '');
  check('and it loads D3 from beside the plugin', last().includes('vendor/d3/d3.min.js') && !last().includes('chart.umd'), '');
  check('the page carries the line, for following marks from, and its related charts',
    last().includes('"args":"line expenses"') && last().includes('Also: <a href="#" data-args="stacked expenses">chart stacked expenses</a>'), '');
}

{
  // The plugin's half of following a mark or a link: the bridge runs any line chart takes.
  const { host, log } = stub();
  await Chart.run('--log bar -p 2026 coffee', host);
  check('the example from the request asks hledger for the query alone',
    log.asked[0] === 'balance -p 2026 coffee -O csv' && log.pages[log.pages.length - 1].includes('"options":{"log":true}'), log.asked[0]);
  const token = /"token":"([^"]+)"/.exec(log.pages[log.pages.length - 1])[1];
  const bridge = globalThis.__chartBridges[token];
  const answer = await bridge.requery('--log line -p 2026 expenses:food:coffee');
  check('a window\'s line is run, and comes back with what the window needs',
    log.asked[log.asked.length - 1] === 'balance -p 2026 expenses:food:coffee -M -O csv' && answer.kind === 'line'
    && answer.args === '--log line -p 2026 expenses:food:coffee' && answer.options.log && answer.related.length > 0,
    log.asked[log.asked.length - 1]);
  const sankey = await bridge.requery('sankey -p 2026');
  check('a shaped chart comes back parsed the way its type is', sankey.kind === 'sankey' && 'sinks' in sankey.report, String(sankey.kind));
  let refusedLine = '';
  try { await bridge.requery('register'); } catch (error) { refusedLine = error.message; }
  check('and a line chart refuses is refused there too', /register is not a chart type/.test(refusedLine), refusedLine);
  host.hledger = async () => '"account","2024-01"\n';
  let refused = '';
  try {
    await bridge.requery('line expenses:nothing');
  } catch (error) {
    refused = error.message;
  }
  check('and a query with nothing in it is an error the window can show', /nothing to chart for line: expenses:nothing/.test(refused), refused);
}

{
  const { host, log } = stub({ hledger: async () => RANKING_CSV });
  await Chart.run('bar expenses', host);
  check('a ranking is summed up by its largest account',
    log.said[0] === 'chart: bar of 3 accounts, the largest $1,200.00 in expenses:housing:rent, in a new window.', log.said[0]);
}

{
  const { host, log } = stub({ hledger: async () => '"account","2024-01","2024-02"\n"income:salary","$-3200.00","$-100.00"\n' });
  await Chart.run('--cumulative --invert line income', host);
  check('the terminal sums up the numbers as the chart shows them, and counts one account as one',
    log.said[0] === 'chart: line of 1 account over 2 periods, the last $3,300.00, up $100.00, in a new window.', log.said[0]);
}

{
  const { host, log } = stub({ hledger: async () => FLOWS_CSV });
  await Chart.run('sankey', host);
  check('a shaped chart is summed up in its own words', log.said[0] === 'chart: sankey, income $3,200.00 into 3 categories, $1,866.11 saved, in a new window.', log.said[0]);
}

{
  const { host, log } = stub({ hledger: async () => { throw new Error('<bad> & worse'); } });
  await Chart.run('line expenses', host);
  check('a message is escaped before it is written into the window',
    log.pages[log.pages.length - 1].includes('&lt;bad&gt; &amp; worse'), log.pages[log.pages.length - 1]);
}

{
  const { host, log } = stub({ hledger: async () => { throw new Error('no journal is loaded'); } });
  await Chart.run('line expenses', host);
  check('a failed run is on the page', log.pages[log.pages.length - 1].includes('no journal is loaded'), '');
  check('and in the terminal', log.said.some((line) => line.includes('no journal is loaded')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ hledger: async () => '"account","2024-01"\n' });
  await Chart.run('bar -p 2031 coffee', host);
  check('an empty report is reported with the command that found nothing',
    log.said[0] === 'chart: bar: coffee, -p 2031 has no amounts to chart. The command was: hledger balance -p 2031 coffee -O csv', log.said[0]);
}

{
  const { host, log } = stub({ window: () => null });
  await Chart.run('line expenses', host);
  check('a blocked window is reported', log.said.some((line) => line.includes('blocked')), JSON.stringify(log.said));
}

{
  const { host, log } = stub();
  await Chart.run('', host);
  check('a line chart cannot read is answered in the terminal, with no window opened',
    log.events.length === 0 && /^chart: which chart\? Name a type/.test(log.said[0]), JSON.stringify(log));
  const misspelt = stub();
  await Chart.run('--log lien coffee', misspelt.host);
  check('and so is a misspelt type, with the one it was probably meant to be',
    misspelt.log.said[0] === 'chart: lien is not a chart type. Did you mean line?', misspelt.log.said[0]);
}

{
  const { host, last } = stub({ colors: undefined });
  await Chart.run('line expenses', host);
  check('a host without colors() still gets a readable page', last().includes('#000000') && last().includes('<svg class="chart"'), '');
}

// ------------------------------------------------------------------ a real journal's shapes

// The shapes below are from a real personal journal: accounts capitalised, balances held in
// several commodities in one cell, stock trades in the register, and a year asked for before
// it is over. Each one broke a chart before it was checked here.
{
  check('a cell in several commodities is every amount in it',
    amountsIn('3500 CNY, 2530801.73 IDR, 300.0000 USD').map((amount) => `${amount.value} ${amount.suffix}`).join('|') === '3500 CNY|2530801.73 IDR|300 USD'
    && amountsIn('$1,234.56').length === 1 && amountsIn('').length === 0, '');
  const column = inOneCommodity(['3500 CNY, 2530801.73 IDR', '390868.00 IDR', '0', '1.5456 PGDN_GOLD', '-12.00 IDR']);
  check('a column is read in the commodity most of it is in, a bare 0 included',
    column.unit.suffix === 'IDR' && column.amounts.map((amount) => amount.value).join() === '2530801.73,390868,0,0,-12', column.amounts.map((amount) => amount.value).join());
  check('and what was left out is named', column.others.join() === 'CNY,PGDN_GOLD', column.others.join());
  check('a commodity in letters is set apart from its number, as hledger writes it',
    format({ value: 27500, prefix: '', suffix: 'IDR' }) === '27,500.00 IDR' && format({ value: -3, prefix: 'EUR', suffix: '' }) === '-EUR 3.00'
    && format({ value: 12.5, prefix: '$', suffix: '' }) === '$12.50' && format({ value: 45, prefix: '', suffix: '%' }) === '45.00%', '');

  const assets = read('"account","balance"\n"Assets:BCADigital","3500 CNY, 2530801.73 IDR, 300.0000 USD"\n"Assets:BNI","390868.00 IDR"\n"Total:","3500 CNY, 2921669.73 IDR, 300 USD"\n');
  check('a balance report in several commodities is drawn in its main one, not its first',
    assets.unit.suffix === 'IDR' && assets.series[0].amounts[0].value === 2530801.73 && assets.others.join() === 'CNY,USD', JSON.stringify(assets.series[0].amounts[0]));
  check('and the chart says what it left out, and how to convert it',
    leftOut(assets.others, assets.unit) === 'Drawn in IDR; amounts in CNY, USD are left out. Add -X IDR to the query to convert them at market prices.', leftOut(assets.others, assets.unit));
  check('or, when it was already converting, that there was no price to convert with',
    /hledger had no market price in IDR for them; a P directive gives one\./.test(leftOut(['NVDA', 'SPCX'], { suffix: 'IDR' }, 'balance -X IDR -O csv'))
    && leftOut([], { suffix: 'IDR' }) === '', '');

  const register = readRegister([
    '"txnidx","date","code","description","account","amount","total"',
    '"1","2026-06-03","","Sell ADRO","Assets:Mansek:Stocks:ADRO","-2000 ADRO","-2000 ADRO"',
    '"1","2026-06-03","","Sell ADRO","Assets:Mansek:Cash","4367736.00 IDR","-2000 ADRO, 4367736.00 IDR"',
    '"2","2026-09-01","","GrabBike","Expenses:Transport:E-Hailing","15800.00 IDR","15800.00 IDR"',
    '"3","2026-09-02","","Gift","Expenses:Gifts","300 SAR","300 SAR"',
    '"4","2026-09-25","","Salary","Income:Salary","-9000000.00 IDR","-9000000.00 IDR"',
  ].join('\n'));
  const days = byDay(register);
  check('a capitalised Expenses is still expenses: the calendar is not empty',
    days.days.length === 1 && days.days[0].value === 15800 && days.unit.suffix === 'IDR', JSON.stringify(days.days));
  check('and it names only what it left out of the spending, not the stocks traded beside it',
    days.others.join() === 'SAR', days.others.join());
  const falls = waterfall(register);
  check('so is a capitalised Income: the waterfall walks from it',
    falls.income === 9000000 && falls.spent === 15800 && falls.others.join() === 'SAR', JSON.stringify({ income: falls.income, spent: falls.spent }));

  const year = read('"account","2026-01","2026-02","2026-03","2026-04"\n"Expenses:Food","0","5000 IDR","0","0"\n"Expenses:Rent","0","9000 IDR","0","1 IDR"\n');
  const cut = trimmed(year);
  check('empty periods at the ends are not drawn, and one between is kept',
    cut.periods.join() === '2026-02,2026-03,2026-04' && cut.dropped === 1 && cut.series[1].amounts.length === 3, cut.periods.join());
  check('and the subtitle says how many were left off', headline(cut, 'line') === '3 periods, 2026-02 to 2026-04; 1 empty period at the ends not drawn', headline(cut, 'line'));
  check('a report with nothing empty is left as it is', trimmed(report).periods.length === 3 && trimmed(report).dropped === 0, '');
  check('the window draws the trimmed report', viewOf({ report: year, colors: COLORS, title: 't', kind: 'line', options: {} }).data.periods.join() === '2026-02,2026-03,2026-04', '');

  const many = flows(read(`"account","balance"\n${Array.from({ length: 20 }, (_, index) => `"Expenses:C${index}","${100 - index} IDR"`).join('\n')}\n"Income:Salary","-5000 IDR"\n`));
  const shown = viewOf({ report: many, colors: COLORS, title: 't', kind: 'sankey', options: {} });
  check('a Sankey of many categories keeps twelve and folds the rest',
    shown.data.sinks.filter((node) => node.kind === 'expense').length === 13 && shown.data.sinks.some((node) => node.label === 'other (8)'), String(shown.data.sinks.length));
  check('and its headline still counts every category', /into 20 categories/.test(shown.sub), shown.sub);
}

{
  const { host, log } = stub({ hledger: async () => '"account","balance"\n"Assets:BCADigital","3500 CNY, 2530801.73 IDR"\n"Assets:BNI","390868.00 IDR"\n' });
  await Chart.run('bar Assets', host);
  check('the terminal says what a chart left out, too',
    log.said[0].endsWith('Drawn in IDR; amounts in CNY are left out. Add -X IDR to the query to convert them at market prices.')
    && log.said[0].includes('2,530,801.73 IDR in Assets:BCADigital'), log.said[0]);
}

// ------------------------------------------------------------------ more charts, and playing them

{
  const asked = (args) => build(args).command;
  check('the new types ask hledger for what they draw',
    asked('heatmap expenses') === 'balance expenses -M -O csv' && asked('bump expenses') === 'balance expenses -M -O csv'
    && asked('stream -W expenses') === 'balance -W expenses -O csv' && asked('sunburst expenses') === 'balance --tree expenses -O csv',
    [asked('heatmap expenses'), asked('sunburst expenses')].join(' | '));
  check('an animation asks for every period, monthly unless the query says',
    asked('--animate treemap -p 2026 expenses') === 'balance --tree -p 2026 expenses -M -O csv'
    && asked('--animate sankey -Q') === 'balance -Q --depth 2 -O csv' && asked('--animate bar expenses') === 'balance expenses -M -O csv',
    asked('--animate treemap -p 2026 expenses'));
  check('and is titled as one', build('--animate treemap expenses').title === 'treemap: expenses (animated)', build('--animate treemap expenses').title);
  check('the new names are aliases too', typeOf('streamgraph') === 'stream' && typeOf('race') === 'bar' && typeOf('rings') === 'sunburst' && typeOf('rank') === 'bump', '');
  const refused = (args) => build(args).refusal || '';
  check('--animate on a chart that already shows every period says which ones it plays',
    /--animate does not apply to a line; .* A line already shows every period; --animate plays bar, pie, treemap, sunburst, pack, sankey\./.test(refused('--animate line expenses')),
    refused('--animate line expenses'));
  check('a running total of a one-period chart needs periods, so it says to animate',
    refused('--cumulative treemap') === '--cumulative on a treemap needs periods to run over, so it goes with --animate: chart --animate --cumulative treemap ...'
    && !build('--animate --cumulative treemap').refusal, refused('--cumulative treemap'));
  check('a related chart that cannot take an option is offered without it',
    related(parse('--cumulative line expenses')).every((link) => !build(link.args).refusal), related(parse('--cumulative line expenses')).map((link) => link.args).join(' ; '));
}

{
  check('a heatmap colours by size, and by magnitude with --log',
    intensity(50, 100) === 0.5 && intensity(0, 100) === 0 && intensity(-100, 100) === 1 && intensity(10, 1e6, true) > 0.15 && intensity(10, 1e6) < 0.001, '');
  const table = ranks([{ values: [5, 1, 3] }, { values: [9, 0, 3] }, { values: [1, 4, 3] }], ['a', 'b', 'c']);
  check('a bump chart ranks every period, a tie kept in order',
    JSON.stringify(table) === JSON.stringify([[2, 2, 1], [1, 3, 2], [3, 1, 3]]), JSON.stringify(table));
  const heat = modelFor({ report, colors: COLORS, title: 't', kind: 'heatmap' });
  check('a heatmap is a series per account, without a legend', heat.type === 'heatmap' && heat.series.length === 3
    && viewOf({ report, colors: COLORS, title: 't', kind: 'heatmap', options: {} }).items === null, heat.type);
  check('a stream and a bump chart are their own pictures', typeFor(report, 'stream') === 'stream' && typeFor(report, 'bump') === 'bump'
    && typeFor(ranking, 'stream') === 'bar', '');
  const nested = nestTree(read('"account","x"\n"a","1"\n').series.length ? readTree(TREE_CSV).rows : []);
  const hierarchyOf = (pairs) => {
    // A stand-in for d3.hierarchy with just what groupsOf reads: leaves() and ancestors().
    const rootNode = { depth: 0, data: { name: '' }, children: [] };
    const leaves = pairs.map(([branch, leaf]) => {
      const parent = { depth: 1, data: { name: branch }, parent: rootNode };
      const node = { depth: 2, data: { name: leaf }, parent };
      rootNode.children.push(parent);
      return node;
    });
    const ancestors = (node) => { const list = []; for (let at = node; at; at = at.parent) list.push(at); return list; };
    for (const node of [...leaves, ...rootNode.children]) node.ancestors = () => ancestors(node);
    return { children: rootNode.children, leaves: () => leaves };
  };
  check('a branch\'s colour is chosen by name, so it stays the same when sizes change',
    groupsOf(hierarchyOf([['Supplies', 'a'], ['Food', 'b']])).order.get('Food') === groupsOf(hierarchyOf([['Food', 'b'], ['Supplies', 'a']])).order.get('Food'), '');
  check('the treemap and the sunburst nest the same tree, parents not counted twice',
    nested.children.length > 0 && JSON.stringify(nested).includes('"coffee"'), '');
  check('a sunburst is a shaped chart of the tree', viewOf({ report: readTree(TREE_CSV), colors: COLORS, title: 't', kind: 'sunburst', options: {} }).draw === 'sunburst', '');
}

const TREE_MONTHS = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses","$100.00","$300.00","$0"',
  '"\u00a0\u00a0food","$100.00","$100.00","0"',
  '"\u00a0\u00a0rent","0","$200.00","0"',
].join('\n');

{
  check('the clock holds each period, then eases into the next',
    positionAt(0, 0, 3) === 0 && positionAt(HOLD - 1, 0, 3) === 0 && positionAt(HOLD + MOVE / 2, 0, 3) === 0.5
    && positionAt(HOLD + MOVE, 0, 3) === 1 && positionAt(1e9, 0, 3) === 3 && ease(0) === 0 && ease(1) === 1, String(positionAt(HOLD + MOVE / 2, 0, 3)));
  check('with reduced motion it only steps', positionAt(HOLD * 1.5, 0, 3, { reduced: true }) === 1, String(positionAt(HOLD * 1.5, 0, 3, { reduced: true })));
  const tree = readTreeSeries(TREE_MONTHS);
  check('a tree is read with every period', tree.periods.length === 3 && tree.rows[2].amounts.map((amount) => amount.value).join() === '0,200,0', '');
  check('and is the right tree at a period, or between two', leafTotal(treeAt(tree, 1).rows) === 300 && leafTotal(treeAt(tree, 0.5).rows) === 200, String(leafTotal(treeAt(tree, 0.5).rows)));
  const map = timeline('treemap', tree, {}, COLORS);
  check('an animated treemap is drawn to one scale: a month with a third of the spending is a third of the area',
    Math.abs(map.frame(0).data.fill - 1 / 3) < 1e-9 && map.frame(1).data.fill === 1, String(map.frame(0).data.fill));
  check('empty periods at the ends are not played', timeline('treemap', tree, {}, COLORS).periods.join() === '2024-01,2024-02'
    && timeline('bar', read('"account","a","b","c"\n"x","0","$1","0"\n"y","0","$2","0"\n'), {}, COLORS).periods.join() === 'b', '');
  check('and running totals with --cumulative', timeline('sunburst', tree, { cumulative: true }, COLORS).frame(1).data.total === 400, '');
  check('each period has its own words and table', /\$300\.00 at the leaves/.test(map.words(1).sub) && map.words(1).table.includes('rent'), map.words(1).sub);

  const monthly = read(MONTHLY_CSV);
  check('a balance report at one period is that period, or a mix of two',
    periodOf(monthly, 1).series[1].amounts[0].value === 1237.5 && periodOf(monthly, 0.5).series[1].amounts[0].value === 1218.75, '');
  const race = timeline('bar', monthly, { top: 2 }, COLORS);
  const first = race.frame(0).data;
  check('a bar race ranks every account and shows the top places',
    first.race.slots === 2 && first.rows[0].label === 'expenses:housing:rent' && first.rows[0].at === 0 && /2 places of 3 accounts/.test(race.words(0).sub), race.words(0).sub);
  const swap = timeline('bar', read('"account","a","b"\n"x","$10","$1"\n"y","$5","$20"\n'), {}, COLORS);
  check('and between two periods an overtaking bar glides between ranks',
    swap.frame(0).data.rows[0].label === 'x' && swap.frame(1).data.rows[0].label === 'y'
    && swap.frame(0.5).data.rows.every((row) => row.at > 0 && row.at < 1), JSON.stringify(swap.frame(0.5).data.rows.map((row) => row.at)));
  check('and each account keeps its colour', swap.frame(0).data.rows.find((row) => row.label === 'x').colour === swap.frame(1).data.rows.find((row) => row.label === 'x').colour, '');
  const pie = timeline('pie', monthly, { top: 1 }, COLORS);
  check('an animated pie keeps its slices in one order, with the rest as other',
    pie.frame(0).data.rows.map((row) => row.label).join() === pie.frame(2).data.rows.map((row) => row.label).join()
    && pie.frame(0).data.rows[1].label === 'other (2)', pie.frame(0).data.rows.map((row) => row.label).join());
  const flowsByMonth = read('"account","a","b"\n"expenses:food","$10","$40"\n"expenses:rent","$50","$5"\n"income:salary","$-100","$-100"\n');
  const sankey = timeline('sankey', flowsByMonth, {}, COLORS);
  check('an animated Sankey keeps its nodes in one order, so they do not swap as they grow',
    sankey.frame(0).data.sinks.map((node) => node.label).join() === 'rent,food,saved' && sankey.frame(1).data.sinks.map((node) => node.label).join() === 'rent,food,saved',
    sankey.frame(1).data.sinks.map((node) => node.label).join());
  check('and to one scale across its periods', sankey.frame(0).data.fixed.total === 100 && sankey.frame(1).data.fixed.total === 100, '');
  const played = viewOf({ report: monthly, colors: COLORS, title: 't', kind: 'pie', options: { animate: true } });
  check('the window plays a report with periods, and says so',
    played.draw === 'animate' && /^3 periods, 2024-01 to 2024-03; /.test(played.sub) && played.play.periods.length === 3, played.sub);
  check('one period has nothing to play, so it is drawn still', viewOf({ report: ranking, colors: COLORS, title: 't', kind: 'pie', options: { animate: true } }).draw === 'doughnut', '');
  check('the keys say Space plays', keysLine(true).startsWith('Space play, pause') && !keysLine().includes('Space'), keysLine(true));
  check('parsing an animated treemap keeps every period', parseReport('treemap', TREE_MONTHS, { animate: true }).periods.length === 3
    && parseReport('treemap', TREE_MONTHS).rows.length === 3, '');
}

{
  const { host, log } = stub();
  await Chart.run('--animate --top 2 bar expenses', host);
  check('the terminal says an animation is one',
    log.said[0] === 'chart: bar, played over 3 periods, 2024-01 to 2024-03, in a new window.' && log.pages[log.pages.length - 1].includes('id="timeline"'), log.said[0]);
}

// ------------------------------------------------------------------ cascaded cards, flows of money, and purchases

{
  const asked = (args) => build(args).command;
  check('the new types ask for what they draw, spending unless an account is named',
    asked('cashflow -p 2026') === 'balance -p 2026 -M --depth 2 -O csv' && asked('budget -p 2026') === 'balance --budget expenses -p 2026 -O csv'
    && asked('swarm -p 2026') === 'register expenses -p 2026 -O csv' && asked('histogram food') === 'register food -O csv'
    && asked('pack expenses') === 'balance --tree expenses -O csv' && asked('--animate pack expenses') === 'balance --tree expenses -M -O csv',
    [asked('cashflow -p 2026'), asked('budget -p 2026'), asked('swarm -p 2026')].join(' | '));
  check('and their related charts carry that default by name',
    related(parse('swarm -p 2026')).map((link) => link.args).join(' ; ') === 'histogram expenses -p 2026 ; calendar expenses -p 2026 ; bar expenses -p 2026',
    related(parse('swarm -p 2026')).map((link) => link.args).join(' ; '));
  check('the new names have aliases', typeOf('beeswarm') === 'swarm' && typeOf('bubbles') === 'pack' && typeOf('bullet') === 'budget', '');
}

{
  // The cascade, on a hand-made layout: a parent whose last child reaches its padded edge is
  // pulled in by twice the offset, as d3's example does.
  const leaf = (x1, y1) => ({ x1, y1, children: null });
  const child = leaf(97, 97);
  const parent = { x1: 100, y1: 100, children: [child, leaf(50, 50)] };
  const fake = {
    eachAfter(visit) { [child, parent.children[1], parent].forEach(visit); return this; },
    eachBefore(visit) { [parent, child, parent.children[1]].forEach(visit); return this; },
  };
  cascade(fake, 3);
  check('a cascade pulls a parent in where its last child meets its edge', parent.x1 === 94 && parent.y1 === 94 && child.x1 === 97, `${parent.x1} ${parent.y1}`);
  check('a card is its branch\'s hue, darker the higher it is in a dark theme, lighter in a light one',
    cardColour('hsl(35 55% 66%)', 0, true) === 'hsl(35 55% 66%)' && cardColour('hsl(35 55% 66%)', 2, true) === 'hsl(35 39% 38%)'
    && cardColour('hsl(35 55% 66%)', 2, false) === 'hsl(35 39% 84%)' && cardColour('#abcdef', 2, true) === '#abcdef', cardColour('hsl(35 55% 66%)', 2, true));
}

{
  const budgetCsv = [
    '"Account","2026-08","budget","2026-09","budget"',
    '"Expenses","12053677.00 IDR, 260 SAR","5810000.00 IDR","10701860.84 IDR","5810000.00 IDR"',
    '"Expenses:Food","2849177.00 IDR","2200000.00 IDR","2444223.00 IDR","2200000.00 IDR"',
    '"Expenses:Fees","53000.00 IDR","50000.00 IDR","34000.00 IDR","50000.00 IDR"',
    '"Expenses:Gifts","900000.00 IDR","","0","0"',
    '"<unbudgeted>","1.00 IDR",""',
    '"Total:","12053677.00 IDR","5810000.00 IDR","10701860.84 IDR","5810000.00 IDR"',
  ].join('\n');
  const budget = readBudget(budgetCsv);
  check('a budget report is each budgeted account\'s spending and budget, summed over its periods',
    budget.rows.length === 3 && budget.rows[1].actual === 5293400 && budget.rows[1].budget === 4400000 && budget.period === '2026-08 to 2026-09'
    && budget.unit.suffix === 'IDR', JSON.stringify(budget.rows.map((row) => [row.label, row.actual, row.budget])));
  check('and names what it could not add up', budget.others.join() === 'SAR', budget.others.join());
  check('a journal with no budget is nothing to chart',
    readBudget('"Account","2024-01-01..2024-02-03","budget"\n"<unbudgeted>","$1333.89",""\n"Total:","$1333.89",""\n') === null, '');
  const view = budgetView(budget);
  check('the top account is the total, said rather than drawn; the furthest over comes first',
    view.rows.map((row) => row.label).join() === 'Expenses:Food,Expenses:Fees' && view.actual === 22755537.84 && view.over === 1, view.rows.map((row) => row.label).join());
  check('the subtitle says how much of the budget went', /^2026-08 to 2026-09: spent 22,755,537\.84 IDR of 11,620,000\.00 IDR budgeted \(196%\); 1 of 2 accounts over$/.test(viewMore('budget', budget).sub),
    viewMore('budget', budget).sub);
}

{
  const flowsReport = read('"account","2024-01","2024-02"\n"expenses:food","$100","$40"\n"expenses:rent","$500","$500"\n"income:salary","$-1000","$-200"\n"assets:bank","$400","$-340"\n');
  const flow = cashflowOf(flowsReport);
  check('cash flow is income turned up, spending, and the net, leaving the other accounts out',
    flow.in.join() === '1000,200' && flow.out.join() === '600,540' && flow.net.join() === '400,-340' && flow.spending.length === 2, JSON.stringify(flow));
  check('and --cumulative runs each total', cashflowOf(flowsReport, { cumulative: true }).net.join() === '400,60', '');
  check('its subtitle says what was kept', /in \$1,200\.00, out \$1,140\.00, net \$60\.00, 5\.0% of income kept/.test(viewMore('cashflow', flowsReport).sub), viewMore('cashflow', flowsReport).sub);
  const many = read(`"account","a"\n${Array.from({ length: 12 }, (_, index) => `"expenses:c${index}","$${index + 1}"`).join('\n')}\n`);
  check('a side with many accounts keeps the largest and folds the rest', cashflowOf(many).spending.length === 8 && cashflowOf(many).spending[7].label === 'other (5)', '');
}

{
  const register = readRegister([
    '"txnidx","date","code","description","account","amount","total"',
    '"1","2026-06-03","","Coffee","Expenses:Food:Coffee","20000.00 IDR","x"',
    '"2","2026-06-04","","Rent","Expenses:Housing","1600000.00 IDR","x"',
    '"3","2026-06-04","","Refund","Expenses:Food","-5000.00 IDR","x"',
    '"4","2026-06-05","","Salary","Income:Salary","-9000000.00 IDR","x"',
    '"5","2026-06-06","","Snack","Expenses:Food:Snacks","15000.00 IDR","x"',
  ].join('\n'));
  const spent = transactionsOf(register);
  check('a swarm draws spending only, refunds left out', spent.count === 3 && spent.total === 1635000 && spent.points.map((point) => point.description).join() === 'Coffee,Rent,Snack',
    spent.points.map((point) => point.description).join());
  check('and keeps only the largest when asked', transactionsOf(register, 2).points.length === 2 && transactionsOf(register, 2).dropped === 1, '');
  check('a posting\'s category is the second part of its account', categoryOf('Expenses:Food:Coffee') === 'Food' && categoryOf('expenses') === 'expenses', '');
  const ys = beeswarm([{ x: 0, r: 10 }, { x: 0, r: 5 }, { x: 0, r: 5 }, { x: 100, r: 5 }]);
  check('a beeswarm puts the largest on the line and the rest beside it without touching',
    ys[0] === 0 && Math.abs(Math.abs(ys[1]) - 16) < 1e-9 && ys[1] === -ys[2] && ys[3] === 0, JSON.stringify(ys));
  const swarm = viewMore('swarm', register);
  check('its table lists the largest first', swarm.table.indexOf('Rent') < swarm.table.indexOf('Coffee') && /^3 transactions, 1,635,000\.00 IDR$/.test(swarm.sub), swarm.sub);
}

{
  const counted = bins([1, 2, 3, 10, 11, 100, 1000, 999]);
  check('a histogram bins four to a decade', counted.bins.length === 13 && counted.bins[0].count === 1 && counted.count === 8 && counted.median === 10,
    JSON.stringify(counted.bins.map((bin) => bin.count)));
  check('and knows what the largest few add up to', Math.abs(counted.topShare - 1000 / 2126) < 1e-9 && counted.topCount === 1, String(counted.topShare));
  const real = [0.6, 1, 2, 5, 9, 30, 100, 180, 320, 500, 600, 700, 800, ...Array.from({ length: 1300 }, (_, index) => 1000 + index * 700)];
  const folded = bins(real);
  check('the smallest one in a hundred share the first bin, so the axis starts where purchases do',
    folded.bins[0].lo === 0 && folded.bins[0].count >= 13 && folded.bins.length <= 14 && folded.count === real.length, `${folded.bins.length} bins, first ${JSON.stringify(folded.bins[0])}`);
  check('a bin edge is a round amount', edge(17782.79, { prefix: '', suffix: 'IDR' }) === '18k IDR' && edge(1e6, { prefix: '$', suffix: '' }) === '$1M', edge(17782.79, { prefix: '', suffix: 'IDR' }));
  check('nothing to count is said so', bins([]).count === 0 && viewMore('histogram', { postings: [], unit: { prefix: '', suffix: '' } }).sub === 'no transactions', '');
}

{
  const { host, log } = stub({ hledger: async () => '"Account","2024-01-01..2024-02-03","budget"\n"<unbudgeted>","$1333.89",""\n' });
  await Chart.run('budget', host);
  check('a budget chart of a journal with no budget says how to set one',
    /has no budget to compare with\. A periodic transaction such as "~ monthly"/.test(log.said[0]), log.said[0]);
  const flows2 = stub();
  await Chart.run('cashflow', flows2.host);
  check('the terminal says what a cash flow kept', /^chart: cashflow, 3 periods: in /.test(flows2.log.said[0]) || /^chart: cashflow, /.test(flows2.log.said[0]), flows2.log.said[0]);
}

// ------------------------------------------------------------------ by payee

{
  check('a payee breakdown is hledger\'s own pivot, passed through', build('bar --pivot payee expenses -p 2026').command === 'balance --pivot payee expenses -p 2026 -O csv', '');
  check('the field a query pivots on is read either way', pivotOf(['--pivot', 'payee']) === 'payee' && pivotOf(['--pivot=desc']) === 'desc' && pivotOf(['expenses']) === null, '');
  check('a click on a payee asks for that payee exactly, keeping the accounts the query named',
    drill(parse('bar --pivot payee expenses -p 2026'), 'Shopee Indonesia') === 'line --pivot payee -p 2026 expenses "payee:^Shopee Indonesia$"',
    drill(parse('bar --pivot payee expenses -p 2026'), 'Shopee Indonesia'));
  check('a payee\'s regular-expression characters are taken literally',
    matchField('payee', 'tiket.com') === 'payee:^tiket\\.com$' && matchField('payee', 'A | B (1)') === 'payee:^A \\| B \\(1\\)$', matchField('payee', 'A | B (1)'));
  check('description, code and note are their own fields, and anything else is a tag',
    matchField('description', 'x') === 'desc:^x$' && matchField('code', 'x') === 'code:^x$' && matchField('trip', 'bali') === 'tag:trip=^bali$', '');
  check('the drilled line is one the plugin builds', !build(drill(parse('bar --pivot payee expenses'), 'tiket.com')).refusal, '');
  const sent = build(drill(parse('bar --pivot payee expenses'), 'tiket.com')).command;
  check('and its backslash survives the trip to hledger, quoted as the app\'s terminal reads it',
    sent === 'balance --pivot payee expenses "payee:^tiket\\\\.com$" -M -O csv' && tokenize(sent)[4] === 'payee:^tiket\\.com$', sent);
  check('a line is split the way the app\'s terminal splits it',
    JSON.stringify(tokenize('a\\ b "c \\"d\\"" \'e\\f\' "g\\nh"')) === JSON.stringify(['a b', 'c "d"', 'e\\f', 'g\\nh']),
    JSON.stringify(tokenize('a\\ b "c \\"d\\"" \'e\\f\' "g\\nh"')));
  check('and every word quote() writes comes back unchanged',
    ['payee:^tiket\\.com$', 'payee:^A \\| B \\(1\\)$', 'last year', 'say "hi"', 'plain', 'a\\\\b'].every((word) => { const back = tokenize(quote(word)); return back.length === 1 && back[0] === word; }), '');
  const payees = read(`"account","balance"\n${Array.from({ length: 60 }, (_, index) => `"payee ${index}","$${60 - index}"`).join('\n')}\n`);
  const bars = modelFor({ report: payees, colors: COLORS, title: 't', kind: 'bar' });
  const slices = modelFor({ report: payees, colors: COLORS, title: 't', kind: 'pie' });
  check('a ranking of many keeps forty and folds the rest, a pie twelve', bars.rows.length === 40 && bars.rows[39].label === 'other (21)'
    && slices.rows.length === 12 && slices.rows[11].label === 'other (49)', `${bars.rows.length} ${slices.rows.length}`);
  check('and --top still asks for more', modelFor({ report: payees, colors: COLORS, title: 't', kind: 'bar', options: { top: 50 } }).rows.length === 51, '');
}

// ------------------------------------------------------------------ reconcile

{
  const data = readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking');
  check('reconcile starts at the last balance assertion, and lists only what is after it',
    data.start.date === '2026-08-31' && data.start.balance === 100000000 && data.rows.length === 6 && data.rows[0].description === 'Coffee', JSON.stringify(data.start));
  check('it reads amounts exactly, in minor units at the commodity\'s precision',
    data.style.precision === 2 && data.rows[0].amount === -2100000 && data.rows[1].amount === 500000000, data.rows.map((row) => row.amount).join());
  check('an inferred amount is read as hledger computed it', data.rows[4].amount === -500000 && data.rows[4].where.occurrence === 1, JSON.stringify(data.rows[4]));
  check('an unmarked posting of an unmarked transaction is unmarked, and a posting\'s own mark is read',
    data.rows[0].status === 'Unmarked' && data.rows[2].status === 'Pending', data.rows.map((row) => row.status).join());
  check('and where each is written: the file and the transaction\'s lines', data.rows[0].where.file === 'fixture.journal' && data.rows[0].where.first === 7 && data.rows[0].where.last === 10, JSON.stringify(data.rows[0].where));
  check('quantities convert to any precision', toMinor({ mantissa: 21000, places: 0 }, 2) === 2100000 && toMinor({ mantissa: 1234567, places: 4 }, 2) === 12346 && toMinor({ mantissa: -15, places: 1 }, 0) === -2, '');

  // A posting is cleared when its own mark says so, or when its transaction is marked and
  // the posting says nothing. hledger agrees: on a journal whose transactions are marked,
  // `register --cleared` lists the postings and `--uncleared` lists none, so reading only
  // the posting's own mark made a window report a year of finished work as still to do.
  {
    const one = (status, postingStatus, at = 1) => ({
      tindex: at, tdate: '2026-09-01', tdescription: `x${at}`, tstatus: status,
      tsourcepos: [{ sourceName: '/f.journal', sourceLine: at * 3 - 2 }, { sourceName: '/f.journal', sourceLine: at * 3 }],
      tpostings: [
        { paccount: 'Assets:Bank:Checking', pstatus: postingStatus, pdate: null, ptags: [], pamount: [{ acommodity: 'IDR', aquantity: { decimalMantissa: -1000, decimalPlaces: 2 }, astyle: { ascommodityside: 'R', ascommodityspaced: true, asdecimalmark: '.', asprecision: 2 } }], pbalanceassertion: null },
        { paccount: 'Expenses:Food', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: [{ acommodity: 'IDR', aquantity: { decimalMantissa: 1000, decimalPlaces: 2 }, astyle: { ascommodityside: 'R', ascommodityspaced: true, asdecimalmark: '.', asprecision: 2 } }], pbalanceassertion: null },
      ],
    });
    const statusOf = (status, postingStatus) => readPrint([one(status, postingStatus)], 'Assets:Bank:Checking').rows[0].status;
    check('a marked transaction clears its postings, which is how most journals are kept',
      statusOf('Cleared', 'Unmarked') === 'Cleared', statusOf('Cleared', 'Unmarked'));
    check('a posting that marks itself keeps its own answer, either way',
      statusOf('Cleared', 'Pending') === 'Pending' && statusOf('Unmarked', 'Cleared') === 'Cleared',
      `${statusOf('Cleared', 'Pending')} ${statusOf('Unmarked', 'Cleared')}`);
    check('and nothing marked stays unmarked', statusOf('Unmarked', 'Unmarked') === 'Unmarked', statusOf('Unmarked', 'Unmarked'));
    // The consequence that matters: a journal kept by marking transactions opens with that
    // work already ticked, so the window shows what is left rather than all of it.
    const marked = readPrint([one('Cleared', 'Unmarked', 1), one('Cleared', 'Unmarked', 2)], 'Assets:Bank:Checking');
    const ticked = new Set(marked.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
    check('so a journal kept that way opens with its finished work already ticked',
      ticked.size === marked.rows.length && summarize({ data: marked, ticked, statementDate: '2026-09-30', statementBalance: 9800000 }).outstanding.length === 0,
      `${ticked.size} of ${marked.rows.length}`);
  }

  const style = data.style;
  check('an amount is written for the journal without grouping, and read with it',
    journalAmount(66409201, style) === '664092.01 IDR' && readable(66409201, style) === '664,092.01 IDR'
    && journalAmount(-500, { ...style, side: 'L', spaced: false, commodity: '$' }) === '$-5.00' && journalAmount(7, { ...style, commodity: 'PGDN GOLD' }) === '0.07 "PGDN GOLD"', journalAmount(66409201, style));
  check('a typed balance is read whatever the grouping', parseInput('664,092.01', style) === 66409201 && parseInput('664092', style) === 66409200
    && parseInput('1.234.567,89 IDR', style) === 123456789 && parseInput('-50', style) === -5000 && parseInput('', style) === null, String(parseInput('1.234.567,89 IDR', style)));

  const ids = (indexes) => new Set(indexes.map((index) => data.rows[index].id));
  const statement = (ticked, balance, date = '2026-09-30') => summarize({ data, ticked, statementDate: date, statementBalance: balance });
  const all = statement(ids([0, 1, 2, 3, 4]), 567000000);
  check('the difference is the statement less the opening and the ticks, and later postings do not count',
    all.expected === 567000000 && all.difference === 0 && all.later === 1 && all.canFinish, JSON.stringify({ expected: all.expected, difference: all.difference }));
  const short = statement(ids([0, 1, 3, 4]), 567000000);
  check('an unticked posting on or before the date stops the finish: an assertion counts every posting',
    short.difference === -30000000 && !short.canFinish && short.outstanding.length === 1, JSON.stringify(short.outstanding.map((row) => row.id)));
  const fit = statement(ids([0, 1, 3, 4]), 597000000);
  check('even at a difference of zero', fit.difference === 0 && !fit.canFinish && fit.outstanding.length === 1, '');
  check('and a statement before the opening assertion is refused', statement(ids([]), 0, '2026-08-01').tooEarly && !statement(ids([]), 100000000, '2026-08-01').canFinish, '');

  const found = hints(data.rows.slice(0, 5), ids([0, 1, 3, 4]), 30000000 * -1, style);
  check('a posting that is exactly the difference is pointed at', found.some((hint) => hint.id === data.rows[2].id && /not ticked, and exactly the difference/.test(hint.reason)), JSON.stringify(found));
  check('so is a ticked one of half the difference, and a difference that divides by nine',
    hints(data.rows, ids([0]), 4200000, style).some((hint) => /half the difference/.test(hint.reason))
    && hints(data.rows, ids([]), 1800, style).some((hint) => hint.id === null && /divides by 9/.test(hint.reason)), '');
  check('and no difference, no hints', hints(data.rows, ids([]), 0, style).length === 0, '');

  check('a mark is set and taken off without moving the amounts',
    remark('    Assets:Bank    -21000 IDR', '*') === '  * Assets:Bank    -21000 IDR' && remark('  * Assets:Bank    -21000 IDR', '') === '    Assets:Bank    -21000 IDR'
    && remark('  ! Assets:Bank', '*') === '  * Assets:Bank' && remark('\tAssets:Bank', '*') === '  * Assets:Bank', remark('\tAssets:Bank', '*'));
  check('the assertion is its own transaction of nothing, asserting',
    assertionText('2026-09-30', 'Assets:Bank:Checking', 567000000, style) === '2026-09-30 * Reconciled with statement\n    Assets:Bank:Checking    0.00 IDR = 5670000.00 IDR\n'
    && assertionText('2026-09-30', 'Assets:Bank', 0, style, true).includes(' =* '), assertionText('2026-09-30', 'Assets:Bank:Checking', 567000000, style));

  const done = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: ids([0, 1, 2, 3, 4]), finish: { date: '2026-09-30', balance: 567000000 } });
  const file = done.files[0];
  check('finishing marks exactly the ticked postings, on their own lines',
    file.changes.map((change) => change.line).join() === '9,12,17,22,23' && file.changes.every((change) => /^  \* Assets:Bank:Checking/.test(change.after)) && !done.missing.length,
    JSON.stringify(file.changes.map((change) => [change.line, change.after])));
  const original = RECONCILE_JOURNAL.split('\n');
  check('and leaves every other line as it was', original.filter((line, index) => line !== file.after.split('\n')[index]).length === 5, '');
  check('and appends the assertion at the end', file.after.endsWith('\n2026-09-30 * Reconciled with statement\n    Assets:Bank:Checking    0.00 IDR = 5670000.00 IDR\n'), JSON.stringify(file.after.slice(-120)));
  const progress = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: ids([0]), finish: null });
  check('saving progress marks the ticks and writes no assertion', progress.files[0].changes.length === 1 && !progress.files[0].appended, '');
  const marked = readPrint(RECONCILE_PRINT.map((transaction) => (transaction.tindex === 2 ? { ...transaction, tpostings: transaction.tpostings.map((posting) => (posting.paccount === 'Assets:Bank:Checking' ? { ...posting, pstatus: 'Cleared' } : posting)) } : transaction)), 'Assets:Bank:Checking');
  const undo = plan({ data: marked, texts: { 'fixture.journal': RECONCILE_JOURNAL.replace('\n    Assets:Bank:Checking\n\n2026-09-02', '\n  * Assets:Bank:Checking\n\n2026-09-02') }, ticked: new Set(), finish: null });
  check('an unticked posting that was marked has its mark taken off, and a pending one stays pending',
    undo.files[0].changes.length === 1 && undo.files[0].changes[0].after === '    Assets:Bank:Checking', JSON.stringify(undo.files[0].changes));
  const lost = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL.replace('Assets:Bank:Checking    5000000.00 IDR', 'Assets:Moved    5000000.00 IDR') }, ticked: ids([1]), finish: null });
  check('a line that is not where hledger said is reported, not guessed', lost.missing.length === 1 && /not found/.test(lost.missing[0].why), JSON.stringify(lost.missing));
  check('a generated posting is never written', plan({ data: { ...data, rows: [{ ...data.rows[0], generated: true }] }, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: ids([0]) }).missing.length === 1, '');

  check('a search finds by description, account and amount, grouping aside',
    matching(data.rows, 'coffee', style).length === 1 && matching(data.rows, 'income', style).length === 1 && matching(data.rows, '21000', style).length === 1 && matching(data.rows, '21,000', style).length === 1, '');

  // Moving a transaction changes its date, on its own first line. Nothing has to move in the
  // file, so a move cannot overlap the block that a mark, an edit or an assertion rewrites; the
  // tests below hold it to that by combining a move with each of them.
  const texts = { 'fixture.journal': RECONCILE_JOURNAL };
  const coffee = data.rows[0];
  const salary = data.rows[1];
  const written = (result) => result.files[0] || { changes: [], after: '', replaced: [], inserted: [], appended: '' };
  const alone = written(plan({ data, texts, ticked: new Set(), moved: { [coffee.id]: '2026-09-04' } }));
  check('a move rewrites the date on the transaction line and nothing else',
    alone.changes.length === 1 && alone.changes[0].before === '2026-09-01 * Coffee'
    && alone.changes[0].after === '2026-09-04 * Coffee', JSON.stringify(alone.changes));

  const withMark = written(plan({ data, texts, ticked: new Set([coffee.id]), moved: { [coffee.id]: '2026-09-04' } }));
  check('a move and a mark on the same transaction both land, neither dropped nor doubled',
    withMark.changes.length === 2
    && withMark.changes.some((change) => change.after === '2026-09-04 * Coffee')
    && withMark.changes.some((change) => /^ {2}\* Assets:Bank:Checking/.test(change.after)),
    JSON.stringify(withMark.changes));

  const withEdit = written(plan({ data, texts, ticked: new Set(), edits: { [coffee.id]: { text: '2026-09-01 * Coffee beans\n    Expenses:Food    25000 IDR\n    Assets:Bank:Checking' } }, moved: { [coffee.id]: '2026-09-04' } }));
  check('a move rewrites the date of an edited transaction too, keeping the edit',
    withEdit.after.includes('2026-09-04 * Coffee beans') && withEdit.after.includes('25000 IDR'),
    withEdit.after.split('\n').slice(6, 10).join(' | '));

  const withInsert = written(plan({ data, texts, ticked: new Set(), moved: { [coffee.id]: '2026-09-04' }, inserts: [{ id: 'new:1', text: '2026-09-02 * Fee\n    Assets:Bank:Checking    -1000 IDR\n    Expenses:Fees', after: salary.id }] }));
  const insertedText = withInsert.after.includes('2026-09-02 * Fee');
  check('a move beside an insertion leaves both in the file',
    insertedText && withInsert.changes.some((change) => change.after === '2026-09-04 * Coffee')
    && withInsert.inserted.length === 1, `${insertedText} ${JSON.stringify(withInsert.changes)}`);

  const withDelete = written(plan({ data, texts, ticked: new Set(), edits: { [salary.id]: { text: '' } }, moved: { [coffee.id]: '2026-09-04' } }));
  check('a move beside a deletion deletes that transaction and moves only the other',
    !withDelete.after.includes('* Salary') && withDelete.after.includes('2026-09-04 * Coffee')
    && withDelete.replaced.length === 1, JSON.stringify(withDelete.replaced));

  // Hiding already-cleared rows is a view, not a recalculation. The balances are worked out over
  // every posting first, so a hidden row still counts towards the balance of the row below it.
  {
    const all = ordered(data);
    const cleared = new Set(all.filter((row) => row.status === 'Cleared').map((row) => row.id));
    const view = visibleRows(all, { hide: true, cleared });
    check('hiding a cleared row leaves the balance of the rows below it untouched',
      view.hidden.length === 0 && view.shown.length === all.length, `${view.hidden.length} hidden of ${all.length}`);
    // Mark two of the six cleared, so they would be hidden, and check the arithmetic downstream.
    const marked = ordered(readPrint(RECONCILE_PRINT.map((transaction) => (
      transaction.tindex === 2 || transaction.tindex === 3 ? { ...transaction, tstatus: 'Cleared' } : transaction
    )), 'Assets:Bank:Checking'));
    const markedView = visibleRows(marked, { hide: true, cleared: new Set(marked.filter((row) => row.status === 'Cleared').map((row) => row.id)) });
    check('a hidden cleared row still contributes to the next visible row\'s running balance',
      markedView.hidden.length === 2 && markedView.shown.length === 4
      && markedView.shown[0].balance === markedView.hidden[markedView.hidden.length - 1].balance + markedView.shown[0].amount
      && markedView.hiddenFrom === '2026-09-01' && markedView.hiddenTo === '2026-09-02',
      `${markedView.hidden.length} hidden, first shown balance ${markedView.shown[0] && markedView.shown[0].balance}`);
    // Ticking or typing on a row keeps it in view, so nothing vanishes under the hand or is lost.
    const keptView = visibleRows(marked, { hide: true, cleared: new Set(marked.filter((row) => row.status === 'Cleared').map((row) => row.id)), touched: new Set([marked[0].id]) });
    check('a row that was touched stays visible, and a search shows everything',
      keptView.hidden.length === 1 && keptView.shown.includes(marked[0])
      && visibleRows(marked, { hide: true, cleared: new Set(marked.map((row) => row.id)), searching: true }).hidden.length === 0, '');
    check('and hiding off shows everything', visibleRows(marked, { hide: false, cleared: new Set(marked.map((row) => row.id)) }).hidden.length === 0, '');
  }

  // A move must not date a posting before the point the balance was asserted at: the assertion
  // says what the balance was that day, and a posting before it would be one it failed to count.
  check('a move may not land before the asserted balance, and later dates are allowed',
    moveRefusal(data, '2026-08-30') === 'before 2026-08-31, where this account is already asserted'
    && moveRefusal(data, '2026-08-31') === null && moveRefusal(data, '2026-09-04') === null
    && moveRefusal(data, '2027-01-01') === null && moveRefusal({ ...data, start: null }, '1999-01-01') === null,
    `${moveRefusal(data, '2026-08-30')} / ${moveRefusal(data, '2026-08-31')}`);

  // Un-ticking a posting that was only cleared by its transaction. Removing a mark it never had
  // would leave it cleared, so Save would report nothing and the row would come back ticked.
  const clocked = readPrint(RECONCILE_PRINT.map((transaction) => (transaction.tindex === 2 ? { ...transaction, tstatus: 'Cleared' } : transaction)), 'Assets:Bank:Checking');
  const unticked = written(plan({ data: clocked, texts, ticked: new Set(), finish: null }));
  check('un-ticking a posting cleared by its transaction writes pending, so it is really not cleared',
    unticked.changes.length === 1 && unticked.changes[0].before === '    Assets:Bank:Checking'
    && unticked.changes[0].after === '  ! Assets:Bank:Checking', JSON.stringify(unticked.changes));
  check('and that mark reads back as pending, so Save and the re-read agree',
    readPrint([{ ...RECONCILE_PRINT[1], tstatus: 'Cleared', tpostings: RECONCILE_PRINT[1].tpostings.map((posting) => (posting.paccount === 'Assets:Bank:Checking' ? { ...posting, pstatus: 'Pending' } : posting)) }], 'Assets:Bank:Checking').rows[0].status === 'Pending', '');
}

{
  // The example from the request: three purchases, each with the statement's running balance.
  const data = {
    account: 'Assets:Bank', inclusive: false, commodity: 'IDR', others: [], start: { date: '2025-12-31', balance: 30000000, description: 'opening' },
    style: { commodity: 'IDR', side: 'R', spaced: true, decimal: '.', precision: 2 },
    rows: [
      { id: 'a', date: '2026-01-01', description: 'Buy ABCD', amount: -10000000, status: 'Unmarked', against: 'Expenses:Stuff', where: { file: 'x', first: 1, last: 4, occurrence: 0 } },
      { id: 'b', date: '2026-01-01', description: 'Buy food', amount: -5000000, status: 'Unmarked', against: 'Expenses:Food', where: { file: 'x', first: 5, last: 8, occurrence: 0 } },
      { id: 'c', date: '2026-01-01', description: 'Buy drinks', amount: -5000000, status: 'Unmarked', against: 'Expenses:Food', where: { file: 'x', first: 9, last: 12, occurrence: 0 } },
    ],
  };
  const rows = ordered(data);
  check('each posting has the running balance after it, as a statement prints it',
    rows.map((row) => row.balance).join() === '20000000,15000000,10000000', rows.map((row) => row.balance).join());
  const typed = checkpoints(rows, { a: 20000000, b: 15000000, c: 9500000 });
  check('a typed statement balance shows the difference at that line, and the first that is off',
    typed.points.map((point) => point.difference).join() === '0,0,-500000' && typed.first.id === 'c', JSON.stringify(typed));
  const part = partHint(rows, typed, data.style);
  check('and says where they part, offering to add what the statement has',
    /part at 2026-01-01 Buy drinks, by -5,000\.00 IDR/.test(part.text) && part.amount === -500000 && part.id === null, part.text);
  const extra = partHint(rows, checkpoints(rows, { a: 20000000, c: 15000000 }), data.style);
  check('or points at a posting that is exactly the difference', extra.id === 'b' && /Buy food \(-50,000\.00 IDR\) is exactly that/.test(extra.text), extra.text);
  check('with nothing typed, nothing is said', partHint(rows, checkpoints(rows, {}), data.style) === null, '');
  const edited = ordered(data, { edits: { b: { text: '2026-01-01 Buy food (corrected)\n    Expenses:Food    45000 IDR\n    Assets:Bank' } }, inserts: [{ id: 'new:1', text: '2026-01-01 Fee\n    Assets:Bank    -1000 IDR\n    Expenses:Fees' }] });
  check('an edit and a new posting change the running balances, the new one after the day\'s others',
    edited.map((row) => `${row.id}:${row.balance}`).join() === 'a:20000000,b:15500000,c:10500000,new:1:10400000' && edited[1].edited && edited[3].inserted,
    edited.map((row) => `${row.id}:${row.balance}`).join());
  check('and so does the statement difference', summarize({ data, ticked: new Set(['a', 'b', 'c', 'new:1']), statementDate: '2026-01-31', statementBalance: 10400000, edits: { b: { text: '2026-01-01 Buy food\n    Expenses:Food    45000 IDR\n    Assets:Bank' } }, inserts: [{ id: 'new:1', text: '2026-01-01 Fee\n    Assets:Bank    -1000 IDR\n    X' }] }).difference === 0, '');
}

{
  // A real journal has postings with no commodity in them, and naming one in the summary left
  // an empty name in the window's sentence: "postings in  are not part of this".
  const amount = (commodity, mantissa) => ({ acommodity: commodity, aquantity: { decimalMantissa: mantissa, decimalPlaces: 2 }, astyle: { ascommodityside: 'R', ascommodityspaced: true, asdecimalmark: '.', asprecision: 2 } });
  const transaction = (index, commodities) => ({
    tindex: index, tdate: `2026-07-0${(index % 9) + 1}`, tdescription: `Number ${index}`, tstatus: 'Unmarked',
    tsourcepos: [{ sourceName: '/fixture.journal', sourceLine: index * 3 }, { sourceName: '/fixture.journal', sourceLine: index * 3 + 2 }],
    tpostings: [
      { paccount: 'Assets:Bank', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: commodities.map(([name, mantissa]) => amount(name, mantissa)), pbalanceassertion: null },
      { paccount: 'Expenses:Food', pstatus: 'Unmarked', pdate: null, ptags: [], pamount: [amount('IDR', -1000)], pbalanceassertion: null },
    ],
  });
  const mixed = readPrint([transaction(1, [['IDR', 1000]]), transaction(2, [['IDR', 1000], ['', 5]]), transaction(3, [['IDR', 1000], ['USD', 900]])], 'Assets:Bank');
  check('a posting with no commodity is not reported as another commodity',
    mixed.others.join() === 'USD' && !mixed.others.includes(''), JSON.stringify(mixed.others));

  // Finding which transactions an edit speaks for is done once, not by rescanning every row for
  // every row: on an account with thousands of postings that scan made a tick take seconds.
  const many = Array.from({ length: 3000 }, (_, index) => transaction(index + 1, [['IDR', 1000]]));
  const big = readPrint(many, 'Assets:Bank');
  const began = performance.now();
  const listed = ordered(big, {});
  const spent = performance.now() - began;
  check('a few thousand postings are ordered quickly, so a tick is not a wait',
    listed.length === 3000 && spent < 500, `${Math.round(spent)}ms for ${listed.length} rows`);
}

{
  check('a transaction header is read in its parts and written back exactly',
    formatHeader(parseHeader('2026-09-05=2026-09-06 * (123) Shop | lunch  ; note: x')) === '2026-09-05=2026-09-06 * (123) Shop | lunch  ; note: x'
    && parseHeader('2026-09-05 * Shop  ; c').description === 'Shop' && formatHeader({ ...parseHeader('2026-09-05 Shop'), date: '2026-09-07' }) === '2026-09-07 Shop', '');
  const parts = parsePosting('  * Assets:Bank    -21000 IDR  ; why');
  check('a posting line is read in its parts', parts.mark === '*' && parts.account === 'Assets:Bank' && parts.amount === '-21000 IDR' && parts.comment === '; why'
    && parsePosting('    (Budget:Food)').account === 'Budget:Food' && parsePosting('    ; just a comment') === null, JSON.stringify(parts));
  check('an account name ends at two spaces or a tab, whatever its length, and keeps its single spaces',
    parsePosting('    A    5 IDR').account === 'A' && parsePosting('    A    5 IDR').amount === '5 IDR' && parsePosting('    equity:opening balances  -5 IDR').account === 'equity:opening balances'
    && parsePosting('\tAssets:Bank\t-5 IDR').amount === '-5 IDR' && parsePosting('    [Savings:Goal]    5 IDR').open === '[', JSON.stringify(parsePosting('    A    5 IDR')));
  check('and written back with its amount ending where the transaction\'s others do, its comment kept',
    formatPosting({ ...parts, amount: '-25000.00 IDR' }, 40) === '  * Assets:Bank' + ' '.repeat(40 - 15 - 13) + '-25000.00 IDR  ; why'
    && formatPosting({ ...parsePosting('    Assets:Bank'), mark: '*' }, 0, parsePosting('    Assets:Bank')) === '  * Assets:Bank', formatPosting({ ...parts, amount: '-25000.00 IDR' }, 40));
  const style = { commodity: 'IDR', side: 'R', spaced: true, decimal: '.', precision: 2 };
  check('a new posting starts from a template: the date, a description to write, the account and its amount',
    template('2026-09-05', 'Assets:Bank', -650000, style) === '2026-09-05 \n    Assets:Bank    -6500.00 IDR\n    ' && template('2026-09-05', 'Assets:Bank', null, style).endsWith('Assets:Bank    \n    '), '');
  check('an amount is read as it is written, in the account\'s commodity only',
    readAmount('-21,000.00 IDR', style) === -2100000 && readAmount('21000 IDR', style) === 2100000 && readAmount('-5 IDR = 100 IDR', style) === -500
    && readAmount('10 USD @ 15000 IDR', style) === null && readAmount('IDR 5', style) === 500 && readAmount('$5', style) === null && readAmount('', style) === null, '');
  const typed = readTransaction('2026-09-01 * Coffee and cake  ; c\n    Expenses:Coffee    15000 IDR\n    Expenses:Cake     9000 IDR  ; birthday\n    ; a note\n    Assets:Bank', 'Assets:Bank', style);
  check('a transaction written by hand is read for the account: date, description, and an amount left out worked out',
    typed.date === '2026-09-01' && typed.description === 'Coffee and cake' && typed.amount === -2400000 && typed.against === 'Expenses:Coffee, Expenses:Cake', JSON.stringify(typed));
  check('two amounts left out, or one in another commodity, cannot be worked out without hledger',
    readTransaction('2026-09-01 x\n    A    5 IDR\n    Assets:Bank\n    B', 'Assets:Bank', style).amount === null
    && readTransaction('2026-09-01 x\n    A    5 USD\n    Assets:Bank', 'Assets:Bank', style).amount === null
    && readTransaction('2026-09-01 x\n    A    5 IDR\n    (Budget)    3 IDR\n    Assets:Bank', 'Assets:Bank', style).amount === -500, '');
  check('a transaction that does not balance, or has one posting, is noticed before hledger',
    readTransaction('2026-09-01 x\n    A    5 IDR\n    Assets:Bank    -4 IDR', 'Assets:Bank', style).off === 100 && readTransaction('2026-09-01 x\n    Assets:Bank    -4 IDR\n    ', 'Assets:Bank', style).postings === 1
    && readTransaction('2026-09-01 x\n    A    5 IDR\n    Assets:Bank', 'Assets:Bank', style).off === 0, '');
  check('and a text with no date line, or no posting to the account, says so', !readTransaction('just words', 'Assets:Bank', style).header && !readTransaction('2026-09-01 x\n    A  1 IDR\n    B', 'Assets:Bank', style).touches, '');

  const data = readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking');
  const [coffee, salary, pending, split, splitTwo] = data.rows;
  const edits = {
    [coffee.id]: { text: '2026-09-01 * Coffee and a cake  ; bought together\n    Expenses:Food:Coffee    15000 IDR\n    Expenses:Food:Cake       9000 IDR  ; birthday\n    Assets:Bank:Checking' },
    [pending.id]: { text: '' },
  };
  const inserts = [{ id: 'new:1', after: salary.id, text: '2026-09-02 Transfer fee\n    Assets:Bank:Checking    -6500 IDR\n    Expenses:Fees' }];
  const rowsNow = ordered(data, { edits, inserts });
  check('an edited transaction is read from its text, a deleted one is gone, and a new one sits after the posting it was added beside',
    rowsNow.map((row) => `${row.description}:${row.balance}`).join() === 'Coffee and a cake:97600000,Salary:597600000,Transfer fee:596950000,Split:596550000,Split:596050000,After the statement:595800000',
    rowsNow.map((row) => `${row.description}:${row.balance}`).join());
  const expected = { [coffee.id]: rowsNow[0].balance, 'new:1': rowsNow[2].balance, [split.id]: 1 };
  const done = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: new Set([coffee.id, 'new:1']), edits, inserts, expected });
  const after = done.files[0].after;
  check('an edit replaces the transaction\'s lines with its text, the account\'s posting ticked and its worked-out amount asserted',
    after.includes('2026-09-01 * Coffee and a cake  ; bought together\n    Expenses:Food:Coffee    15000 IDR\n    Expenses:Food:Cake       9000 IDR  ; birthday\n  * Assets:Bank:Checking  -24000.00 IDR = 976000.00 IDR\n') && done.files[0].replaced.length === 2,
    JSON.stringify(after.split('\n').slice(5, 11)));
  check('an emptied transaction is deleted, leaving no double blank line', !after.includes('Pending transfer') && !after.includes('\n\n\n'), '');
  check('a new one is written straight after the transaction it was added beside, ticked and asserted',
    after.includes('2026-09-02 * Salary\n    Assets:Bank:Checking    5000000.00 IDR\n    Income:Salary\n\n2026-09-02 Transfer fee\n  * Assets:Bank:Checking  -6500 IDR = 5969500.00 IDR\n    Expenses:Fees\n'), JSON.stringify(after.split('\n').slice(10, 18)));
  check('a typed running balance that does not match is not written', !after.includes('= 0.01 IDR') && done.missing.length === 0 && done.asserted === 2, JSON.stringify(done.missing));
  const unknown = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: new Set(), edits: { [coffee.id]: { text: '2026-09-01 x\n    A    5 USD\n    Assets:Bank:Checking' } }, expected: { [coffee.id]: 1 } });
  check('an edit whose amount cannot be read is written, and its balance not asserted', unknown.files[0].changes.length === 2 && unknown.asserted === 0 && !unknown.missing.length, JSON.stringify(unknown.files[0].changes));
  check('nor counted: the balances after it are unknown until hledger reads it',
    ordered(data, { edits: { [coffee.id]: { text: '2026-09-01 x\n    A    5 USD\n    Assets:Bank:Checking' } } }).every((row) => row.balance === null)
    && summarize({ data, ticked: new Set(), statementDate: '2026-09-30', statementBalance: 0, edits: { [coffee.id]: { text: '2026-09-01 x\n    A    5 USD\n    Assets:Bank:Checking' } } }).difference === null, '');
  const both = ordered(data, { edits: { [splitTwo.id]: { text: '2026-09-05 * Split\n    Expenses:Food    9000 IDR\n    Assets:Bank:Checking' } } });
  check('editing one posting of a transaction with two to the account edits it all, as one row', both.filter((row) => row.description === 'Split').length === 1 && both.find((row) => row.description === 'Split').amount === -900000, '');
  const moved = plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL.replace('2026-09-01 * Coffee', 'something else') }, ticked: new Set([coffee.id]) });
  check('a transaction not where hledger said is reported, not guessed', /not where hledger said/.test(moved.missing[0].why), JSON.stringify(moved.missing));
  check('a new transaction without a date line is not written', /needs a first line with its date/.test(plan({ data, texts: { 'fixture.journal': RECONCILE_JOURNAL }, ticked: new Set(), inserts: [{ id: 'new:2', text: 'no date here' }] }).missing[0].why), '');
}


{
  check('reconcile reads an account and its flags', JSON.stringify(parseLine('mandiri --statement 2026-09-30 --balance "664,092.01"'))
    === JSON.stringify({ account: 'mandiri', statement: '2026-09-30', balance: '664,092.01', commodity: null }), JSON.stringify(parseLine('mandiri --statement 2026-09-30 --balance "664,092.01"')));
  check('and says what is wrong with a line', /^which account\?/.test(parseLine('').error) && /--wat is not something reconcile takes/.test(parseLine('x --wat').error)
    && /one account at a time/.test(parseLine('a b').error) && /--statement takes a date/.test(parseLine('a --statement 30/9').error), '');
  const accounts = ['Assets:Mandiri', 'Assets:Mandiri:Now5782', 'Assets:BCADigital', 'Assets:BCADigital:Saving4139', 'Assets:BNI:Taplus8650', 'Assets:Cash'];
  check('an account is found by any part of its name, case aside, preferring the top of a branch',
    resolveAccount('assets:cash', accounts).account === 'Assets:Cash' && resolveAccount('now5782', accounts).account === 'Assets:Mandiri:Now5782'
    && resolveAccount('mandiri', accounts).account === 'Assets:Mandiri', JSON.stringify(resolveAccount('mandiri', accounts)));
  check('and several or none is said', /matches 2 accounts: Assets:BCADigital, Assets:BNI:Taplus8650/.test(resolveAccount('b', accounts.filter((name) => !name.includes('Mandiri') && name !== 'Assets:Cash')).error || '')
    && /no account matches zzz/.test(resolveAccount('zzz', accounts).error), resolveAccount('b', accounts.filter((name) => !name.includes('Mandiri') && name !== 'Assets:Cash')).error);
}

/**
 * A host whose files are real text: `save` changes what the next `hledger` sees, and hledger is
 * stood in for by what the fixture prints, plus an assertion check done the way hledger does it,
 * over every posting up to the assertion's date.
 */
function reconcileHost({ writable = true, failBefore = false, failSave = false } = {}) {
  const log = { said: [], pages: [], saved: [], asked: [] };
  const files = { 'fixture.journal': RECONCILE_JOURNAL };
  const assertionsHold = (text) => {
    const balance = (until) => 100000000 + [[-2100000, '2026-09-01'], [500000000, '2026-09-02'], [-30000000, '2026-09-03'], [-900000, '2026-09-05'], [-250000, '2026-10-02']]
      .filter(([, date]) => date <= until).reduce((sum, [amount]) => sum + amount, 0);
    const asserted = [...text.matchAll(/^(\d{4}-\d{2}-\d{2}) \* Reconciled with statement\n {4}Assets:Bank:Checking {4}0\.00 IDR = ([\d.]+) IDR$/gm)];
    return asserted.every(([, date, amount]) => Math.round(Number(amount) * 100) === balance(date));
  };
  const host = {
    name: 'reconcile',
    colors: () => COLORS,
    say: (text) => log.said.push(text),
    files: () => [{ path: 'fixture.journal', writable, main: true }],
    read: (path) => files[path] ?? null,
    window: () => ({ write: (html) => log.pages.push(html), close() {} }),
    async save(path, text) {
      if (failSave) return { error: 'the file changed on disk' };
      files[path] = text;
      log.saved.push(path);
      return { ok: true };
    },
    async hledger(command) {
      log.asked.push(command);
      if (command === 'accounts') return 'Assets:Bank:Checking\nAssets:Savings\nEquity:Opening\nExpenses:Fees\nExpenses:Food\nIncome:Salary\n';
      if (command.startsWith('print')) {
        // What hledger prints for the file as it is now: marks the plugin wrote are read back.
        const lines = files['fixture.journal'].split('\n');
        return JSON.stringify(RECONCILE_PRINT.map((transaction) => ({
          ...transaction,
          tpostings: transaction.tpostings.map((posting, index) => {
            // A transaction's posting lines, without its comment lines.
            const own = lines.slice(transaction.tsourcepos[0].sourceLine, transaction.tsourcepos[1].sourceLine - 1).filter((text) => !text.trim().startsWith(';'));
            const line = own[index] || '';
            const mark = /^ {2}([*!]) /.exec(line);
            return { ...posting, pstatus: mark ? (mark[1] === '*' ? 'Cleared' : 'Pending') : 'Unmarked' };
          }),
        })));
      }
      if (command.startsWith('balance')) {
        if (failBefore || !assertionsHold(files['fixture.journal'])) throw new Error('Balance assertion failed in Assets:Bank:Checking');
        return '"account","balance"\n';
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return { host, log, files };
}

{
  const { host, log, files } = reconcileHost();
  await Reconcile.run('checking --statement 2026-09-30', host);
  check('reconcile finds the account and reads it with an exact query', log.asked.includes("print \"acct:^Assets:Bank:Checking$\" -O json") || log.asked.includes('print acct:^Assets:Bank:Checking$ -O json'),
    log.asked.join(' | '));
  check('and says what it opened', log.said[0] === 'reconcile: 6 postings of Assets:Bank:Checking in IDR since the balance asserted on 2026-08-31, in a new window.', log.said[0]);
  const html = log.pages[log.pages.length - 1];
  check('the window carries the postings, the statement date, and its token', html.includes('"statementDate":"2026-09-30"') && html.includes('reconcile-window.js') && /"token":"reconcile-/.test(html), '');
  const token = /"token":"([^"]+)"/.exec(html)[1];
  const link = globalThis.__reconcileBridges[token];
  const shownPrint = /"fingerprint":"([^"]*)"/.exec(html)[1];
  const rows = readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking').rows;
  const all = rows.slice(0, 5).map((row) => row.id);
  const preview = await link.preview({ ticked: all, finish: { date: '2026-09-30', balance: 567000000 }, fingerprint: shownPrint });
  check('a preview carries the assertion on its own too', preview.assertion.endsWith('= 5670000.00 IDR\n'), preview.assertion);
  check('a preview says what would change, and writes nothing', preview.files[0].changes.length === 5 && preview.files[0].appended.includes('= 5670000.00 IDR') && !log.saved.length, '');
  const wrong = await link.apply({ ticked: all, finish: { date: '2026-09-30', balance: 567100000 }, fingerprint: shownPrint });
  check('an assertion hledger refuses is put back: the file is as it was', /hledger refused the result, so the files were put back/.test(wrong.error || '') && files['fixture.journal'] === RECONCILE_JOURNAL,
    wrong.error);
  const right = await link.apply({ ticked: all, finish: { date: '2026-09-30', balance: 567000000 }, fingerprint: shownPrint });
  check('a right one is written, marks and assertion, and checked', right.ok && files['fixture.journal'].includes('  * Assets:Bank:Checking    5000000.00 IDR')
    && files['fixture.journal'].endsWith('    Assets:Bank:Checking    0.00 IDR = 5670000.00 IDR\n') && /reconciled to 2026-09-30: 5 lines changed, and the statement balance asserted/.test(log.said[log.said.length - 1]), right.error || '');
  check('and the window is handed the account as it is now, with a new fingerprint', right.data.rows.filter((row) => row.status === 'Cleared').length === 5 && right.fingerprint !== shownPrint, '');
  const stale = await link.apply({ ticked: all, finish: null, fingerprint: shownPrint });
  check('a window drawn from an older journal is refused and read again', /changed since this window was drawn/.test(stale.error || '') && stale.data, stale.error);
}

{
  // A transaction rewritten as text, and one emptied, through the plugin's own save.
  const { host, log, files } = reconcileHost();
  await Reconcile.run('checking', host);
  const link = Object.values(globalThis.__reconcileBridges).pop();
  const rows = readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking').rows;
  const edits = {
    [rows[0].id]: { text: '2026-09-01 * Coffee  ; checked\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking' },
    [rows[5].id]: { text: '' },
  };
  const answer = await link.apply({ ticked: [], finish: null, edits, fingerprint: fingerprint(readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking')) });
  check('a rewritten and a deleted transaction are written, and said in the terminal',
    answer.ok && /saved, 1 line changed, 1 deleted/.test(log.said[log.said.length - 1]) && files['fixture.journal'].includes('2026-09-01 * Coffee  ; checked') && !files['fixture.journal'].includes('After the statement'),
    log.said[log.said.length - 1]);
  const preview = link.preview({ ticked: [], finish: null, edits: { [rows[3].id]: { text: '2026-09-05 * Split\n    Expenses:Food    9000 IDR\n    Assets:Bank:Checking' } } });
  check('and a preview lists a transaction whose length changed as rewritten', preview.files[0].replaced.length === 1 && /Split/.test(preview.files[0].replaced[0].after), JSON.stringify(preview.files[0]));
}

{
  const { host, files } = reconcileHost({ writable: false });
  await Reconcile.run('checking', host);
  const link = Object.values(globalThis.__reconcileBridges).pop();
  const printed = fingerprint(readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking'));
  const answer = await link.apply({ ticked: [readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking').rows[0].id], finish: null, fingerprint: printed });
  check('a file not from an opened folder is never written', /cannot be written: it did not come from an opened folder/.test(answer.error || '') && files['fixture.journal'] === RECONCILE_JOURNAL, answer.error);
}

{
  const { host, files } = reconcileHost({ failBefore: true });
  await Reconcile.run('checking', host);
  const link = Object.values(globalThis.__reconcileBridges).pop();
  const answer = await link.apply({ ticked: [readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking').rows[0].id], finish: null, fingerprint: fingerprint(readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking')) });
  check('a journal hledger already rejects is not written to', /already reports a problem, so nothing was written/.test(answer.error || '') && files['fixture.journal'] === RECONCILE_JOURNAL, answer.error);
}

{
  const { host, log } = reconcileHost();
  await Reconcile.run('nothing-like-it', host);
  check('an account that is not there is said, with no window, and where to look',
    /^reconcile: no account matches nothing-like-it\. Type accounts to list them\.$/.test(log.said[0]) && !log.pages.length, log.said[0]);
  const page = reconcilePage({ data: readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking'), colors: COLORS, token: 't', files: [{ path: 'x', writable: false }], statementDate: '2026-09-30', statementBalance: '</script>', fingerprint: '', module: 'm.js' });
  check('the page escapes what it is given and says when nothing can be written', !page.includes('</script>"') && page.includes('id="progress" disabled'), '');
}

{
  // When things go wrong, reconcile says so in the terminal and writes nothing.
  const blocked = reconcileHost();
  await Reconcile.run('checking', { ...blocked.host, window: () => null });
  check('a blocked window is said', /the browser blocked the window for Assets:Bank:Checking/.test(blocked.log.said[0]), blocked.log.said[0]);
  const broken = reconcileHost();
  await Reconcile.run('checking', { ...broken.host, hledger: async () => { throw new Error('no journal is loaded'); } });
  check('a journal hledger cannot read is said', broken.log.said[0] === 'reconcile: no journal is loaded', broken.log.said[0]);
  const late = reconcileHost();
  let calls = 0;
  await Reconcile.run('checking', { ...late.host, hledger: async (command) => { calls += 1; if (command.startsWith('print')) throw new Error('print failed'); return late.host.hledger(command); } });
  check('and so is a print that fails, in the window too', late.log.said[0] === 'reconcile: print failed' && late.log.pages.some((html) => html.includes('print failed')), late.log.said[0]);
  const empty = reconcileHost();
  await Reconcile.run('savings', { ...empty.host, hledger: async (command) => (command.startsWith('print') ? '[]' : empty.host.hledger(command)) });
  check('an account with no postings is said', empty.log.said[0] === 'reconcile: Assets:Savings has no postings to reconcile.', empty.log.said[0]);
  const wrong = reconcileHost();
  await Reconcile.run('checking --wat', wrong.host);
  check('and a line it cannot read', /--wat is not something reconcile takes/.test(wrong.log.said[0]), wrong.log.said[0]);

  const failing = reconcileHost({ failSave: true });
  await Reconcile.run('checking', failing.host);
  const link = Object.values(globalThis.__reconcileBridges).pop();
  const rows = readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking').rows;
  const print = fingerprint(readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking'));
  const refused = await link.apply({ ticked: [rows[0].id], finish: null, fingerprint: print });
  check('a save the app refuses is said, and nothing is left half-written', /fixture\.journal could not be saved: the file changed on disk/.test(refused.error || '') && failing.files['fixture.journal'] === RECONCILE_JOURNAL, refused.error);

  const moved = reconcileHost();
  await Reconcile.run('checking', moved.host);
  moved.files['fixture.journal'] = RECONCILE_JOURNAL.replace('Assets:Bank:Checking    5000000.00 IDR', 'Assets:Moved    5000000.00 IDR');
  const movedLink = Object.values(globalThis.__reconcileBridges).pop();
  const missed = await movedLink.apply({ ticked: [rows[1].id], finish: null, fingerprint: print });
  check('a posting whose line is not where hledger said is not written', /^Not written: its line was not found/.test(missed.error || ''), missed.error);
  const previewed = movedLink.preview({ ticked: [rows[0].id], finish: null });
  check('and a preview lists the files and whether each can be written', previewed.writable[0].path === 'fixture.journal' && previewed.writable[0].writable === true, JSON.stringify(previewed.writable));

  check('hledger\'s source path is the loaded file, mounted under /data/ in the app or at / outside it',
    fileFor('/data/hledger.journal', ['hledger.journal']) === 'hledger.journal' && fileFor('/data/data/transitioning.journal', ['data/transitioning.journal', 'transitioning.journal']) === 'data/transitioning.journal'
    && fileFor('/fixture.journal', ['fixture.journal']) === 'fixture.journal' && fileFor('/data/x.journal', []) === 'data/x.journal', fileFor('/data/data/transitioning.journal', ['data/transitioning.journal', 'transitioning.journal']));
  const readOnly = plan({ data: readPrint(RECONCILE_PRINT, 'Assets:Bank:Checking'), texts: {}, ticked: new Set(rows.map((row) => row.id)), finish: { date: '2026-09-30', balance: 1 } });
  check('a journal that cannot be read still gets its assertion, to copy', readOnly.assertion.startsWith('2026-09-30 * Reconciled with statement') && !readOnly.files.length && readOnly.missing.length > 0, '');
  const parent = reconcileHost();
  await Reconcile.run('assets:bank', { ...parent.host, hledger: async (command) => (command === 'accounts' ? 'Assets:Bank\nAssets:Bank:Checking\n' : parent.host.hledger(command)) });
  check('a parent account is read with its subaccounts, and asserted inclusively',
    parent.log.asked.some((command) => command.includes('acct:^Assets:Bank(:|$)')) && /postings of Assets:Bank /.test(parent.log.said[0]), parent.log.said[0]);
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

check('seven charts read a report of their own, and every other is a balance chart',
  CUSTOM.length === 7 && isCustom('pack') && isCustom('sunburst') && isCustom('sankey') && isCustom('treemap') && !isCustom('stacked') && !isCustom(null),
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
  '../assets/plugins/chart-args.js',
  '../assets/plugins/chart-more.js',
  '../assets/plugins/chart-play.js',
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

// The help page is written in the manifest and the grammar in chart-args.js, so a type or an
// option can be added to one and forgotten in the other. This is what keeps `chart?` complete.
{
  const chartEntry = plugins.find((plugin) => plugin.name === 'chart');
  const forms = (chartEntry.sections || []).flatMap((section) => section.rows.map(([form]) => form));
  const missing = [
    ...Object.keys(TYPES).filter((name) => !forms.includes(name)),
    ...Object.entries(OPTIONS).filter(([name, option]) => !forms.includes(option.takes ? `--${name} ${option.takes}` : `--${name}`)).map(([name]) => `--${name}`),
  ];
  check('chart? lists every type and every option the grammar reads', missing.length === 0, missing.join(', '));
  check('and Tab offers them all', [...Object.keys(TYPES), ...Object.keys(OPTIONS).map((name) => `--${name}`)].every((word) => chartEntry.completes.includes(word)), '');
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
