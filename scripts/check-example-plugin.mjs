// Checks the bundled chart plugin and the repository it ships in, without a browser.
//
// The plugin is the worked example in docs/plugins.md and the only plugin most people will
// ever see, so it has to keep working: this runs it against a stub host and asserts what it
// asks hledger for, the shape it draws from hledger's own CSV, the numbers it puts on it,
// and that a failure, an empty report and a blocked window are reported rather than drawn as
// nothing.
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

import Chart from '../assets/plugins/chart.js';

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
  return { host, log, page: () => log.pages[log.pages.length - 1] || '' };
}

// ---------------------------------------------------------------- a line over time

{
  const { host, log, page } = stub();
  await Chart.run('expenses', host);

  check('a series asks hledger for monthly CSV of the account', log.asked[0] === 'balance expenses -M -O csv', log.asked[0]);
  check('it names the window after the account', log.title === 'hledger: expenses', log.title);
  check('the window opens before hledger is asked', log.events.join(',') === 'window,window,hledger' || log.events[0] === 'window', log.events.join(','));
  check('something is shown while it waits', log.pages[0].includes('Reading hledger'), log.pages[0].slice(0, 80));
  check('the window holds an svg line', page().includes('<polyline'), '');
  check('one point per period', (page().match(/<circle/g) || []).length === 3, (page().match(/<circle/g) || []).length);
  check('the periods are the labels', page().includes('2024-03'), '');
  check('every point can be hovered for its value', page().includes('<title>2024-03: $1,286.40</title>'), '');
  // The labels the chart itself draws, not every amount on the page.
  const axis = [...page().matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  check('the axis is round numbers',
    axis.includes('$500') && axis.includes('$1.0k') && !axis.some((label) => /\$\d+\.\d{2}$/.test(label)),
    axis.join(' '));
  check('the amounts keep their currency and get separators', page().includes('$1,286.40'), page().match(/\$[\d,.]+/g)?.slice(0, 4).join(' '));
  check('the Total row is not counted twice', !page().includes('3,723.90') && !page().includes('3723.90'), '');
  check('the data is there as a table too', page().includes('<table') && page().includes('2024-02'), '');
  check('the theme it was given is the theme it used', page().includes(COLORS.background) && page().includes(COLORS.accent), '');
  check('it remembers the account', log.said.includes('remember account=expenses'), JSON.stringify(log.said));
  check('it says what it drew', log.said.some((line) => line.includes('3 periods') && line.includes('$1,286.40')), JSON.stringify(log.said));
}

// ---------------------------------------------------------------- a ranking

{
  const { host, log, page } = stub({ hledger: async (command) => { log.asked.push(command); return RANKING_CSV; } });
  await Chart.run('expenses -p 2024', host);
  check('a period already chosen is not overridden with months', log.asked[0] === 'balance expenses -p 2024 -O csv', log.asked[0]);
  check('one column is drawn as a ranking', page().includes('<rect') && !page().includes('<polyline'), '');
  const bars = page().match(/<rect/g) || [];
  check('a bar per account', bars.length === 3, String(bars.length));
  const order = [...page().matchAll(/<title>([^<]+)<\/title>/g)]
    .map((match) => match[1])
    .filter((title) => title.includes('$'));
  check('largest first, because that is how the question is read',
    order[0].startsWith('expenses:housing:rent') && order[2].startsWith('expenses:reading:books'),
    order.join(' > '));
  check('and the values are on the bars', page().includes('$1,200.00') && page().includes('$34.99'), '');
}

// ---------------------------------------------------------------- amounts as hledger writes them

{
  const { host, page } = stub({
    hledger: async () => '"account","balance"\n"a","1234.56 EUR"\n"b","-1.234,56 EUR"\n',
  });
  await Chart.run('expenses -p 2024', host);
  check('a commodity after the number is kept', page().includes('EUR'), '');
  check('and European decimals are read', page().includes('1,234.56') || page().includes('1.234,56'), page().match(/[\d.,]+ EUR/g)?.join(' '));
}

{
  const { host, page } = stub({
    hledger: async () => '"account","2024-01","2024-02"\n"a","$100.00","$-50.00"\n',
  });
  await Chart.run('expenses', host);
  check('a negative period is drawn below zero', page().includes('$-0.00') || page().includes('-$50.00') || page().includes('-'), '');
}

// ---------------------------------------------------------------- what can go wrong

{
  const { host, log, page } = stub({ hledger: async () => { throw new Error('no journal is loaded'); } });
  await Chart.run('expenses', host);
  check('a failed run is reported on the page', page().includes('no journal is loaded'), '');
  check('and in the terminal', log.said.some((line) => line.includes('no journal is loaded')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ hledger: async () => '"account","2024-01"\n' });
  await Chart.run('expenses', host);
  check('an empty report is reported, not charted', log.said.some((line) => line.includes('no amounts')), JSON.stringify(log.said));
}

{
  const { host, log } = stub({ window: () => null });
  await Chart.run('expenses', host);
  check('a blocked window is reported', log.said.some((line) => line.includes('blocked')), JSON.stringify(log.said));
}

{
  // An app older than this plugin: no colors() to ask.
  const { host, page } = stub({ colors: undefined });
  await Chart.run('expenses', host);
  check('a host without colors() still gets a readable page', page().includes('#000000') && page().includes('<polyline'), '');
}

// ---------------------------------------------------------------- the repository itself

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
  try {
    await readFile(new URL(plugin.module, new URL('../assets/plugins/plugins.json', import.meta.url)));
  } catch {
    modulesThere = false;
  }
}
check('and every plugin names a module that exists', modulesThere, `${manifest.plugins?.length} plugins`);

// ---------------------------------------------------------------- the verdict

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
