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
// Usage: node scripts/check-host-contract.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeHost } from './host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The loader's two, which the app adds in JavaScript rather than in `App::host`. */
const FROM_LOADER = new Set(['name', 'window']);

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

/** The method column of the host API table in docs/plugins.md. */
function fromDocs() {
  const source = readFileSync(join(ROOT, 'docs/plugins.md'), 'utf8');
  const at = source.indexOf('## The host API');
  if (at < 0) throw new Error('the `## The host API` section was not found in docs/plugins.md');
  const section = source.slice(at).split('\n## ')[0];
  const names = [...section.matchAll(/^\| `host\.(\w+)(?:\([^)]*\))?`/gm)].map((match) => match[1]);
  if (!names.length) throw new Error('the host API table in docs/plugins.md has no method rows');
  return new Set(names);
}

/** The methods the reference adapter gives, as every check sees them: the keys of a host. */
function fromAdapter() {
  const host = makeHost({
    name: 'contract',
    colors: () => ({}),
    say: () => {},
    window: () => null,
    hledger: async () => '',
    backend: {
      files: () => [],
      read: () => null,
      save: async () => ({ ok: true }),
      refresh: async () => ({ changed: [], missing: [] }),
    },
  });
  return new Set(Object.keys(host));
}

try {
  const rust = fromRust();
  const docs = fromDocs();
  const adapter = fromAdapter();
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
} catch (error) {
  check(false, 'the three sources could be read', error && error.message ? error.message : String(error));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
