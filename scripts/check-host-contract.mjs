#!/usr/bin/env node
//
// The plugin host is written down three times: `App::host` in Rust builds one, the table in
// docs/plugins.md describes one, and scripts/host.mjs builds one for every check that runs a
// plugin. Three sayings of one interface drift apart on their own: a method added in Rust and
// left out of the docs, a row renamed in the docs, a method a check never gave a host.
//
// So this reads all three and fails unless they name the same methods. What Rust cannot know
// about is read as well: `name` and `window` are the loader's two, set in
// assets/js/plugins.js rather than in Rust, because a window has to be opened by the browser
// before the plugin awaits. The docs table has rows for them, and the adapter builds them,
// and the Rust side has neither.
//
// Names are only the surface. What a plugin CALLS is written down too: how many arguments a
// method takes, and the shape each call answers with — both of them in the docs table and
// nowhere else, and neither of them seen by a name check. So the same table is held to the
// adapter a second way: every row written as a call has to take the parameters that call
// names, and every row that states an answer has to get that answer out of a host built over
// a backend answering the way the docs say the app's does. A row that gains a parameter, or
// an answer that changes shape, fails here rather than in a plugin at run time.
//
// Usage: node scripts/check-host-contract.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeHost } from './host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The loader's two, which the app adds in JavaScript rather than in `App::host`. */
const FROM_LOADER = new Set(['name', 'window']);

/**
 * The rows this file asserts an answer for, over the in-check backend below. `remember` is on
 * the list by way of the `setting` that reads it back: docs write no return value for it.
 */
const ANSWERED = new Set(['hledger', 'window', 'colors', 'setting', 'remember', 'files', 'read', 'save', 'refresh']);

/**
 * The two rows with nothing to compare: `host.name` is the plugin's own word rather than a
 * call (docs/plugins.md:109), and `host.say` prints a line and states no return value
 * (docs/plugins.md:111).
 */
const NO_ANSWER = new Set(['name', 'say']);

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

/** One set of names read against another: what one has that the other does not. */
const only = (given, against) => [...given].filter((name) => !against.has(name)).sort().join(', ') || 'nothing';
const list = (names) => [...names].sort().join(', ');

/** An object's keys, sorted, for the detail a shape failure prints. */
const keysOf = (value) => (value && typeof value === 'object' ? Object.keys(value).sort().join(', ') : String(value));

/**
 * Await a call the docs say never rejects. A rejection is not swallowed: it comes back here
 * and the assertion above fails on it, which is how a backend that resolves is held to
 * answering rather than throwing.
 */
const settled = async (call) => {
  try {
    return { answer: await call(), rejected: null };
  } catch (error) {
    return { answer: undefined, rejected: error };
  }
};
const answered = (result) => (result.rejected ? `rejected: ${result.rejected.message}` : `answered: ${JSON.stringify(result.answer)}`);

/**
 * The methods `App::host` puts on the host, from the mechanism it uses: every
 * `Reflect::set(&host, &"name".into(), ...)` in that one function. The sets on other objects
 * in it (`colors`, `answer`, `entry`) are not the host's, and are not matched.
 */
function fromRust() {
  const source = readFileSync(join(ROOT, 'src/app.rs'), 'utf8');
  const start = source.indexOf('fn host(self: &Rc<App>, name: &str) -> JsValue {');
  const end = source.indexOf('fn host_files(', start);
  if (start < 0 || end < 0) throw new Error('App::host was not found in src/app.rs, so nothing could be read out of it');
  const names = [...source.slice(start, end).matchAll(/Reflect::set\(&host, &"(\w+)"\.into\(\)/g)].map((match) => match[1]);
  if (!names.length) throw new Error('App::host sets nothing on the host with Reflect::set(&host, ...) any more');
  return new Set(names);
}

/**
 * The host API table in docs/plugins.md, row by row: the method, the parameter names its call
 * form shows (`host.name` is written without one — the word, not a call), and the line the
 * row is on, which is what the arity check below cites.
 */
function fromDocs() {
  const source = readFileSync(join(ROOT, 'docs/plugins.md'), 'utf8');
  const at = source.indexOf('## The host API');
  if (at < 0) throw new Error('the `## The host API` section was not found in docs/plugins.md');
  const section = source.slice(at).split('\n## ')[0];
  const atLine = source.slice(0, at).split('\n').length;
  const rows = [];
  section.split('\n').forEach((line, offset) => {
    const row = line.match(/^\| `host\.(\w+)(\([^)]*\))?`/);
    if (!row) return;
    const call = row[2] || '';
    rows.push({
      name: row[1],
      call,
      params: call ? call.slice(1, -1).split(',').map((param) => param.trim()).filter(Boolean) : [],
      line: atLine + offset,
    });
  });
  if (!rows.length) throw new Error('the host API table in docs/plugins.md has no method rows');
  return rows;
}

/**
 * The parts that vary, written the way docs/plugins.md writes them: the five colours of
 * `host.colors`, the line `host.say` prints, the handle `host.window` opens, and the standard
 * output `host.hledger` resolves with. `host.name` is the word a check gives the plugin.
 */
function sinks() {
  return {
    name: 'contract',
    colors: () => ({ background: '#1d2021', foreground: '#ebdbb2', cursor: '#ebdbb2', accent: '#83a598', dim: '#928374' }),
    say: (text) => {},
    window: (title) => ({ write: (html) => {}, close: () => {} }),
    hledger: async (command) => 'assets\n',
  };
}

/**
 * The app's half for a normal answer: one opened folder holding one journal, every read
 * answered with its text, every write accepted, every re-read taken in. `save` answers the
 * way docs/plugins.md:118 says a write is answered, with no keys beside the ones the row
 * names — which is what makes a wrong-shaped answer from a backend visible here.
 */
function memoryBackend() {
  const texts = { 'journal.j': 'a 1\n' };
  return {
    files: () => [{ path: 'journal.j', writable: true, main: true }],
    read: (path) => (path in texts ? texts[path] : null),
    save: async () => ({ ok: true }),
    refresh: async () => ({ changed: ['journal.j'], missing: [] }),
  };
}

/** The same folder when the browser refuses: a write and a re-read that answer with an error. */
function refusingBackend() {
  return {
    ...memoryBackend(),
    save: async () => ({ error: 'the file changed on disk since it was opened' }),
    refresh: async () => ({ changed: [], missing: [], error: 'the folder was refused' }),
  };
}

/** The reference host: the sinks over one backend, built the way a check builds one. */
function hostFor(backend) {
  return makeHost({ ...sinks(), backend });
}

try {
  const rust = fromRust();
  const rows = fromDocs();
  const docs = new Set(rows.map((row) => row.name));
  const host = hostFor(memoryBackend());
  const adapter = new Set(Object.keys(host));
  const appSide = new Set([...adapter].filter((name) => !FROM_LOADER.has(name)));

  check(list(rust) === list(appSide),
    'Rust sets every method the adapter gives, bar the loader\'s two',
    `App::host: ${list(rust)}; adapter without the loader's two: ${list(appSide)}; only in Rust: ${only(rust, appSide)}; only in the adapter: ${only(appSide, rust)}`);
  check(list(docs) === list(adapter),
    'docs/plugins.md and the reference adapter name the same methods',
    `docs: ${list(docs)}; adapter: ${list(adapter)}; only in the docs: ${only(docs, adapter)}; only in the adapter: ${only(adapter, docs)}`);

  const loader = readFileSync(join(ROOT, 'assets/js/plugins.js'), 'utf8');
  check(/\bhost\.name = name;/.test(loader) && /\bhost\.window = \(title\)/.test(loader),
    'name and window are still the two the loader adds in JavaScript',
    'assets/js/plugins.js sets host.name and host.window in the app, which is where the two above come from');

  // Arity: every row the docs write as a call takes the parameters that call names, and the
  // adapter's function takes as many. `host.name` is written without a call, so there is no
  // arity to count on it.
  for (const row of rows) {
    if (!row.call) continue;
    const method = host[row.name];
    if (typeof method !== 'function') {
      check(false, `host.${row.name} takes (${row.params.join(', ')}) as docs/plugins.md:${row.line} writes it`,
        `the host holds no function under host.${row.name}`);
      continue;
    }
    check(method.length === row.params.length,
      `host.${row.name} takes (${row.params.join(', ')}) as docs/plugins.md:${row.line} writes it`,
      `docs name ${row.params.length} parameter(s), the adapter's function takes ${method.length}`);
  }

  // What each call ANSWERS, with the docs line each promise comes from. The in-check backend
  // and sinks stand in for the app's half, the way a memory map stands in for a folder: these
  // pin the docs row to the reference answer the adapter gives over it. `save` and `refresh`
  // are only awaited over a backend that RESOLVES — host.mjs makes the two reject for an app
  // that has gone away, on purpose, and that simulation is not what the rows promise.
  const refused = hostFor(refusingBackend());

  // docs/plugins.md:118 — "Resolves with `{ok: true}` ... and never rejects."
  const wrote = await settled(() => host.save('journal.j', 'a 2\n'));
  check(!wrote.rejected && wrote.answer && keysOf(wrote.answer) === 'ok' && wrote.answer.ok === true,
    'host.save resolves with {ok: true} and never rejects', answered(wrote));
  // docs/plugins.md:118 — "`{error: "..."}`" is the other answer, when the file changed under it.
  const refusedWrite = await settled(() => refused.save('journal.j', 'a 2\n'));
  check(!refusedWrite.rejected && refusedWrite.answer && keysOf(refusedWrite.answer) === 'error'
    && typeof refusedWrite.answer.error === 'string',
    'host.save answers {error: "..."} when the backend refuses', answered(refusedWrite));

  // docs/plugins.md:119 — "Resolves with `{changed: [...], missing: [...]}` ... and never rejects."
  const lists = (answer) => !!answer && Array.isArray(answer.changed) && Array.isArray(answer.missing);
  const reread = await settled(() => host.refresh());
  check(!reread.rejected && lists(reread.answer) && keysOf(reread.answer) === 'changed, missing',
    'host.refresh resolves with {changed, missing} and never rejects', answered(reread));
  // docs/plugins.md:119 — "plus `error` if the browser refused something".
  const refusedReread = await settled(() => refused.refresh());
  check(!refusedReread.rejected && lists(refusedReread.answer) && keysOf(refusedReread.answer) === 'changed, error, missing',
    'host.refresh keeps {changed, missing} and adds error when the backend refuses', answered(refusedReread));

  // docs/plugins.md:117 — "One loaded file's contents, or `null`. Answers with the text
  // itself, not a promise: the plan is worked out synchronously."
  const text = host.read('journal.j');
  check(typeof text === 'string' && typeof text.then !== 'function',
    'host.read answers with the text itself, not a promise', `answered: ${JSON.stringify(text)}`);
  const nowhere = host.read('not-opened.j');
  check(nowhere === null, 'host.read answers null for a file it does not have', `answered: ${JSON.stringify(nowhere)}`);

  // docs/plugins.md:116 — "The loaded files, as an array of `{path, writable, main}`." The
  // probe's folder holds the one journal, so the shape is looked at rather than passed over
  // on an empty list.
  const files = host.files();
  check(Array.isArray(files) && files.length === 1 && files.every((file) => keysOf(file) === 'main, path, writable'
      && typeof file.path === 'string' && typeof file.writable === 'boolean' && typeof file.main === 'boolean'),
    'host.files answers an array of {path, writable, main}', `answered: ${JSON.stringify(files)}`);

  // docs/plugins.md:114-115 — "A setting this plugin remembered, or `null`", over the store
  // host.mjs keeps when a check hands in none of its own.
  check(host.setting('fontsize') === null,
    'host.setting answers null for a setting never remembered', `answered: ${JSON.stringify(host.setting('fontsize'))}`);
  host.remember('fontsize', '14');
  check(host.setting('fontsize') === '14',
    'host.setting answers what host.remember remembered', `answered: ${JSON.stringify(host.setting('fontsize'))}`);

  // docs/plugins.md:113 — "The colours of the theme in use: `background`, `foreground`,
  // `cursor`, `accent`, `dim`."
  check(keysOf(host.colors()) === 'accent, background, cursor, dim, foreground',
    'host.colors answers the five colours of the theme', `answered: ${JSON.stringify(host.colors())}`);

  // docs/plugins.md:112 — "returns a handle with `write(html)` and `close()`, or `null` if
  // the browser blocked it": the row allows either, so the handle is the one opened here.
  const opened = host.window('contract');
  check(opened === null || (typeof opened.write === 'function' && typeof opened.close === 'function'),
    'host.window answers null or a handle with write and close', `answered: ${opened === null ? 'null' : keysOf(opened)}`);

  // docs/plugins.md:110 — "Runs hledger and resolves with its standard output."
  const ran = await settled(() => host.hledger('balance -O csv'));
  check(!ran.rejected && typeof ran.answer === 'string',
    'host.hledger resolves with its standard output', answered(ran));
  // docs/plugins.md:110 — "Rejects with the reason it could not run."
  const broken = makeHost({ ...sinks(), hledger: async () => { throw new Error('refused'); }, backend: memoryBackend() });
  const failed = await settled(() => broken.hledger('balance'));
  check(!!failed.rejected && failed.rejected.message === 'refused',
    'host.hledger rejects with the reason it could not run', answered(failed));

  // The two lists at the top have to cover the table: a new row fails here until someone
  // writes down what it answers, or that it answers nothing.
  const uncovered = rows.filter((row) => !ANSWERED.has(row.name) && !NO_ANSWER.has(row.name)).map((row) => row.name);
  check(!uncovered.length, 'every docs row has an answer asserted or a stated reason not to',
    `no answer assertion for: ${uncovered.join(', ')}`);
} catch (error) {
  check(false, 'the three sources could be read', error && error.message ? error.message : String(error));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
