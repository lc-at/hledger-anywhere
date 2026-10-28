// Renders the reconcile window in whichever state you want to look at, with the plugin
// side stubbed so no journal is touched. Run: node scripts/reconcile-preview.mjs [port]
// then open /?case=demo|big|empty&theme=light|dark&writable=no (BIG_PRINT sets the big case).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { page } from '../assets/plugins/reconcile-window.js';
import { readPrint } from '../assets/plugins/reconcile-data.js';
import { COLORS, DARK } from './chart-fixtures.mjs';
import { RECONCILE_PRINT } from './reconcile-fixtures.mjs';

const PLUGINS = fileURLToPath(new URL('../assets/plugins/', import.meta.url));
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css' };

const ACCOUNT = 'Assets:Bank:Checking';

/** The print JSON for the big case, when one has been generated. */
async function bigPrint() {
  const path = process.env.BIG_PRINT;
  if (!path) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

function dataFor(print, account) {
  const data = readPrint(print, account, { inclusive: false, wanted: null });
  if (data) for (const row of data.rows) row.text = `${row.date} ${row.description}\n    ${account}    ${row.amount}\n    Expenses:Other\n`;
  return data;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://preview');
  if (url.pathname.startsWith('/plugins/')) {
    const path = join(PLUGINS, normalize(url.pathname.slice('/plugins/'.length)));
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      response.end(body);
      return;
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
  }

  const which = url.searchParams.get('case') || 'demo';
  const theme = url.searchParams.get('theme') === 'light' ? COLORS : DARK;
  const writable = url.searchParams.get('writable') !== 'no';

  let data;
  let account = ACCOUNT;
  if (which === 'big') {
    const print = await bigPrint();
    if (!print) {
      response.writeHead(200, { 'content-type': TYPES['.html'] });
      response.end('<p>Set BIG_PRINT to a print -O json file to see the big case.</p>');
      return;
    }
    account = process.env.BIG_ACCOUNT || 'Assets:BNI:Taplus8650';
    data = dataFor(print, account);
  } else if (which === 'empty') {
    data = dataFor([], account);
  } else {
    data = dataFor(RECONCILE_PRINT, account);
  }

  if (!data) {
    response.writeHead(200, { 'content-type': TYPES['.html'] });
    response.end('<p>No postings, so the plugin would not open a window.</p>');
    return;
  }

  response.writeHead(200, { 'content-type': TYPES['.html'] });
  response.end(page({
    data,
    colors: theme,
    token: 'preview',
    files: [{ path: 'journal.journal', writable }],
    accounts: [account, 'Expenses:Food', 'Income:Salary'],
    statementDate: url.searchParams.get('date') || '2026-09-30',
    statementBalance: url.searchParams.get('balance') || '',
    fingerprint: 'preview',
    module: '/plugins/reconcile-window.js',
  }));
});

const port = Number(process.argv[2]) || 8099;
server.listen(port, '127.0.0.1', () => console.log(`reconcile preview on http://127.0.0.1:${port}/`));
