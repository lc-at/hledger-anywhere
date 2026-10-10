// Checks the example plugin's logic, without a browser.
//
// The plugin is the worked example in docs/plugins.md, so it has to keep working: this
// runs it against a stub host and asserts what it asks hledger for, what it draws, and
// that a failure and a blocked window are reported rather than drawn as nothing.
//
// Run with: node scripts/check-example-plugin.mjs
import Chart from '../assets/examples/plugins/chart.js';

const said = [];
let page = null;
let asked = null;
const host = {
  name: 'chart',
  say: (text) => said.push(text),
  setting: () => null,
  remember: (key, value) => said.push(`remember ${key}=${value}`),
  window: (title) => ({ write: (html) => { page = { title, html }; }, close() {} }),
  hledger: async (command) => {
    asked = command;
    return 'period,balance\n2024-01,"$100.00"\n2024-02,"$250.50"\n2024-03,"$1200.00"\n';
  },
};

await Chart.run('expenses', host);

const checks = [
  ['it asks hledger for monthly CSV of the account', asked === 'balance expenses -M -O csv', asked],
  ['it opens a window named for the account', page && page.title === 'hledger: expenses over time', page && page.title],
  ['the window holds an svg line chart', page && page.html.includes('<polyline'), page ? page.html.slice(0, 40) : 'no page'],
  ['with one point per month', page && (page.html.match(/<circle/g) || []).length === 3, page ? (page.html.match(/<circle/g) || []).length : -1],
  ['and the months as labels', page && page.html.includes('2024-03'), ''],
  ['it says what it drew', said.some((line) => line.includes('3 months of expenses')) && said.some((line) => line.includes('$1200.00')), JSON.stringify(said)],
  ['and remembers the account', said.includes('remember account=expenses'), JSON.stringify(said)],
  ['and credits hledger for the numbers', page && page.html.includes('balance expenses -M -O csv'), ''],
];

let failed = 0;
for (const [what, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : '  <- ' + detail}`);
}

// A command that fails must be reported, not charted as zero.
const failing = {
  name: 'chart',
  say: (text) => said.push(text),
  setting: () => null,
  remember: () => {},
  window: () => ({ write: (html) => said.push(html), close() {} }),
  hledger: async () => { throw new Error('no journal is loaded'); },
};
page = null;
await Chart.run('', failing);
const reported = said.some((line) => line.includes('no journal is loaded'));
console.log(`${reported ? 'ok  ' : 'FAIL'} a failed run is reported, not drawn as nothing`);
if (!reported) failed += 1;

// A blocked window must be said out loud.
const blocked = { ...failing, window: () => null, hledger: async () => '' };
said.length = 0;
await Chart.run('expenses', blocked);
const saidSo = said.some((line) => line.includes('blocked'));
console.log(`${saidSo ? 'ok  ' : 'FAIL'} a blocked window is reported`);
if (!saidSo) failed += 1;

process.exit(failed === 0 ? 0 : 1);
