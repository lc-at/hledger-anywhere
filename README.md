# hledger-anywhere

A terminal for [hledger](https://hledger.org), running entirely in your browser.

The real hledger CLI — the pinned **1.52.4** build for `wasm32-wasi` — runs in a
Web Worker, and everything you type goes to it unchanged. Nothing is uploaded to a
server, because there is no server: the whole thing is static files.

```
hledger-anywhere — hledger 1.52.4 (wasm32-wasi), running entirely in this tab.
No journal is loaded. Type `upload` to add hledger journal files, or `?` for help.
$ upload
Uploaded 2 file(s).
  extra.journal
  hledger.journal
Reading `hledger.journal`. Try `hledger balance`.
$ balance --tree
       $2,597.50  assets:bank:checking
      $-1,240.00  equity:opening balances
       $1,242.50  expenses
          $42.50    food:groceries
       $1,200.00    housing:rent
      $-2,600.00  income:salary
--------------------
              0
$
```

## Using it

Type hledger commands. A leading `hledger` is fine — `hledger balance` and
`balance` are the same thing — and **`-f` is never needed**: uploaded files are
mounted for the engine and the one being read is exported as `$LEDGER_FILE`, which
is the variable hledger already consults when no file is given.

Four words are the app's own; everything else is hledger's, verbatim:

| Command | What it does |
|---|---|
| `upload` | Choose files to add. **Replaces** what is loaded, so uploading the same set again is how you update it. |
| `upload_dir` | Choose a folder to add, keeping the paths inside it — what a journal split into `2024.journal`, `2025.journal` and `prices/` needs. |
| `journal` | List the uploaded files and mark the one being read. |
| `journal <path>` | Read a different uploaded file. |
| `demo` | Load a small built-in journal, so the app can be tried without uploading anything. |
| `/text` | Search what commands have printed; `n` and `N` repeat it forwards and backwards, and it says which match you are on. |
| `download <path>` | Save a file a command wrote with `-o`. |
| `alias` | List your aliases. `alias bal=balance --tree` defines one; the app says which one expanded when a command runs. |
| `unalias <name>` | Remove one. |
| `clear` | Clear the screen. |
| `?` | The app's own help, with the engine's version and checksum. |

**Reports are as wide as the terminal, as far as hledger makes them.** hledger
normally asks the operating system how wide the terminal is, and WASI has no
terminal to ask; the wasm build's `terminal-size` stub reads `$COLUMNS` and
`$LINES` instead, and the app exports the xterm size into every run's environment
— including after a window resize, so widening the window widens the next report.
What hledger does with the width is hledger's business: `register` and `aregister`
lay their columns out to fill it, while `balance` and `print` size themselves to
their content and look the same at any width.

**Dropping files anywhere on the page** loads them, the same as `upload` — most
people reach for a drag before they read a help text, so the whole page accepts one
and outlines itself while a drag is over it. Dropped files land at the root of the
mount, like `upload`; a directory still needs `upload_dir`.

Keys: **Enter** runs, **Tab** completes hledger commands, flags, account names,
aliases and uploaded paths, **↑/↓** recall history, and **Ctrl+C stops a running
command**.

The **Emacs and readline keys** work as well, because that is what people who live
in a terminal already have in their fingers:

| | |
|---|---|
| `Ctrl+A` `Ctrl+E` | start / end of line |
| `Ctrl+B` `Ctrl+F` | back / forward one character |
| `Alt+B` `Alt+F` | back / forward one word |
| `Ctrl+P` `Ctrl+N` | previous / next history entry (same as ↑/↓) |
| `Ctrl+R` | reverse search the history, incremental — type to narrow, `Ctrl+R` again to go further back, `Enter` to run, `Ctrl+G` to cancel |
| `Ctrl+K` `Ctrl+U` `Ctrl+W` | kill to end / to start / the word before the cursor |
| `Ctrl+Y` | yank the most recent kill |
| `Ctrl+T` | transpose the two characters around the cursor |
| `Ctrl+D` `Ctrl+H` | delete forward / backward |
| `Ctrl+L` | clear the screen |

**Uploaded files come back on the next visit** — they are stored in IndexedDB, and
the terminal says how many it resumed and which file it is reading. That cache is
a convenience and never the source of truth: a browser that will not store
anything (private mode, storage disabled) behaves exactly like a first visit, and
says so once.

Two things to know about running commands. The engine handles **one command at a
time**; anything typed while a command runs is buffered and replayed when it
finishes. **Ctrl+C stops it** by throwing the engine's worker away — the engine is
one synchronous `_start()` and cannot be asked to stop, so the next command starts
a fresh worker and recompiles the module (from the HTTP cache, so it costs a
compile rather than a download). And stdout over **2 MB** is truncated, because
`hledger print` on a real journal is tens of megabytes and writing that to the
terminal stalls the tab: the note says to use `-o out.csv` and `download out.csv`,
which writes the whole thing and hands it to you as a file.

Account names are fetched for completion the **first time you press Tab** with a
journal loaded, not at startup: on a large journal that fetch is a whole engine run
(the same one `hledger accounts` does), and it should be something you asked for.

## Running it

```sh
sh scripts/build-hledger-wasm.sh   # once: builds hledger.wasm (~13 MB, needs the
                                   # ghc-wasm toolchain; see the script's comments)
. scripts/env.sh                   # puts .tools/bin on PATH, redirects caches
trunk serve                        # http://127.0.0.1:8080
```

`trunk build --release` produces `dist/`, which is all you deploy.

**The engine is fetched, not committed.** It is 13 MB and changes once per hledger
version, so `wasm.lock` pins it by URL, size and SHA-256, and a `pre_build` hook
downloads and verifies it — preferring `artifacts/hledger.wasm` when you have just
built one locally, so changing a build input is enough to change the engine. A file
that does not match the lock is rejected rather than run, and if none is available
the app still builds and the terminal says the engine is missing.

Publishing a new engine after changing `hledger-wasm/` (the stubs, or the cabal
project): build it, update `size` and `sha256` in `wasm.lock`, then push a `wasm-*`
tag — [publish-engine.yml](.github/workflows/publish-engine.yml) attaches the
artifact to that tag's release using the runner's own token, because a release
needs the GitHub API. Point `url` at the asset it publishes.

## How it fits together

```
index.html          the shell: a <div>, xterm.js, and the WASI bridge
assets/js/          hledger-worker.js   the WASI runtime, off the main thread
                    hledger-wasi.js     the main-thread bridge, window.hledgerWasi
                    vendor/wasi/        browser_wasi_shim (MIT), vendored
                    vendor/xterm/       xterm.js (MIT), vendored
assets/wasm/        hledger.wasm, fetched at build time, verified against wasm.lock
src/terminal/       the line editor, the commands, the prompt (pure)
  view.rs           xterm.js, wrapped (wasm)
src/hledger/        the engine's request/response types, and the bridge to JS
src/journal.rs      choosing which uploaded file is the journal (pure)
src/upload.rs       the file picker (wasm)
src/store.rs        the IndexedDB cache (wasm)
hledger-wasm/       the cabal project and stubs used to build hledger for wasm
scripts/            build/fetch the engine, and run it natively for testing
```

The crate is split along a wasm boundary, enforced by `cfg`: the pure modules
compile for the host and are covered by `cargo test`, and no `web_sys` import can
leak into them.

Three decisions worth knowing:

- **The app owns the line, not a shell.** xterm renders and collects keystrokes;
  everything about what they mean lives in `src/terminal/mod.rs`, which is pure and
  tested. Redrawing the prompt is `\r`, clear, write, and step the cursor back —
  which is why the editor can be plain data.
- **The file picker opens synchronously, inside the key handler.** A picker opened
  after an `await` is refused *silently* by the browser: no error, no dialog, a
  promise that never settles. See `src/upload.rs`.
- **There is one engine.** The earlier build carried a fallback artifact with a
  different argv dialect; the terminal needs neither, so `Flavor` and the interim
  bridge are gone.

## Testing

```sh
cargo test                                  # the pure modules
cargo clippy --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets -- -D warnings

# The shipped engine, natively, without a browser:
node --experimental-wasi-unstable-preview1 scripts/hledger-wasm.mjs \
    path/to/hledger.journal balance --tree
HLEDGER_NO_FILE_ARG=1 node --experimental-wasi-unstable-preview1 \
    scripts/hledger-wasm.mjs path/to/hledger.journal balance
```

That last form is the one that matters: it mounts the journal at `/data` and
exports `LEDGER_FILE`, which is exactly what the app does, so a bare `balance`
can be checked without a browser. CI runs it, along with the tests and lints,
before building.

## Known limitations

- **A cancelled command restarts the engine.** The worker is replaced and the
  module recompiled, which takes a moment on the next command.
- **Uploads replace rather than accumulate.** Two files landing on the same path
  collide, and the second is reported rather than silently shadowing the first.
- **The width only reaches hledger because the engine was built that way.**
  Anything running this engine outside the app gets hledger's 80-column default,
  since nothing else sets `$COLUMNS`.
- **The scrollback is the session's.** Reloading restores the files and the command
  history, not what was on screen.
- **`upload` is the only way in.** Drag-and-drop onto the terminal is not wired up.
- The deployed site is served over **HTTP**: `https://hledger.gru.fi` presents a
  `*.github.io` certificate, which browsers reject. Fixing it needs the domain to
  be re-verified in the repository's GitHub Pages settings — remove and re-add the
  custom domain, wait for the certificate, then enable **Enforce HTTPS**. Nothing
  in the repository can do it.

## Deploying

Pushing to `main` runs `.github/workflows/deploy-pages.yml`: tests, lints, an
engine smoke test, `trunk build --release`, and a publish of `dist/` to GitHub
Pages. Pushing a `wasm-*` tag runs `publish-engine.yml`, which publishes the engine
artifact itself. One-time settings, and the DNS `CNAME` record `hledger` →
`<owner>.github.io`, are described at the top of that workflow.

## Licensing

This project is **AGPL-3.0-or-later**. hledger itself is GPL-3.0-or-later and is
loaded as a separate WASI module, never linked in; the vendored JavaScript, the
build stubs and the reason they exist are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
