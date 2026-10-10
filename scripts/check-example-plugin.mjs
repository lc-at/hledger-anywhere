// Checks the example plugin's logic, without a browser.
//
// The plugin is the worked example in docs/plugins.md, so it has to keep working: this
// runs it against a stub host and asserts what it asks hledger for, what it draws from
// hledger's own CSV shape, and that a failure, an empty report and a blocked window are
// reported rather than drawn as nothing.
//
// The CSV below is copied from the shipped engine, not invented:
//
//   hledger balance expenses -M -O csv
//   "account","2024-01","2024-02","2024-03"
//   "expenses:food:coffee","0","$12.50","$0"
//   ...
//   "Total:","$1200.00","$1250.00","$1286.40"
//
// Periods are columns and accounts are rows, which is the opposite of the obvious guess
// and the reason the first version of this plugin charted nothing.
//
// Run with: node scripts/check-example-plugin.mjs

import Chart from '../assets/plugins/chart.js';

const REAL_CSV = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses:food:coffee","0","$12.50","$0"',
  '"expenses:housing:rent","$1200.00","$1237.50","$1286.40"',
  '"expenses:reading:books","0","$0","$0"',
  '"Total:","$1200.00","$1250.00","$1286.40"',
  '',
].join('\n');

const said = [];
let page = null;
let asked = null;

function host(overrides = {}) {
  return {
    name: 'chart',
    say: (text) => said.push(text),
    setting: () => null,
    remember: (key, value) => said.push(`remember ${key}=${value}`),
    window: (title) => ({ write: (html) => { page = { title, html }; }, close() {} }),
    hledger: async (command) => { asked = command; return REAL_CSV; },
    ...overrides,
  };
}

const checks = [];
const check = (what, ok, detail = '') => checks.push([what, ok, detail]);

await Chart.run('expenses', host());
check('it asks hledger for monthly CSV of the account', asked === 'balance expenses -M -O csv', asked);
check('it names the window after the account', page && page.title === 'hledger: expenses over time', page && page.title);
check('the window holds an svg line chart', page && page.html.includes('<polyline'), page ? page.html.slice(0, 60) : 'no page');
check('one point per period', page && (page.html.match(/<circle/g) || []).length === 3, page ? (page.html.match(/<circle/g) || []).length : -1);
check('the periods are the labels', page && page.html.includes('2024-03'), '');
// 1200.00 + 1237.50 + 1286.40 = 3723.90, so a chart that says 3723.90 anywhere has
// added the Total row to the rows it totals.
check(
  'the Total row is not counted twice',
  page && page.html.includes('$1286.40') && !page.html.includes('3723.90'),
  page ? (page.html.match(/\$[0-9,]+\.[0-9]{2}/g) || []).slice(0, 4).join(' ') : '',
);
check(
  'it says what it drew',
  said.some((line) => line.includes('3 months of expenses')) && said.some((line) => line.includes('$1286.40')),
  JSON.stringify(said),
);
check('and it remembers the account', said.includes('remember account=expenses'), JSON.stringify(said));
check('and it credits hledger for the numbers', page && page.html.includes('balance expenses -M -O csv'), '');

// A report with nothing in it is not a chart, and is said out loud.
said.length = 0;
page = null;
await Chart.run('expenses', host({ hledger: async () => '"account","2024-01"\n' }));
check('an empty report is reported, not charted', said.some((line) => line.includes('no monthly amounts')), JSON.stringify(said));

// A command that fails must be reported, not charted as zero.
said.length = 0;
page = null;
await Chart.run('expenses', host({ hledger: async () => { throw new Error('no journal is loaded'); } }));
check('a failed run is reported', said.some((line) => line.includes('no journal is loaded')), JSON.stringify(said));

// A blocked window must be said out loud.
said.length = 0;
await Chart.run('expenses', host({ window: () => null }));
check('a blocked window is reported', said.some((line) => line.includes('blocked')), JSON.stringify(said));

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  <- ${detail}`}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
