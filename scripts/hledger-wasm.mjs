#!/usr/bin/env node
//
// Run the shipped hledger engine natively, without a browser.
//
// The same `assets/wasm/hledger.wasm` the app serves, executed under Node's WASI
// implementation. That makes it possible to check what a report actually
// contains — its exact JSON, its exit code, whether a flag does anything at all
// — in a second, instead of booting a browser and reading it off a panel.
//
// It is deliberately the *shipped* module rather than a locally installed
// hledger: the point is to test the engine the app will run, at the version the
// app pins. A system hledger can be a different version with different
// behaviour, which is exactly how a feature can look broken locally and work
// deployed, or the reverse.
//
// Usage:
//   node --experimental-wasi-unstable-preview1 scripts/hledger-wasm.mjs \
//       <journal> [hledger args...]
//
// With HLEDGER_NO_FILE_ARG=1 the journal is not passed as -f. Instead its
// directory is mounted at /data and LEDGER_FILE points at the journal there,
// which is exactly what the app does — so this reproduces a bare
// `hledger balance` from the terminal, the case that has to keep working.
//
// Example:
//   node --experimental-wasi-unstable-preview1 scripts/hledger-wasm.mjs \
//       fixtures/demo/hledger.journal balance --pivot payee
//
// The journal's directory is mounted at `/data`, because that is where the app
// mounts a loaded directory and where its `-f /data/<name>` argv points. Any
// `include` in the journal therefore resolves relative to its own directory,
// exactly as it does in the browser.
//
// Env:
//   HLEDGER_WASM   path to the engine (default: assets/wasm/hledger.wasm)

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve, relative } from 'node:path';
import { WASI } from 'node:wasi';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    'usage: hledger-wasm.mjs <journal> [hledger args...]\n' +
      '  run with: node --experimental-wasi-unstable-preview1 ' +
      relative(process.cwd(), import.meta.filename),
  );
  process.exit(2);
}

const engine = resolve(process.env.HLEDGER_WASM ?? 'assets/wasm/hledger.wasm');
const journal = resolve(args[0]);
/** When set, run as the app does: no -f, LEDGER_FILE instead. */
const noFileArg = process.env.HLEDGER_NO_FILE_ARG === '1';

let module;
try {
  module = readFileSync(engine);
} catch (error) {
  console.error(`cannot read the engine at ${engine}: ${error.message}`);
  console.error('build it with scripts/build-hledger-wasm.sh, or set HLEDGER_WASM');
  process.exit(2);
}

const wasi = new WASI({
  version: 'preview1',
  // The same minimal environment the app's worker passes. `HOME=/` is the one
  // that matters here: without it hledger asks WASI for the effective user id to
  // find a home directory, and WASI answers "unsupported operation". `PATH=/`
  // matters because hledger *looks up* PATH for add-on executables rather than
  // defaulting when it is missing.
  env: {
    HOME: '/',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    PATH: '/',
    PWD: '/',
    // Only set in the no-file-arg mode, where it replaces -f.
    ...(noFileArg ? { LEDGER_FILE: `/data/${basename(journal)}` } : {}),
  },
  args: noFileArg
    ? ['hledger', ...args.slice(1)]
    : ['hledger', '-f', `/${basename(journal)}`, ...args.slice(1)],
  // The journal's own directory is the WASI root, which the GHC runtime needs:
  // it chdir's to the working directory during start-up and aborts with
  // `chdir(/) failed` if `/` is not a preopen. The app preopens `/` the same way
  // (with files under `data/`); this just has one less level.
  // `/` is what the GHC runtime needs (see below). `/data` is where the app
  // mounts uploaded files, so the no-file-arg mode mounts the journal's
  // directory there as well and points LEDGER_FILE into it.
  preopens: noFileArg
    ? { '/': dirname(journal), '/data': dirname(journal) }
    : { '/': dirname(journal) },
  // Report the exit code instead of throwing, so a failing report prints its
  // own error and this script's status is the engine's status.
  returnOnExit: true,
});

const { instance } = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exit(wasi.start(instance) ?? 0);
