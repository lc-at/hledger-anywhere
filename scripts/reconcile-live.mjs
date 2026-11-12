// The reconcile window driven for real: the plugin itself, run in the browser, writing real
// files through a host that behaves like the app's, with the shipped engine checking every write.
//
// check-plugin-windows.mjs checks the window against a bridge it stands in for, which is quick
// and covers the drawing. What that cannot show is a change made in the window reaching the file,
// hledger reading it back, and the window then showing what hledger read; or another program
// editing the file while the window is open. This does, in the same browser run:
//
//   * the server keeps one directory per check, the journal in it, and answers the page's host:
//     the files on disk (with a stamp, as the app's File System Access handle has), a save that
//     refuses a file that changed on disk since it was read, and a run of the engine over the
//     copies the page holds in memory, exactly as the app runs it;
//   * the page imports the real plugin, gives it that host, and lets it write its window over the
//     page, so the window's opener is the page that runs the plugin, as in the app;
//   * the checks click and type as a person would, and read the file on disk after.
//
// With SHOTS=<directory>, a screenshot of each state worth looking at is written there.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ENGINE = fileURLToPath(new URL('./hledger-wasm.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A journal with a busy day and a transaction booked to the wrong account. Invented data. */
export const LIVE_JOURNAL = [
  'commodity 1,000.00 IDR',
  '',
  '2026-01-01 * Opening',
  '    assets:bank   1000.00 IDR = 1000.00 IDR',
  '    equity:opening',
  '',
  '2026-01-05 Bakery',
  '    expenses:food  10.00 IDR',
  '    assets:bank',
  '',
  '2026-01-05 Hardware store',
  '    expenses:home  20.00 IDR',
  '    assets:bank',
  '',
  '2026-01-05 Bookshop',
  '    expenses:books  30.00 IDR',
  '    assets:bank',
  '',
  '2026-01-07 Groceries, booked to the wrong account',
  '    expenses:food  15.00 IDR',
  '    assets:cash',
  '',
  '2026-01-09 Pharmacy',
  '    expenses:health  40.00 IDR',
  '    assets:bank',
  '',
  '2026-01-12 * Salary  ; cleared by its line',
  '    assets:bank  500.00 IDR',
  '    income:salary',
  '',
  '2026-01-14 Cinema',
  '    expenses:fun  12.00 IDR',
  '  * assets:bank',
  '',
].join('\n');

const spaces = new Map();

/** A fresh directory with one journal in it, for one check. */
export function space(name, text = LIVE_JOURNAL, file = 'live.journal') {
  const dir = mkdtempSync(join(tmpdir(), `hla-live-${name}-`));
  writeFileSync(join(dir, file), text);
  const entry = { name, dir, file, path: join(dir, file), shadow: mkdtempSync(join(tmpdir(), 'hla-live-engine-')), failNext: false, armed: false, delay: 0, saves: 0, runs: 0 };
  spaces.set(name, entry);
  return entry;
}

export function cleanUp() {
  for (const entry of spaces.values()) {
    for (const dir of [entry.dir, entry.shadow]) rmSync(dir, { recursive: true, force: true });
  }
  spaces.clear();
}

const stampOf = (path) => { const info = statSync(path); return `${info.size}:${info.mtimeMs}`; };
const body = (request) => new Promise((resolve) => {
  let text = '';
  request.on('data', (chunk) => { text += chunk; });
  request.on('end', () => resolve(text ? JSON.parse(text) : {}));
});

/** The page that runs the plugin, and the host it is given. */
function livePage({ name, theme, writable, args, colors }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>live</title></head><body><p>starting the plugin</p>
<script type="module">
const space = ${JSON.stringify(name)};
const writable = ${JSON.stringify(writable)};
const post = async (path, value) => (await fetch(path + '?space=' + space, { method: 'POST', body: JSON.stringify(value) })).json();
const disk = await (await fetch('/live/disk?space=' + space)).json();
const memory = {};
const stamps = {};
for (const [path, entry] of Object.entries(disk)) { memory[path] = entry.text; stamps[path] = entry.stamp; }
window.__said = [];
const host = {
  name: 'reconcile',
  colors: () => (${JSON.stringify(colors)}),
  say: (text) => window.__said.push(text),
  setting: () => null,
  remember() {},
  files: () => Object.keys(memory).map((path, at) => ({ path, writable, main: at === 0 })),
  read: (path) => (path in memory ? memory[path] : null),
  async save(path, text) {
    const answer = await post('/live/save', { path, text, stamp: stamps[path] });
    if (answer.ok) { memory[path] = text; stamps[path] = answer.stamp; }
    return answer;
  },
  async refresh() {
    if (!writable) return { changed: [], missing: [] };
    const now = await (await fetch('/live/disk?space=' + space)).json();
    const changed = [];
    for (const [path, entry] of Object.entries(now)) {
      if (entry.stamp !== stamps[path]) { memory[path] = entry.text; stamps[path] = entry.stamp; changed.push(path); }
    }
    return { changed, missing: [] };
  },
  async hledger(command) {
    const answer = await post('/live/hledger', { command, files: memory });
    if (answer.error) throw new Error(answer.error);
    return answer.out;
  },
  // The plugin's window is this page: what it writes replaces it, and its opener is the page
  // that runs the plugin, as in the app.
  window: () => ({ write(html) { document.open(); document.write(html); document.close(); }, close() {} }),
};
Object.defineProperty(window, 'opener', { configurable: true, value: window });
const { default: reconcile } = await import('/plugins/reconcile.js');
await reconcile.run(${JSON.stringify(args)}, host);
</script></body></html>`;
}

/** Answer a request from a live page, or return false if it is not one. */
export async function liveRoute(url, request, response, { COLORS, DARK }) {
  if (!url.pathname.startsWith('/live')) return false;
  const send = (value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const entry = spaces.get(url.searchParams.get('space'));
  if (url.pathname === '/live') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(livePage({
      name: url.searchParams.get('space'),
      writable: url.searchParams.get('writable') !== 'no',
      args: url.searchParams.get('args') || 'assets:bank --statement 2026-01-31',
      colors: url.searchParams.get('theme') === 'dark' ? DARK : COLORS,
    }));
    return true;
  }
  if (!entry) { response.writeHead(404); response.end(); return true; }
  if (url.pathname === '/live/disk') {
    const out = {};
    for (const file of [entry.file, ...readdirSync(entry.dir).filter((name) => name !== entry.file)]) {
      out[file] = { text: readFileSync(join(entry.dir, file), 'utf8'), stamp: stampOf(join(entry.dir, file)) };
    }
    send(out);
    return true;
  }
  if (url.pathname === '/live/save') {
    const { path, text, stamp } = await body(request);
    const target = join(entry.dir, path);
    if (stampOf(target) !== stamp) { send({ error: `${path} changed on disk since it was opened; run \`open\` again before saving` }); return true; }
    writeFileSync(target, text);
    entry.saves += 1;
    if (entry.failNext) entry.armed = true;
    send({ ok: true, stamp: stampOf(target) });
    return true;
  }
  if (url.pathname === '/live/hledger') {
    const { command, files } = await body(request);
    if (entry.delay) await sleep(entry.delay);
    if (entry.armed && command.startsWith('print')) {
      entry.armed = false;
      entry.failNext = false;
      send({ error: 'Balance assertion failed in assets:bank (stood in for by the check)' });
      return true;
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(entry.shadow, path)), { recursive: true });
      writeFileSync(join(entry.shadow, path), text);
    }
    entry.runs += 1;
    const argv = String(command).match(/"[^"]*"|'[^']*'|\S+/g).map((part) => part.replace(/^["']|["']$/g, ''));
    try {
      const { stdout } = await run(process.execPath, [ENGINE, join(entry.shadow, entry.file), ...argv], { maxBuffer: 1 << 28, cwd: ROOT });
      send({ out: stdout });
    } catch (error) {
      send({ error: `${error.stdout || ''}${error.stderr || ''}`.split('\n').filter((line) => !/ExperimentalWarning|trace-warnings/.test(line)).join('\n').trim() || 'hledger failed' });
    }
    return true;
  }
  response.writeHead(404);
  response.end();
  return true;
}

/** The checks, in one tab. `check(label, ok, detail)` records each. */
export async function liveChecks(tab, check) {
  const shots = process.env.SHOTS || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (name) => {
    if (!shots) return;
    const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const text = (id) => tab.eval(`(document.getElementById(${JSON.stringify(id)}) || {}).textContent || ''`);
  const disk = (entry) => readFileSync(entry.path, 'utf8');
  const open = async (entry, extra = '') => {
    await tab.show('live', 'dark', `&space=${entry.name}${extra}`);
    await tab.until("document.getElementById('rows') && document.querySelectorAll('#rows tr[data-id]').length > 0", 20000);
    // Everything cleared already is hidden; these checks want every row in view.
    await tab.eval("(() => { const b = document.querySelector('[data-toggle-hidden]'); if (b && /show/.test(b.textContent)) b.click(); })()");
  };
  const rowsSaid = () => tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].map((tr) => tr.querySelector('td:nth-child(2)').firstChild && tr.cells[1].innerText.split('\\n')[0].replace(/\\s*edit$/, '').trim())");
  const settled = (entry, saves) => tab.until(`!document.getElementById('status').classList.contains('busy') && ${saves} <= ${entry.saves}`, 20000);
  const rowIndex = (name) => tab.eval(`[...document.querySelectorAll('#rows tr[data-id]')].findIndex((tr) => tr.cells[1].innerText.includes(${JSON.stringify(name)}))`);
  const focusRow = async (name) => {
    const index = await rowIndex(name);
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${index}].focus()`);
    return index;
  };

  // ------------------------------------------------ a tick is written at once, and can be undone
  {
    const entry = space('tick');
    await open(entry);
    check('live: the window says changes are written as they are made, and offers no Save',
      /written to the file as you make them/.test(await text('sub')) && !(await tab.eval("!!document.getElementById('progress')")), await text('sub'));
    entry.delay = 700;
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].click()`);
    await tab.until("/Checking with hledger/.test(document.getElementById('status').textContent)", 8000);
    const busy = { status: await text('status'), writing: await tab.eval("document.querySelectorAll('#rows tr.writing').length") };
    await shot('01-tick-checking-with-hledger');
    check('live: a tick says it is writing, then checking with hledger, and marks the row being written',
      /Checking with hledger/.test(busy.status) && busy.writing === 1, JSON.stringify(busy));
    entry.delay = 0;
    await settled(entry, 1);
    await tab.until("/Ticked/.test(document.getElementById('status').textContent)", 8000);
    await shot('02-tick-written-with-undo');
    check('live: then the file has the mark, and the window says so with an Undo',
      /Bakery\n {4}expenses:food {2}10\.00 IDR\n {2}\* assets:bank/.test(disk(entry)) && /^Ticked 2026-01-05 Bakery\./.test(await text('status'))
      && (await tab.eval("!!document.getElementById('undo')")) && (await tab.eval("document.querySelectorAll('#rows tr.writing').length")) === 0, await text('status'));
    const before = disk(entry);
    await tab.eval("document.getElementById('undo').click()");
    await tab.until("/Undid/.test(document.getElementById('status').textContent)", 8000);
    check('live: Undo takes it back out of the file', !/Bakery\n {4}expenses:food {2}10\.00 IDR\n {2}\*/.test(disk(entry)) && disk(entry) !== before && disk(entry) === LIVE_JOURNAL, await text('status'));
    // Three quick ticks while one is being written go as few writes, and every one lands.
    entry.delay = 400;
    const saves = entry.saves;
    for (const name of ['Bakery', 'Hardware store', 'Bookshop']) await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex(name)}].click()`);
    entry.delay = 0;
    await tab.until(`!document.getElementById('status').classList.contains('busy') && document.querySelectorAll('#rows tr.writing').length === 0`, 20000);
    const marked = (disk(entry).match(/^ {2}\* assets:bank$/gm) || []).length;
    check('live: ticks made while one is being written are written together after it, all of them',
      marked === 4 && entry.saves - saves <= 2 && (await tab.eval("document.querySelectorAll('#rows tr.on').length")) >= 4, `${marked} marks in ${entry.saves - saves} writes`);
    // u on the keyboard undoes too.
    await tab.eval("document.querySelector('#rows tr[data-id]').focus()");
    await tab.key('u', { text: 'u' });
    await tab.until("/Undid/.test(document.getElementById('status').textContent)", 8000);
    check('live: and u undoes the last write', (disk(entry).match(/^ {2}\* assets:bank$/gm) || []).length < 4, await text('status'));
  }

  // ------------------------------------------------ a new transaction, its amount left out
  {
    const entry = space('add');
    await open(entry);
    await tab.eval("document.getElementById('add').click()");
    await tab.eval(`(() => {
      const field = document.querySelector('tr.editor textarea');
      field.value = '2026-01-05 Corner shop\\n    expenses:food    7\\n    assets:bank';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await tab.until("document.querySelector('tr.editor .file-view .lines div')", 5000);
    const view = await tab.eval(`(() => ({
      reading: document.getElementById('reading').textContent,
      where: document.querySelector('tr.editor .file-view .where').textContent,
      here: document.querySelector('tr.editor .file-view .here') ? document.querySelector('tr.editor .file-view .here').textContent : '',
    }))()`);
    await shot('03-add-split-view-where-it-goes');
    check('live: a new transaction is read as hledger will read it: a bare number in the account\'s commodity, the bank\'s amount worked out',
      /2026-01-05: -7\.00 IDR to assets:bank, against expenses:food/.test(view.reading), view.reading);
    check('live: and the file beside it shows where it will go: after the last of its day',
      /it goes after line 17, after 2026-01-05 Bookshop/.test(view.where) && /^18/.test(view.here), JSON.stringify(view));
    await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
    await settled(entry, 1);
    await tab.until("/Added/.test(document.getElementById('status').textContent)", 8000);
    const row = await tab.eval(`(() => { const tr = [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => tr.innerText.includes('Corner shop')); return tr ? { text: tr.innerText, label: tr.getAttribute('aria-label'), on: tr.classList.contains('on') } : null; })()`);
    await shot('04-add-written-counted');
    check('live: once written it shows its amount, counted, never "?" or "not counted", and ticked',
      row && /-7\.00/.test(row.text) && !/\?|not counted/.test(row.label) && row.on, JSON.stringify(row));
    check('live: and the file has it after the day\'s last, with its commodity written',
      /Bookshop\n {4}expenses:books {2}30\.00 IDR\n {4}assets:bank\n\n2026-01-05 Corner shop\n {4}expenses:food {2,}7 IDR\n {2}\* assets:bank\n\n2026-01-07/.test(disk(entry)), disk(entry).slice(200, 420));
    const said = await rowsSaid();
    check('live: the list has it in the same place as the file', said.indexOf('Corner shop') === said.indexOf('Bookshop') + 1, JSON.stringify(said));
  }

  // ------------------------------------------------ inserted between two rows
  {
    const entry = space('insert');
    await open(entry);
    await focusRow('Bakery');
    await tab.key('i', { text: 'i' });
    await tab.eval(`(() => {
      const field = document.querySelector('tr.editor textarea');
      field.value = '2026-01-05 Between the first two\\n    expenses:food  1.00 IDR\\n    assets:bank';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await tab.eval("document.querySelector('tr.editor textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
    await settled(entry, 1);
    await focusRow('Bookshop');
    await tab.key('i', { text: 'i' });
    await tab.eval(`(() => {
      const field = document.querySelector('tr.editor textarea');
      field.value = '2026-01-07 First of the seventh\\n    expenses:food  2.00 IDR\\n    assets:bank';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await tab.eval("document.querySelector('tr.editor [data-keep]').click()");
    await settled(entry, 2);
    await tab.until("document.querySelectorAll('tr.editor').length === 0", 8000);
    const said = await rowsSaid();
    const inFile = disk(entry).split('\n').filter((line) => /^\d{4}-/.test(line)).map((line) => line.replace(/^\S+ (\* )?/, '').replace(/\s+;.*$/, ''));
    await shot('05-insert-between-rows');
    check('live: inserted after a row on its day, it is right after it, in the list and the file',
      said.indexOf('Between the first two') === said.indexOf('Bakery') + 1 && inFile.indexOf('Between the first two') === inFile.indexOf('Bakery') + 1, `${JSON.stringify(said)} / ${JSON.stringify(inFile)}`);
    check('live: inserted after a row but dated the next day, it is after it, in the list and the file',
      said.indexOf('First of the seventh') === said.indexOf('Bookshop') + 1 && inFile.indexOf('First of the seventh') === inFile.indexOf('Bookshop') + 1, `${JSON.stringify(said)} / ${JSON.stringify(inFile)}`);
  }

  // ------------------------------------------------ the order within a day
  {
    const entry = space('reorder');
    await open(entry);
    await focusRow('Bookshop');
    const controls = await tab.eval(`(() => { const tr = [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => tr.innerText.includes('Bookshop')); return { up: !!tr.querySelector('[data-up]'), down: !!tr.querySelector('[data-down]') }; })()`);
    const lone = await tab.eval(`(() => { const tr = [...document.querySelectorAll('#rows tr[data-id]')].find((tr) => tr.innerText.includes('Pharmacy')); return !!tr.querySelector('[data-up], [data-down]'); })()`);
    check('live: a row has an up control where its day has a row above it, and none where its day has no other', controls.up && !controls.down && !lone, JSON.stringify({ controls, lone }));
    await tab.key('ArrowUp', { code: 'ArrowUp', keyCode: 38, modifiers: 8 });
    await settled(entry, 1);
    await tab.until("/Moved Bookshop up/.test(document.getElementById('status').textContent)", 8000);
    await shot('06-reorder-shift-up');
    let said = await rowsSaid();
    let inFile = disk(entry).split('\n').filter((line) => line.startsWith('2026-01-05')).map((line) => line.slice(11));
    check('live: Shift+Up moves it above its neighbour, in the list and in the file',
      said.slice(0, 3).join() === 'Bakery,Bookshop,Hardware store' && inFile.join() === 'Bakery,Bookshop,Hardware store', `${said.join()} / ${inFile.join()}`);
    check('live: and the moved row keeps the focus', (await tab.eval("document.activeElement.innerText")).includes('Bookshop'), '');
    await tab.eval(`[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => tr.innerText.includes('Bakery')).querySelector('[data-down]').click()`);
    await settled(entry, 2);
    said = await rowsSaid();
    inFile = disk(entry).split('\n').filter((line) => line.startsWith('2026-01-05')).map((line) => line.slice(11));
    check('live: the small down control does the same', said.slice(0, 3).join() === 'Bookshop,Bakery,Hardware store' && inFile.join() === 'Bookshop,Bakery,Hardware store', `${said.join()} / ${inFile.join()}`);
  }

  // ------------------------------------------------ a transaction booked to the wrong account
  {
    const entry = space('find');
    await open(entry);
    await tab.eval("(() => { document.getElementById('balance').value = '1,358.00'; document.getElementById('balance').dispatchEvent(new Event('input')) })()");
    await tab.eval("(() => { document.body.focus(); document.querySelector('#rows tr[data-id]').focus() })()");
    await tab.key('f', { text: 'f' });
    check('live: f opens the search, with the difference as its amount and the statement date',
      !(await tab.eval("document.getElementById('find').hidden")) && (await tab.eval("document.getElementById('find-amount').value")) !== '' && (await tab.eval("document.getElementById('find-date').value")) === '2026-01-31',
      await tab.eval("document.getElementById('find-amount').value"));
    await tab.eval("(() => { document.getElementById('find-amount').value = '15'; document.getElementById('find-date').value = '2026-01-08'; document.getElementById('find-go').click() })()");
    await tab.until("document.querySelectorAll('#found li').length > 0 || /Nothing|Give/.test(document.getElementById('find-said').textContent)", 15000);
    await tab.until("document.querySelector('#find-file .hl')", 5000);
    const result = await tab.eval(`(() => ({
      first: document.querySelector('#found li') ? document.querySelector('#found li').innerText : '',
      buttons: document.querySelectorAll('#found li:first-child button[data-move]').length,
      lit: [...document.querySelectorAll('#find-file .hl')].map((line) => line.textContent),
    }))()`);
    await shot('07-find-wrong-account-with-file');
    check('live: it finds the transaction under another account by its amount and date, and offers to move each posting',
      /Groceries, booked to the wrong account/.test(result.first) && /same amount, 1 day from the date/.test(result.first) && result.buttons === 2, JSON.stringify(result));
    check('live: and shows it in the whole file, lit', result.lit.length === 3 && /19\s*2026-01-07 Groceries/.test(result.lit[0]), JSON.stringify(result.lit));
    const before = disk(entry);
    // A real click, so the focus is where a person's would be.
    await tab.eval("[...document.querySelectorAll('#found li:first-child button[data-move]')].find((button) => button.parentElement.innerText.includes('assets:cash')).id = 'move-cash'");
    const [x, y] = await tab.centre('#move-cash');
    await tab.click(x, y);
    await settled(entry, 1);
    await tab.until("/Moved:/.test(document.getElementById('find-said').textContent)", 8000);
    await shot('08-find-moved-to-this-account');
    const after = disk(entry);
    check('live: moving it changes that posting\'s account in place, and adds nothing',
      after.includes('2026-01-07 Groceries, booked to the wrong account\n    expenses:food  15.00 IDR\n    assets:bank') && (after.match(/Groceries/g) || []).length === 1
      && after.split('\n').length === before.split('\n').length, after.slice(260, 380));
    check('live: and it is in the list now, focused, without a duplicate',
      (await rowsSaid()).filter((name) => /Groceries/.test(name)).length === 1 && /Groceries/.test(await tab.eval('document.activeElement.innerText')), JSON.stringify(await rowsSaid()));
  }

  // ------------------------------------------------ another program edits the file
  {
    const entry = space('outside');
    await open(entry);
    await tab.eval("(() => { document.getElementById('balance').value = '1,358.00'; document.getElementById('balance').dispatchEvent(new Event('input')) })()");
    await tab.eval("(() => { document.getElementById('search').value = '2026-01'; document.getElementById('search').dispatchEvent(new Event('input')) })()");
    await focusRow('Pharmacy');
    await sleep(30);
    writeFileSync(entry.path, disk(entry).replace('commodity 1,000.00 IDR', '; notes typed in vim\n; another line\n\ncommodity 1,000.00 IDR').concat('\n2026-01-20 Typed in vim\n    expenses:food  3.00 IDR\n    assets:bank\n'));
    await tab.until("[...document.querySelectorAll('#rows tr[data-id]')].some((tr) => tr.innerText.includes('Typed in vim'))", 8000);
    const place = await tab.eval(`({ focus: document.activeElement.innerText, search: document.getElementById('search').value, balance: document.getElementById('balance').value, date: document.getElementById('date').value, status: document.getElementById('status').textContent })`);
    await shot('09-outside-edit-read-again');
    check('live: an edit made in another program is noticed and read again, while the window is in view',
      /changed outside this window, so it was read again/.test(place.status), place.status);
    check('live: keeping the focus, the search and the statement fields', /Pharmacy/.test(place.focus) && place.search === '2026-01' && place.balance === '1,358.00' && place.date === '2026-01-31', JSON.stringify(place));
    // A tick after it lands three lines lower than the window first saw it, and keeps vim's lines.
    await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
    await settled(entry, 1);
    check('live: the next change is written where its transaction now is, and keeps what vim wrote',
      /Pharmacy\n {4}expenses:health {2}40\.00 IDR\n {2}\* assets:bank/.test(disk(entry)) && disk(entry).includes('; notes typed in vim') && disk(entry).includes('Typed in vim'), await text('status'));
    // The other program changes the very transaction the next change is about, and the poll has
    // not seen it yet: that one change is refused, by name, and the file is left as it was.
    await tab.eval("(() => { document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input')) })()");
    await focusRow('Hardware store');
    await tab.eval('window.__reconcileHold = true');
    const edited = disk(entry).replace('expenses:home  20.00 IDR', 'expenses:home  21.00 IDR');
    await sleep(30);
    writeFileSync(entry.path, edited);
    await tab.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
    await tab.until("/changed outside this window, so this change was not made|Ticked/.test(document.getElementById('status').textContent)", 8000);
    await shot('10-outside-edit-same-transaction-refused');
    check('live: a change to a transaction another program changed is refused, said by name, and the file left alone',
      /2026-01-05 Hardware store changed outside this window, so this change was not made/.test(await text('status')) && disk(entry) === edited, await text('status'));
    check('live: and the window now shows the file as it is', (await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].find((tr) => tr.innerText.includes('Hardware store')).innerText")).includes('-21.00'), '');
  }

  // ------------------------------------------------ hledger refuses a write
  {
    const entry = space('rollback');
    await open(entry);
    entry.failNext = true;
    const before = disk(entry);
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].click()`);
    await tab.until("document.getElementById('status').classList.contains('error')", 15000);
    await shot('11-rollback-hledger-refused');
    check('live: when hledger refuses a write, the error says what was put back and why',
      /^hledger refused it, so live\.journal was put back as it was\. hledger said: Balance assertion failed/.test(await text('status')), await text('status'));
    check('live: and the file and the window are as they were', disk(entry) === before && (await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].classList.contains('on')`)) === false, '');
  }

  // ------------------------------------------------ Finish, previewed, written once
  {
    const mixed = LIVE_JOURNAL.replace('2026-01-09 Pharmacy\n    expenses:health  40.00 IDR\n    assets:bank', '2026-01-09 * Pharmacy\n    expenses:health  40.00 IDR\n  ! assets:bank');
    const entry = space('finish', mixed);
    await open(entry);
    await tab.eval("document.getElementById('all').click()");
    await settled(entry, 1);
    await tab.until("!document.getElementById('status').classList.contains('busy') && /ticked/.test(document.getElementById('status').textContent)", 10000);
    await tab.eval("(() => { document.getElementById('balance').value = '1,388.00'; document.getElementById('balance').dispatchEvent(new Event('input')) })()");
    await tab.until("!document.getElementById('finish').disabled", 5000);
    await tab.eval("document.getElementById('finish').click()");
    await tab.until("document.getElementById('apply')", 10000);
    const preview = await text('preview');
    check('live: Finish shows the assertion before writing it, and the file is untouched', /Reconciled with statement/.test(preview) && /= 1388\.00 IDR/.test(preview) && !disk(entry).includes('Reconciled'), preview);
    entry.delay = 600;
    const saves = entry.saves;
    await tab.eval("(() => { document.getElementById('apply').click(); document.getElementById('apply').click() })()");
    const pressed = await tab.eval("({ disabled: document.getElementById('apply').disabled, said: document.getElementById('apply').textContent, cancel: document.getElementById('cancel').disabled })");
    await tab.until("document.getElementById('apply') && /Checking with hledger/.test(document.getElementById('apply').textContent)", 8000);
    await shot('12-finish-write-and-check-in-progress');
    entry.delay = 0;
    await tab.until("document.getElementById('preview').hidden", 15000);
    await shot('13-finish-written');
    check('live: Write and check is disabled the moment it is pressed, and says it is writing, then checking',
      pressed.disabled && pressed.cancel && /Writing/.test(pressed.said), JSON.stringify(pressed));
    check('live: a second press writes nothing more: one write, and the assertion once',
      entry.saves - saves === 1 && (disk(entry).match(/Reconciled with statement/g) || []).length === 1 && /reconciled to 2026-01-31/.test(await text('status')), `${entry.saves - saves} writes / ${await text('status')}`);
  }

  // ------------------------------------------------ marks: transaction style, and conflicts shown
  {
    const mixed = LIVE_JOURNAL.replace('2026-01-09 Pharmacy\n    expenses:health  40.00 IDR\n    assets:bank', '2026-01-09 * Pharmacy\n    expenses:health  40.00 IDR\n  ! assets:bank');
    const entry = space('marks', mixed);
    await open(entry);
    await tab.eval("(() => { document.getElementById('style').value = 'transaction'; document.getElementById('style').dispatchEvent(new Event('change')) })()");
    check('live: switching to whole-transaction marks says how many transactions disagree with it', /2 transactions have marks that disagree with this; Finish lists them/.test(await text('status')), await text('status'));
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].click()`);
    await settled(entry, 1);
    check('live: a tick in that style marks the transaction\'s line', disk(entry).includes('2026-01-05 * Bakery\n    expenses:food  10.00 IDR\n    assets:bank\n'), disk(entry).slice(60, 160));
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Salary')}].click()`);
    await settled(entry, 2);
    check('live: and an untick takes the mark off the line, with no pending written', disk(entry).includes('2026-01-12 Salary  ; cleared by its line\n') && !/! Salary/.test(disk(entry)), disk(entry).slice(400, 520));
    const states = await tab.eval("[...document.querySelectorAll('#rows tr[data-id]')].map((tr) => tr.cells[1].innerText.split('\\n')[0].replace(/\\s*edit$/, '').trim() + '=' + tr.getAttribute('aria-checked'))");
    check('live: the window ticks exactly what hledger reads back', states.includes('Bakery=true') && states.includes('Salary=false') && states.includes('Cinema=true'), JSON.stringify(states));
    await tab.eval("(() => { document.getElementById('balance').value = '1'; document.getElementById('balance').dispatchEvent(new Event('input')) })()");
    await tab.eval("document.getElementById('all').click()");
    await settled(entry, 3);
    await tab.until("!document.getElementById('status').classList.contains('busy')", 10000);
    const sums = await tab.eval("document.getElementById('figures').innerText");
    const balance = /cleared to 2026-01-31 ([\d,.]+) IDR/.exec(sums);
    await tab.eval(`(() => { document.getElementById('balance').value = ${JSON.stringify(balance ? balance[1] : '0')}; document.getElementById('balance').dispatchEvent(new Event('input')) })()`);
    await tab.eval("document.getElementById('finish').click()");
    await tab.until("document.getElementById('apply') || /Nothing|not ticked/.test(document.getElementById('preview').textContent)", 10000);
    await shot('14-finish-preview-mark-conflicts');
    check('live: Finish lists the transactions whose marks disagree', /transactions? with marks that disagree/.test(await text('preview')) && /Cinema/.test(await text('preview')), await text('preview'));
    await tab.eval("document.getElementById('cancel').click()");
  }

  // ------------------------------------------------ read-only, as it always was
  {
    const entry = space('readonly');
    await open(entry, '&writable=no');
    await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].click()`);
    await sleep(200);
    await shot('15-read-only-banner');
    check('live: a read-only journal keeps its banner, ticks in the window and writes nothing',
      /Read-only: live\.journal did not come from an opened folder/.test(await text('readonly')) && (await tab.eval(`document.querySelectorAll('#rows tr[data-id]')[${await rowIndex('Bakery')}].classList.contains('on')`)) && entry.saves === 0 && disk(entry) === LIVE_JOURNAL,
      await text('readonly'));
    check('live: and Finish there shows the assertion to copy', (await tab.eval("document.getElementById('finish').textContent")) === 'Show the assertion', '');
  }
  cleanUp();
}
