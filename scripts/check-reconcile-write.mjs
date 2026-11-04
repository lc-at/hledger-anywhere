#!/usr/bin/env node
//
// Drive the reconcile plugin's real plan and apply against real files on disk, with the
// shipped engine doing every check.
//
// Everything else about reconcile is tested against fixture text and a stub host: this is the
// one that writes bytes. Each case copies a journal into a temporary directory, runs the
// plugin through its own bridge, applies a change, and then requires of the result:
//
//   * the engine parses the file and every balance assertion in it holds;
//   * replaying what the preview reported onto the original reproduces the written file
//     exactly, so the preview cannot describe something other than what was written;
//   * no line outside the reported regions moved;
//   * when the engine refuses the result, the file is back to its original bytes.
//
// Usage: node scripts/check-reconcile-write.mjs [case ...]
// Cases: tick untick tickall edit delete insert move linebyline finish rollback

import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import reconcile from '../assets/plugins/reconcile.js';
import { ordered, readPrint, summarize } from '../assets/plugins/reconcile-data.js';
import { GENERIC_JOURNAL, GENERIC_PRINT, RECONCILE_JOURNAL, RECONCILE_PRINT } from './reconcile-fixtures.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, 'hledger-wasm.mjs');

let checks = 0;
let failures = 0;
const notes = [];
const check = (ok, label, detail = '') => {
  checks += 1;
  if (ok) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `  <- ${detail}` : ''}`);
  }
};

/** Run the shipped engine. Rejects with hledger's own words, the way host.hledger does. */
async function engine(journal, command) {
  const argv = String(command).match(/"[^"]*"|'[^']*'|\S+/g).map((part) => part.replace(/^["']|["']$/g, ''));
  try {
    const { stdout } = await run(process.execPath, [ENGINE, journal, ...argv], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const text = `${error.stdout || ''}${error.stderr || ''}`.trim();
    throw new Error(text || `hledger exited ${error.code}`);
  }
}

/**
 * A host that reads and writes real files and asks the real engine.
 *
 * The engine reports a journal by its basename (the script mounts the journal's own directory
 * as the WASI root) and the plugin strips the leading slash off what it reads, so the paths
 * handed to the plugin are basenames, mapped back to the copy on disk.
 */
function realHost({ dir, file, files: many = null, writable = true }) {
  const names = many || [file];
  const path = join(dir, names[0]);
  const log = { said: [], saved: [] };
  let checks = 0;
  const host = {
    name: 'reconcile',
    colors: () => ({ background: '#000', foreground: '#fff', dim: '#888', accent: '#f90', softer: '#111', soft: '#222' }),
    say: (text) => log.said.push(text),
    setting: () => null,
    remember: () => {},
    files: () => names.map((name, at) => ({ path: name, writable, main: at === 0 })),
    window: () => ({ write: (html) => { host.page = html; }, close() {} }),
    // Synchronous, like the app's: the plan is worked out in one turn, so `read` has to
    // answer with the text itself rather than a promise of it.
    read(name) {
      if (!names.includes(name)) return null;
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    async save(name, text) {
      if (!names.includes(name)) return { error: `${name} is not this journal` };
      await writeFile(join(dir, name), text);
      log.saved.push(name);
      return { ok: true };
    },
    async hledger(command) {
      // The pre-write check has to pass and the re-check after the write has to fail, because
      // only that exercises putting the files back. The first balance run is the former.
      if (command.startsWith('balance')) host.balances += 1;
      if (host.failNextCheck && host.balances === 2) {
        throw new Error('Balance assertion failed in the account being reconciled');
      }
      return engine(path, command);
    },
  };
  host.balances = 0;
  host.failNextCheck = false;
  return { host, log, path };
}

/** Open the window on one journal and hand back the plugin's own bridge. */
async function openBridge(host, args) {
  const before = Object.keys(globalThis.__reconcileBridges || {}).length;
  // The app strips the command's own name before calling a plugin, so args is everything
  // after `reconcile`.
  await reconcile.run(args, host);
  const keys = Object.keys(globalThis.__reconcileBridges || {});
  if (keys.length <= before) throw new Error('the plugin published no bridge');
  // The window takes the fingerprint out of the page it is given and sends it back with every
  // request, which is how a journal that changed under the window is noticed. Reading it out of
  // the same page keeps this honest: the harness cannot invent a value the real window would not.
  const match = /"fingerprint":"([^"]*)"/.exec(host.page || '');
  if (!match) throw new Error('the page the plugin wrote carries no fingerprint');
  return { bridge: globalThis.__reconcileBridges[keys[keys.length - 1]], fingerprint: match[1] };
}

/**
 * Replay what the preview reported onto the original text.
 *
 * If this does not reproduce the written file, the preview described something other than what
 * was written, which is the one thing a preview must never do.
 */
function replay(before, plan) {
  const lines = before.split('\n');
  for (const change of plan.changes || []) {
    const at = change.line - 1;
    if (lines[at] !== change.before) continue;
    lines[at] = change.after;
  }
  const edits = [
    ...(plan.replaced || []).map((entry, at) => ({
      index: entry.line - 1,
      count: String(entry.before || '').split('\n').length,
      lines: entry.after ? String(entry.after).split('\n') : [],
      at,
    })),
    ...(plan.inserted || []).map((entry, at) => ({
      index: entry.line - 1,
      count: 0,
      lines: ['', ...String(entry.text || '').replace(/\s+$/, '').split('\n')],
      at: 1000 + at,
    })),
  ].sort((left, right) => right.index - left.index || right.at - left.at);
  for (const entry of edits) {
    let count = entry.count;
    if (!entry.lines.length && lines[entry.index + count] === '' && (entry.index === 0 || lines[entry.index - 1] === '')) count += 1;
    lines.splice(entry.index, count, ...entry.lines);
  }
  let after = lines.join('\n');
  if (plan.appended) after = `${after}${after.endsWith('\n') ? '' : '\n'}\n${plan.appended}`;
  return after;
}

function firstDifference(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `line ${i + 1}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  return 'the lengths differ';
}

/** Every line the preview reported changing, as it appears in the original. */
function reported(before, plan) {
  const lines = before.split('\n');
  const touched = new Set();
  for (const entry of plan.replaced || []) {
    const at = entry.line - 1;
    const count = String(entry.before || '').split('\n').length;
    for (let i = at; i < at + count; i += 1) touched.add(lines[i]);
  }
  return touched;
}

/** Assert everything that must hold after a write. */
async function afterWrite(label, { path, account }, before, plan, written) {
  if (!plan) {
    check(false, `${label}: the plan describes what was written`, 'the preview reported no files');
    return;
  }
  try {
    await engine(path, `balance ${account} -O csv`);
    check(true, `${label}: the engine parses the file and its assertions hold`);
  } catch (error) {
    check(false, `${label}: the engine parses the file and its assertions hold`, error.message.split('\n')[0]);
  }

  const replayed = replay(before, plan);
  check(replayed === written, `${label}: the preview describes exactly what was written`,
    replayed === written ? '' : firstDifference(replayed, written));

  // What proves nothing moved is that the reported edits, replayed onto the original, produce
  // the written file exactly: replay only ever touches what the preview reported. This second
  // check pins the preview's own line numbers against the original, so a report that points at
  // the wrong line cannot pass by accident.
  const original = before.split('\n');
  const aimed = [];
  for (const change of plan.changes || []) aimed.push([change.line, change.before]);
  for (const entry of plan.replaced || []) {
    const text = String(entry.before || '');
    if (text) aimed.push([entry.line, text.split('\n')[0]]);
  }
  const wrong = aimed.filter(([line, text]) => original[line - 1] !== text)
    .map(([line, text]) => `line ${line}: ${JSON.stringify(original[line - 1])} vs ${JSON.stringify(text)}`);
  check(wrong.length === 0, `${label}: every line the preview points at is the line it means`,
    wrong.join('; '));
}

/** A workspace with one copy of a journal, so every case starts from the same bytes. */
async function workspace(name, source) {
  const root = await mkdtemp(join(tmpdir(), `hla-write-${name}-`));
  const dir = join(root, 'journal');
  await mkdir(dir, { recursive: true });
  const file = basename(source);
  await copyFile(source, join(dir, file));
  const before = await readFile(join(dir, file), 'utf8');
  return { root, dir, file, before, async close() { await rm(root, { recursive: true, force: true }); } };
}

const request = (fingerprint, over = {}) => ({
  ticked: [], finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting',
  fingerprint, ...over,
});

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

/** Tick the first line and save the mark. */
async function tickCase(ctx) {
  // The pending line is the one left unticked at open, so ticking it is the change.
  const ids = [...ctx.cleared, ...ctx.rows.filter((row) => row.status !== 'Cleared').map((row) => row.id)];
  const plan = await ctx.preview({ ticked: ids });
  check(plan.missing.length === 0, 'tick: the plan has nothing missing', JSON.stringify(plan.missing));
  const result = await ctx.apply({ ticked: ids });
  check(Boolean(result.ok), 'tick: apply reports success', JSON.stringify(result.error || ''));
  await afterWrite('tick', ctx, ctx.ws.before, plan.files[0], await readFile(ctx.path, 'utf8'));
}

/** Untick a line that was already cleared, after ticking it first. */
async function untickCase(ctx) {
  // Tick everything first: a journal with nothing ticked has nothing to untick, and the case is
  // about taking a mark back off lines that have one.
  await ctx.apply({ ticked: ctx.rows.map((row) => row.id) });
  const first = await readFile(ctx.path, 'utf8');
  const plan = await ctx.preview({ ticked: [] });
  const result = await ctx.apply({ ticked: [] });
  check(Boolean(result.ok), 'untick: apply reports success', JSON.stringify(result.error || ''));
  await afterWrite('untick', ctx, first, plan.files[0], await readFile(ctx.path, 'utf8'));
}

/** Tick every line up to the statement date, which is what Tick all writes. */
async function tickAllCase(ctx) {
  const ids = [...new Set([...ctx.cleared, ...ctx.rows.filter((row) => row.date <= '2026-09-30').map((row) => row.id)])];
  const plan = await ctx.preview({ ticked: ids });
  check(plan.missing.length === 0, 'tick all: the plan has nothing missing', JSON.stringify(plan.missing));
  const result = await ctx.apply({ ticked: ids });
  check(Boolean(result.ok), 'tick all: apply reports success', JSON.stringify(result.error || ''));
  await afterWrite('tick all', ctx, ctx.ws.before, plan.files[0], await readFile(ctx.path, 'utf8'));
}

/** Edit a transaction's amount, so every balance after it moves. */
async function editCase(ctx) {
  const text = '2026-09-01 * Coffee\n    Expenses:Food    25000 IDR\n    Assets:Bank:Checking';
  const req = { edits: { [ctx.rows[0].id]: { text } } };
  const plan = await ctx.preview(req);
  check(plan.missing.length === 0, 'edit: the plan has nothing missing', JSON.stringify(plan.missing));
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'edit: apply reports success', JSON.stringify(result.error || ''));
  const written = await readFile(ctx.path, 'utf8');
  await afterWrite('edit', ctx, ctx.ws.before, plan.files[0], written);
  check(written.includes('25000 IDR'), 'edit: the new amount is in the file');
}

/** Delete a transaction by keeping empty text. */
async function deleteCase(ctx) {
  const req = { edits: { [ctx.rows[0].id]: { text: '' } } };
  const plan = await ctx.preview(req);
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'delete: apply reports success', JSON.stringify(result.error || ''));
  const written = await readFile(ctx.path, 'utf8');
  await afterWrite('delete', ctx, ctx.ws.before, plan.files[0], written);
  check(!written.includes('2026-09-01 * Coffee'), 'delete: the transaction is gone', written.slice(0, 120));
}

/** Insert a transaction between two existing ones. */
async function insertCase(ctx) {
  const req = request(ctx.fingerprint, {
    inserts: [{ id: 'new-1', text: '2026-09-02 * Inserted\n    Expenses:Food    1000 IDR\n    Assets:Bank:Checking', after: ctx.rows[0].id }],
  });
  const plan = await ctx.preview(req);
  check(plan.missing.length === 0, 'insert: the plan has nothing missing', JSON.stringify(plan.missing));
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'insert: apply reports success', JSON.stringify(result.error || ''));
  const written = await readFile(ctx.path, 'utf8');
  await afterWrite('insert', ctx, ctx.ws.before, plan.files[0], written);
  check(/Coffee[\s\S]*Inserted[\s\S]*Salary/.test(written), 'insert: it landed between its neighbours', written.slice(0, 200));
}

/** Move a transaction to another day. */
async function moveCase(ctx) {
  const req = request(ctx.fingerprint, { moved: { [ctx.rows[0].id]: '2026-09-04' } });
  const plan = await ctx.preview(req);
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'move: apply reports success', JSON.stringify(result.error || ''));
  const written = await readFile(ctx.path, 'utf8');
  await afterWrite('move', ctx, ctx.ws.before, plan.files[0], written);
  check(written.includes('2026-09-04 Coffee'), 'move: the date changed', written.slice(0, 80));
}

/** A running balance typed per line, which is what line-by-line mode writes. */
async function lineByLineCase(ctx) {
  const expected = Object.fromEntries(ctx.rows.map((row) => [row.id, row.balance]));
  const req = request(ctx.fingerprint, { expected });
  const plan = await ctx.preview(req);
  check((plan.files[0].changes || []).length > 0,
    `line by line: ${(plan.files[0].changes || []).length} lines would carry an assertion`,
    JSON.stringify(plan.missing));
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'line by line: apply reports success', JSON.stringify(result.error || ''));
  await afterWrite('line by line', ctx, ctx.ws.before, plan.files[0], await readFile(ctx.path, 'utf8'));
}

/** Finish: the assertion is appended and the engine must accept it. */
async function finishCase(ctx) {
  const statementDate = '2026-09-30';
  const ticked = ctx.rows.filter((row) => row.date <= statementDate).map((row) => row.id);
  // The balance the window itself works out: opening plus every ticked line.
  const { expected } = summarize({ data: ctx.data, ticked: new Set(ticked), statementDate, statementBalance: null });
  const req = request(ctx.fingerprint, { ticked, finish: { date: statementDate, balance: expected, file: ctx.ws.file } });
  const plan = await ctx.preview(req);
  check(plan.missing.length === 0, 'finish: the plan has nothing missing', JSON.stringify(plan.missing));
  check(plan.assertion.includes('Reconciled with statement'), 'finish: an assertion would be appended', plan.assertion);
  const result = await ctx.apply(req);
  check(Boolean(result.ok), 'finish: apply reports success', JSON.stringify(result.error || ''));
  const written = await readFile(ctx.path, 'utf8');
  await afterWrite('finish', ctx, ctx.ws.before, plan.files[0], written);
  check(written.includes('Reconciled with statement'), 'finish: the assertion is in the file');
}

/** The engine refusing the result puts every byte back. */
async function rollbackCase(ctx) {
  const before = await readFile(ctx.path, 'utf8');
  // The first check is the pre-write one and must pass; the second is the re-check after the
  // write, and it is the one that has to fail for the restore to be exercised.
  ctx.host.failNextCheck = true;
  const result = await ctx.apply({ ticked: [...ctx.cleared, ctx.rows[0].id] });
  ctx.host.failNextCheck = false;
  check(Boolean(result.error) && /put back/.test(result.error || ''), 'rollback: the failure is reported', JSON.stringify(result));
  const after = await readFile(ctx.path, 'utf8');
  check(after === before, 'rollback: the file is byte-identical to before', firstDifference(before, after));
}


/**
 * An account spread over two files, and a rollback that has to put both of them back.
 *
 * One file includes the other, so the engine reads them together and the window sees rows in
 * both. Every write has to land in the file the row is actually in, and when the re-check
 * refuses, both files have to come back byte for byte.
 */
async function multiFileCase() {
  const root = await mkdtemp(join(tmpdir(), 'hla-write-multifile-'));
  try {
    const main = 'main.journal';
    const other = 'other.journal';
    await writeFile(join(root, main), [
      '; one account, two files',
      'include other.journal',
      '',
      'commodity 1,000.00 IDR',
      '',
      '2026-01-01 Opening',
      '    assets:bank   1000.00 IDR = 1000.00 IDR',
      '    equity:opening',
      '',
      '2026-01-05 In main',
      '    expenses:food  100.00 IDR',
      '    assets:bank',
      '',
    ].join('\n'));
    await writeFile(join(root, other), [
      '2026-01-06 In other, one',
      '    expenses:food  200.00 IDR',
      '    assets:bank',
      '',
      '2026-01-07 In other, two',
      '    expenses:food  300.00 IDR',
      '    assets:bank',
      '',
    ].join('\n'));
    const before = { [main]: await readFile(join(root, main), 'utf8'), [other]: await readFile(join(root, other), 'utf8') };
    const { host } = realHost({ dir: root, files: [main, other] });
    const { bridge, fingerprint } = await openBridge(host, 'assets:bank --statement 2026-01-31');
    const print = JSON.parse(await host.hledger(`print ${JSON.stringify('acct:^assets:bank$')} -O json`));
    const rows = ordered(readPrint(print, 'assets:bank'));
    const inMain = rows.filter((row) => row.where.file === main);
    const inOther = rows.filter((row) => row.where.file === other);
    check(inMain.length >= 1 && inOther.length >= 1, 'the account has rows in both files',
      JSON.stringify({ main: inMain.length, other: inOther.length }));
    const ticked = [...rows.filter((row) => row.status === 'Cleared').map((row) => row.id), ...rows.map((row) => row.id)];
    const plan = await bridge.preview({ ticked, finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting', fingerprint });
    check(plan.files.length === 2, 'the plan reports changes in both files',
      JSON.stringify(plan.files.map((file) => file.path)));
    const answer = await bridge.apply({ ticked, finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting', fingerprint });
    check(Boolean(answer.ok), 'apply reports success', JSON.stringify(answer.error || ''));
    for (const file of plan.files) {
      const written = await readFile(join(root, file.path), 'utf8');
      await afterWrite(`multi-file ${file.path}`, { path: join(root, file.path), account: 'assets:bank' }, before[file.path], file, written);
      check(written !== before[file.path], `multi-file ${file.path}: it is not the file it started as`);
    }

    // The other direction: the engine refuses the result, so both have to come back.
    const now = { [main]: await readFile(join(root, main), 'utf8'), [other]: await readFile(join(root, other), 'utf8') };
    let balanceRuns = 0;
    const original = host.hledger.bind(host);
    host.hledger = async (command) => {
      if (command.startsWith('balance')) balanceRuns += 1;
      if (balanceRuns === 2) throw new Error('Balance assertion failed in the account being reconciled');
      return original(command);
    };
    const second = await bridge.apply({
      ticked: [], finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting',
      fingerprint: answer.fingerprint || fingerprint,
    });
    host.hledger = original;
    check(/put back/.test(second.error || ''), 'the refused write says the files were put back',
      JSON.stringify(second.error || second.ok));
    const restored = { [main]: await readFile(join(root, main), 'utf8'), [other]: await readFile(join(root, other), 'utf8') };
    check(restored[main] === now[main] && restored[other] === now[other],
      'both files are byte-identical to before the refused write',
      JSON.stringify({ main: restored[main] === now[main], other: restored[other] === now[other] }));
  } catch (error) {
    check(false, 'multi-file: the case ran', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Make every file in a copied tree writable, leaving the source alone. */
async function makeWritable(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(path);
    else await chmod(path, 0o644);
  }
}

/**
 * A deterministic run of random edits against a copy of a real journal.
 *
 * The path comes from the command line and the copy is thrown away afterwards, so nothing of
 * the journal it pointed at is kept, printed or committed: only the option that takes a path
 * is. The seed is fixed, so a failure is the same failure next time.
 */
async function realJournalRun(source, { seed = 7, rounds = 3, accounts: wanted = 3 } = {}) {
  const copy = await mkdtemp(join(tmpdir(), 'hla-write-real-'));
  try {
    // The journal includes files beside it, so the directory is what has to come along. A
    // read-only source stays read-only in the copy, so every file in it is made writable: the
    // whole point is to write to the copy and never to the original.
    await cp(dirname(source), copy, { recursive: true });
    await makeWritable(copy);
    const file = basename(source);
    const { host } = realHost({ dir: copy, files: [file] });
    const print = JSON.parse(await host.hledger('print -O json'));
    const counts = new Map();
    for (const transaction of print) {
      for (const posting of transaction.tpostings) counts.set(posting.paccount, (counts.get(posting.paccount) || 0) + 1);
    }
    const busy = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, wanted).map(([account]) => account);
    let state = seed;
    const random = (limit) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return limit <= 0 ? 0 : state % limit;
    };
    const literal = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const account of busy) {
      // The plugin reads one account's print, and hledger numbers transactions from one in
      // whatever it prints: tindex in a whole-journal print is not the tindex the window's
      // rows carry, so ids taken from the whole print point at nothing. Read what it reads.
      const own = JSON.parse(await host.hledger(`print ${JSON.stringify('acct:^' + literal(account) + '$')} -O json`));
      const data = readPrint(own, account);
      // The window puts each row's journal text on it from the file, and nothing else does:
      // without it every edit, move and insert reads row.text as undefined, takes its branch
      // as a no-op, and the round writes nothing while reporting that it was accepted.
      const source = readFileSync(join(copy, file), 'utf8').split('\n');
      for (const row of data.rows) {
        row.text = source.slice(row.where.first - 1, Math.max(row.where.last - 1, row.where.first))
          .join('\n').replace(/\s+$/, '');
      }
      if (!data || !data.rows.length) {
        notes.push(`${account}: no rows to reconcile, skipped`);
        continue;
      }
      let bridge;
      let fingerprint;
      try {
        ({ bridge, fingerprint } = await openBridge(host, `"${account}" --statement 2030-01-01`));
      } catch (error) {
        notes.push(`${account}: the window would not open (${String(error).slice(0, 90)}), skipped`);
        continue;
      }
      const rows = ordered(data);
      const ticked = new Set(rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
      const apply = async (over) => {
        const answer = await bridge.apply({ ...over, ticked: [...ticked], finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting', fingerprint });
        if (answer && answer.fingerprint) fingerprint = answer.fingerprint;
        if (answer && answer.ok && answer.data) {
          for (const row of answer.data.rows) if (row.status === 'Cleared') ticked.add(row.id);
        }
        return answer;
      };
      let wrote = 0;
      let accepted = 0;
      for (let round = 0; round < rounds; round += 1) {
        const row = rows[random(rows.length)];
        const pick = random(5);
        let request = {};
        // A round that sets a tick to what it already is writes nothing, so the two tick moves
        // are one toggle: whatever the round does, the journal should change with it.
        if (pick === 0 || pick === 1) {
          if (ticked.has(row.id)) ticked.delete(row.id);
          else ticked.add(row.id);
        }
        else if (pick === 2 && row.text) request = { edits: { [row.id]: { text: `${row.text}\n    ; a note the run added` } } };
        else if (pick === 3 && row.text) request = { moved: { [row.id]: '2027-03-04' } };
        else if (pick === 4 && rows[0].text) {
          // An assertion copied to a later date would fail on its own arithmetic, and the run
          // must not manufacture that and then blame the write path for it.
          const seed = rows[0].text.replace(/^\d{4}-\d{2}-\d{2}/, '2027-03-05').replace(/ = [^\n]*/g, '');
          request = { inserts: [{ id: `new:${round}`, text: seed, after: row.id }] };
        }
        const answer = await apply(request);
        if (!answer || !answer.ok) {
          const error = (answer && answer.error) || '';
          // The engine refusing the result is the signal worth having: a write happened and had
          // to be undone. A fingerprint refusal is the journal changing under the window, which
          // is the guard working.
          check(!/put back/.test(error), `${account}: round ${round} needed no rollback`, error.slice(0, 160));
          if (error && !/changed since this window was drawn/.test(error)) {
            notes.push(`${account}: round ${round} refused: ${error.slice(0, 110)}`);
          }
          continue;
        }
        const plan = await bridge.preview({ ...request, ticked: [...ticked], finish: null, edits: {}, inserts: [], expected: {}, moved: {}, style: 'posting', fingerprint });
        const changed = (plan.files || []).length;
        if (changed) wrote += 1;
        accepted += 1;
        for (const file of plan.files || []) {
          const written = await readFile(join(copy, file.path), 'utf8');
          const replayed = replay(file.before, file);
          check(replayed === written, `${account}: the preview describes ${file.path} exactly`,
            replayed === written ? '' : firstDifference(replayed, written));
        }
      }
      // Finish last: tick everything up to the statement date and assert, which is only
      // correct if the running total the window worked out is the one hledger has.
      const statementDate = '2030-01-01';
      for (const row of rows) if (row.date <= statementDate) ticked.add(row.id);
      const { expected } = summarize({ data, ticked, statementDate, statementBalance: null });
      const finished = await apply({ finish: { date: statementDate, balance: expected, file } });
      check(Boolean(finished && finished.ok), `${account}: Finish writes an assertion the engine accepts`,
        JSON.stringify(finished && (finished.error || finished.message) || ''));
      notes.push(`${account}: ${wrote} of ${rounds} rounds changed the journal (${accepted} accepted)`);
    }
  } catch (error) {
    check(false, 'real journal: the run completed', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

const CASES = {
  tick: tickCase,
  untick: untickCase,
  tickall: tickAllCase,
  edit: editCase,
  delete: deleteCase,
  insert: insertCase,
  move: moveCase,
  linebyline: lineByLineCase,
  finish: finishCase,
  rollback: rollbackCase,
};

/**
 * Run one case against a fresh copy of one journal.
 *
 * `file` must be the name the fixture's print reports, because that is what the plugin
 * matches a row's file against.
 */
async function scenario(name, { file, journal, print, account, args, statement }) {
  const root = await mkdtemp(join(tmpdir(), `hla-write-${name}-`));
  const dir = join(root, 'journal');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), journal);
  const ws = { file, before: await readFile(join(dir, file), 'utf8') };
  try {
    const { host, path } = realHost({ dir, file });
    const data = readPrint(print, account);
    // Balances are worked out by ordered(), not by reading: without it every row's balance is
    // undefined and line-by-line has nothing to assert.
    const rows = ordered(data);
    const { bridge, fingerprint } = await openBridge(host, args);
    // What the window starts ticked: the lines the journal already calls cleared.
    const cleared = data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id);
    // A apply re-reads and returns the fingerprint to use next, exactly as the window does.
    let current = fingerprint;
    const apply = async (over) => {
      const answer = await bridge.apply({ ...over, fingerprint: current });
      if (answer && answer.fingerprint) current = answer.fingerprint;
      return answer;
    };
    const preview = async (over) => bridge.preview({ ...over, fingerprint: current });
    await CASES[name]({ host, path, bridge, apply, preview, cleared, ws, data, rows, account, statement });
  } catch (error) {
    check(false, `${name}: the case ran`, error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FIXTURES = {
  demo: { file: 'fixture.journal', journal: RECONCILE_JOURNAL, print: RECONCILE_PRINT, account: 'Assets:Bank:Checking', args: 'assets:bank:checking --statement 2026-09-30' },
  generic: { file: 'generic.journal', journal: GENERIC_JOURNAL, print: GENERIC_PRINT, account: 'assets:bank', args: 'assets:bank --statement 2026-01-31' },
};

async function main() {
  const args = process.argv.slice(2);
  const journal = args.find((argument) => argument.startsWith('--journal='));
  if (journal) {
    const seed = Number((args.find((argument) => argument.startsWith('--seed=')) || '--seed=7').slice(7));
    const rounds = Number((args.find((argument) => argument.startsWith('--rounds=')) || '--rounds=3').slice(9));
    await realJournalRun(journal.slice('--journal='.length), { seed, rounds });
    console.log(`\n${checks - failures}/${checks} checks passed`);
    for (const note of notes) console.log(`note ${note}`);
    if (failures) process.exitCode = 1;
    return;
  }
  const wanted = args;
  const names = Object.keys(CASES).filter((name) => !wanted.length || wanted.includes(name));
  if (!wanted.length || wanted.includes('multifile')) await multiFileCase();
  const fixtures = wanted.includes('generic') ? ['generic'] : ['demo'];

  for (const fixture of fixtures) {
    for (const name of names) {
      if (fixture === 'generic' && name !== 'tick') continue;
      await scenario(name, FIXTURES[fixture]);
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
