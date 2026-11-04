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

import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
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
function realHost({ dir, file, writable = true }) {
  const path = join(dir, file);
  const log = { said: [], saved: [] };
  let checks = 0;
  const host = {
    name: 'reconcile',
    colors: () => ({ background: '#000', foreground: '#fff', dim: '#888', accent: '#f90', softer: '#111', soft: '#222' }),
    say: (text) => log.said.push(text),
    setting: () => null,
    remember: () => {},
    files: () => [{ path: file, writable, main: true }],
    window: () => ({ write: (html) => { host.page = html; }, close() {} }),
    // Synchronous, like the app's: the plan is worked out in one turn, so `read` has to
    // answer with the text itself rather than a promise of it.
    read(name) {
      if (name !== file) return null;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    async save(name, text) {
      if (name !== file) return { error: `${name} is not this journal` };
      await writeFile(path, text);
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
  const wanted = process.argv.slice(2);
  const names = Object.keys(CASES).filter((name) => !wanted.length || wanted.includes(name));
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
