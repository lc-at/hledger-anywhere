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
| `journal` | List the uploaded files and mark the one being read. |
| `journal <path>` | Read a different uploaded file. |
| `clear` | Clear the screen. |
| `?` | The app's own help, with the engine's version and checksum. |

Keys: **Enter** runs, **↑/↓** recall history, **Tab** completes hledger commands,
flags and uploaded paths, **Ctrl+U** or **Ctrl+C** clears the line, **Ctrl+L**
clears the screen. `hledger help` has the rest.

**Uploaded files come back on the next visit** — they are stored in IndexedDB, and
the terminal says how many it resumed and which file it is reading. That cache is
a convenience and never the source of truth: a browser that will not store
anything (private mode, storage disabled) behaves exactly like a first visit, and
says so once.

Two things to know about running commands. The engine handles **one command at a
time** and cannot be interrupted — a synchronous `_start()` inside its worker — so
anything typed while a command runs is buffered and replayed when it finishes, and
Ctrl+C clears the line rather than stopping the engine. And stdout over **2 MB** is
truncated with a note, because `hledger print` on a real journal is tens of
megabytes and writing that to the terminal stalls the tab.

## Running it

```sh
sh scripts/build-hledger-wasm.sh   # once: builds hledger.wasm (~13 MB, needs the
                                   # ghc-wasm toolchain; see the script's comments)
. scripts/env.sh                   # puts .tools/bin on PATH, redirects caches
trunk serve                        # http://127.0.0.1:8080
```

`trunk build --release` produces `dist/`, which is all you deploy. A
`pre_build` hook resolves `assets/wasm/hledger.wasm` before every build: from
`artifacts/hledger.wasm` if you built it locally, otherwise by downloading the
release asset pinned by size and SHA-256 in `wasm.lock`. Without it the app still
builds, and the terminal says the engine is missing.

## How it fits together

```
index.html          the shell: a <div>, xterm.js, and the WASI bridge
assets/js/          hledger-worker.js   the WASI runtime, off the main thread
                    hledger-wasi.js     the main-thread bridge, window.hledgerWasi
                    vendor/wasi/        browser_wasi_shim (MIT), vendored
                    vendor/xterm/       xterm.js (MIT), vendored
assets/wasm/        hledger.wasm, gitignored, resolved from wasm.lock
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

- **Reports are formatted to hledger's default width.** hledger asks the terminal
  how wide it is; WASI has no terminal, so it falls back to 80 columns however wide
  the window is. `hledger-wasm/terminal-size-stub/` is the hook if that ever needs
  changing, but it means rebuilding and republishing the pinned artifact.
- **A running command cannot be cancelled** — see above.
- **Uploads replace rather than accumulate**, and only files are uploaded, not
  directories. Files with the same name collide, and the second is reported rather
  than silently shadowing the first.
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
Pages. One-time settings, and the DNS `CNAME` record `hledger` →
`<owner>.github.io`, are described at the top of that workflow.

## Licensing

This project is **AGPL-3.0-or-later**. hledger itself is GPL-3.0-or-later and is
loaded as a separate WASI module, never linked in; the vendored JavaScript, the
build stubs and the reason they exist are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
