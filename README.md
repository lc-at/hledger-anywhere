# hledger-anywhere

A terminal for [hledger](https://hledger.org), running entirely in your browser.

**Live: <https://hledger.gru.fi>**, nothing to install, and nothing to sign up for.

The real hledger CLI, the pinned **1.52.4** build for `wasm32-wasi`, runs in a Web
Worker, and everything you type goes to it unchanged. There is no server: the whole
application is static files. Nothing you load leaves the browser, except when you
deliberately connect a remoteStorage account (see [remoteStorage](#remotestorage)).

```
  hledger-anywhere  hledger 1.52.4 (wasm32-wasi)
  A terminal for hledger, running entirely in this tab.
  Drop journal files on this window, or type:
    upload       add journal files
    upload_dir   add a folder, keeping its structure
    demo         try the sample journal
    ?            every command and key
  No journal is loaded yet.
no journal » demo
Loaded the sample journal (2 files), reading hledger.journal.
hledger.journal » balance --tree
           $9,386.11  assets
           $9,278.61    bank
           $4,278.61      checking
           $5,000.00      savings
             $107.50    cash
          $-7,520.00  equity:opening balances
           $1,333.89  expenses
              $98.90    food
              $12.50      coffee
              $86.40      groceries
           $1,200.00    housing:rent
              $34.99    reading:books
          $-3,200.00  income:salary
--------------------
                   0
```

Every command in this README was run against the shipped engine; the output above is
copied from a real session, not written by hand.

## Contents

- [Using it](#using-it), commands, keys, quoting, search
- [Loading a journal](#loading-a-journal)
- [Editing, and getting data out](#editing-and-getting-data-out)
- [remoteStorage](#remotestorage)
- [Offline and installable](#offline-and-installable)
- [How it works](#how-it-works)
- [Building and running](#building-and-running)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Deploying](#deploying)
- [Licensing](#licensing)

## Using it

Type hledger commands. A leading `hledger` is optional, `balance` and
`hledger balance` are the same thing. **`-f` is never needed**: the loaded files are
mounted for the engine and the one being read is exported as `$LEDGER_FILE`, the
variable hledger already consults when no file is given.

### Quoting

The command line is split the way a shell splits one, which matters because hledger's
own syntax needs it: **a period expression with a space in it is one argument.**

```
balance -p "this year"                      one argument: this year
balance -p 'from 2024-01 to 2024-12'        single quotes work too
balance date:"this year"                    quotes inside a word
print -o "my report.csv"                a path with a space
```

Both quote styles are understood, and the quotes are removed. Outside quotes a
backslash escapes the next character; inside double quotes it escapes `"` and `\`;
single quotes are literal, as in a shell. An unclosed quote is reported rather than
guessed at:

```
$ balance -p "this year
A double quote is not closed. Add the " it needs.
```

Because quotes are special, a literal one needs `\"`.

### The app's own commands

Everything that is not in this table is passed to hledger verbatim.

| Command | What it does |
|---|---|
| `upload` | Choose files to add. **Replaces** what is loaded, so uploading the same set again is how you update it. Up to 5 MB per file, 50 MB in total. |
| `upload_dir` | Choose a folder, keeping the paths inside it, what a journal split into `2024.journal`, `2025.journal` and `prices/` needs. |
| `demo` | Load a small built-in journal, so the app can be tried without uploading anything. |
| `journal` | List the loaded files and mark the one being read. |
| `journal <path>` | Read a different loaded file. |
| `download <path>` | Save a file into your browser's downloads. |
| `alias` | List your aliases. |
| `alias name=cmd` | Make `name` run `cmd`. The app says which alias expanded when a command runs. |
| `unalias <name>` | Remove one. |
| `/text` | Search what commands have printed. |
| `n` / `N` | Repeat that search forwards / backwards. |
| `connect user@host` | Connect a remoteStorage account. |
| `remote [dir]` | Load every file under `/hledger/` (or a folder inside it) from that account. |
| `disconnect` | Forget the account; the files already loaded stay loaded. |
| `font [size]` | Show or set the font size, 8 to 32 px. |
| `screenreader` | Turn xterm's accessibility tree `on` or `off`. |
| `clear` | Clear the screen. |
| `plugins [add\|remove\|reload]` | List the installed plugins, or install a repository by URL or path. One is bundled. |
| `settings [export\|import]` | Show what is remembered, or move it between instances as a file. `import` opens the file picker. |
| `theme [name]` | List the colour themes, or select one. Plugin themes are listed too. |
| `find <text>` | Search everything printed so far; `n` and `N` step through the matches. `/text` does the same. |
| `?` | The app's own help, the engine's version and its checksum. |

### Keys

**Enter** runs. **Tab** completes hledger's commands and flags, account names, your
aliases, and the paths of loaded files. When there is more than one option left, a
second Tab lists them in columns and puts the first on the line; every Tab after that
steps to the next one, Shift+Tab steps back, and Escape puts back what you typed. The
choice is made by pressing Tab, not by typing the rest of it. While a command runs, the
window title says which one, since a report on a large journal takes a few seconds and
the terminal is silent until it has something to print. **↑/↓** recall history (the last 100
commands, kept between visits). **Ctrl+C** stops a running command, or clears the
line.

The Emacs and readline keys work too, because that is what people who live in a
terminal already have in their fingers:

| Keys | |
|---|---|
| `Ctrl+A` `Ctrl+E` | start / end of line |
| `Ctrl+B` `Ctrl+F` | back / forward one character |
| `Alt+B` `Alt+F` | back / forward one word |
| `Ctrl+P` `Ctrl+N` | previous / next history entry (same as ↑/↓) |
| `Ctrl+R` | reverse search the history, incremental, type to narrow, `Ctrl+R` again to go further back, `Enter` to run, `Ctrl+G` to cancel |
| `Ctrl+K` `Ctrl+U` `Ctrl+W` | kill to end / to start / the word before the cursor |
| `Ctrl+Y` | yank the most recent kill |
| `Ctrl+T` | transpose the two characters around the cursor |
| `Ctrl+D` `Ctrl+H` | delete forward / backward |
| `Ctrl+L` | clear the screen |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | bigger / smaller / default font, `font <size>` for a phone |

### Searching the output

`/text` searches what commands have printed and says which match you are on; `n` and
`N` step through matches, wrapping at the ends. The app's own lines, your command
echoes and its messages, are excluded, so searching for what you just typed does not
find the thing you typed it into.

Account names for completion are fetched the **first time you press Tab** with a
journal loaded, rather than at startup: on a large journal that fetch is a whole
engine run, and it should be something you asked for.

## Loading a journal

Four ways in, and all of them end with the same result: files mounted for the engine,
one of them chosen as the journal to read and shown in the prompt.

- **`upload`**, pick files.
- **`upload_dir`**, pick a folder, keeping its structure.
- **Drag and drop** files anywhere on the page; it outlines itself while a drag is
  over it. Dropped files land at the root, like `upload`.
- **`demo`**, a small built-in journal, in two files so that `include` resolves.

Which file is read is chosen by looking for the journal the others are included
*from*, so a journal split across files with `include` works without being told how.
`journal` lists them all and marks the one in use.

What is loaded is remembered in IndexedDB, so the next visit resumes it and says so.
That cache is a convenience, never the source of truth: a browser that will not store
anything (private mode) behaves exactly like a first visit.

## Getting data out

**A report can be written to a file.** `-o FILE` writes into the mount, and the app
keeps what a command wrote as part of the loaded files, so the next command can read
it.

**Getting a file out of the browser** is `download <path>`, which saves it through the
browser's own download. Everything loaded is also in IndexedDB, and a journal synced
through [remoteStorage](#remotestorage) is in your own account.

**What a command writes lasts for this visit.** The file is in the engine's filesystem
and in the list `download` reads, and it is deliberately not stored: an exported report
is something you take away, not something that joins your journal.

## Plugins

Commands the app does not implement itself are plugins, loaded at runtime. A plugin is a
JavaScript module listed in a repository manifest. One repository is bundled and installed
at every start, so its commands are simply there:

```
hledger.journal » chart expenses
chart: 3 months of expenses, $1200.00 last, in a new window.
```

The bundled repository is `/plugins/plugins.json`, and its `chart` plugin opens a balance
line chart in a window of its own, using hledger's own numbers from
`balance expenses -M -O csv`. It also carries the colour themes. Nothing about it is in the
app's core: remove it with `plugins remove /plugins/plugins.json` and it is back on the next
visit, because bundled is where it came from, not what it is.

```
hledger.journal » plugins
1 plugin, installed
  chart           open a balance line chart in a window
Repositories
  /plugins/plugins.json  bundled

plugins reload reads them again; plugins remove <url> forgets one.
```

A repository you add yourself works the same way:

```
hledger.journal » plugins add https://example.invalid/plugins.json
Read 2 plugins from https://example.invalid/plugins.json: chart, forecast.
```

The manifest is authoritative for the words, the help text and the completion, so an
installed repository costs one fetch and runs no code until one of its commands is used.
Plugins get a small API and nothing more: `host.hledger(command)` to run hledger,
`host.say(text)` to print, `host.window(title)` to open a window, and their own settings.
The read-only rule applies to them exactly as it does to the command line, so a plugin
cannot change a journal either.

A plugin is code running in this page, so installing a repository is trusting it. See
[docs/plugins.md](docs/plugins.md) for the manifest fields, the API, and a worked example.

## Themes

The terminal is painted by a theme, and a plugin repository can contribute them. `theme`
lists what is on offer, marked with the one in use:

```
hledger.journal » theme
Themes
 * default      built in (in use)
   gruvbox      from hledger-anywhere plugins
   midnight     from hledger-anywhere plugins

theme <name> selects one and keeps it; plugin themes come from the repositories you install.
```

The bundled repository carries **gruvbox**, dark and warm, and **midnight**, dark and blue.
`theme gruvbox` repaints the terminal, the page behind it, and the colours the app writes
its own text in, without a reload: xterm takes colours as options, so the scrollback stays
where it was. Text already on screen keeps the colours it was written with, since the app
writes those explicitly; the palette behind it changes, and everything after it arrives in
the new theme. The choice is in the settings, so the next visit starts in it, and
`settings export` carries it to another instance.

A theme is a handful of colours by role: `background`, `foreground`, `cursor`, `accent`
(the prompt marker and the selected line) and `dim` (the app's asides). A role that is not
set keeps the built-in colour, so a plugin that sets one colour gets a usable theme rather
than a half-painted terminal, and a colour that cannot be read is reported with the role
that got it wrong.

## Settings, and moving them

The font, the accessibility setting, the aliases, the selected theme, the installed plugin
repositories and each plugin's own settings are one record, kept in this browser:

```
hledger.journal » settings
Settings, remembered between visits
  font            14px
  screen reader   off
  theme           default
  aliases         2
  repositories    ./examples/plugins/plugins.json
  plugin settings 1
  plugins installed 1
```

`settings export` writes that record to a file through the browser's own download, and
`settings import <path>` reads one back after you upload it. Import is forgiving on
purpose: a missing field takes its default, an unknown field is ignored rather than
refused, and anything unusable is reported rather than silently applied. That is what
makes it safe to carry settings from an older or a newer instance, or from a file you
edited by hand.

## Read-only, for now

This session cannot change a journal, and that is on purpose. The job here is to read
and report, and a report is easier to trust when nothing it read has changed underneath
it.

What that means:

- **`add` and `import` are refused**, with a message saying so. They are the two
  hledger commands that write to the journal it reads. `add` could not work here in any
  case: the engine is one run with no way to prompt for an entry.
- **`-o` may not write over a loaded file.** A new name is how a report is saved; the
  name of a loaded journal is refused, because that would be an edit to it.
- **`>>`, `append` and `put` are gone.** Loading files, running reports, saving a
  report with `-o`, and `download` all still work.

Nothing a run writes is kept, so no command can leave a loaded file different from how
it arrived.

## remoteStorage

[remoteStorage](https://remotestorage.io) is how the journal follows you between
devices without this app running a server: the files live in an account you choose,
and the browser talks to it directly.

```
no journal » connect you@host     leaves for the consent screen, and comes back
Connected to your storage account. remote loads the journals in it.
no journal » remote               walks /hledger/, mounts every file like an upload
Read 4 files from /hledger/.
```

Paths are re-rooted at the category, so `/hledger/books/2024.journal` becomes
`books/2024.journal` in the mount, the same shape an upload produces, which keeps an
`include` between files in different folders working. Files have to live under the
`hledger` category, because remoteStorage grants access one category at a time;
changing which one is a one-line change in `src/remote/mod.rs`.

The library is 146 KB and is loaded when you first use a remote command, or
immediately on the page that comes *back* from `connect`, because the access token
arrives in the URL fragment and has to be claimed before it is gone. A file in your
account that cannot be read is skipped and named rather than stopping the sync.

## Offline and installable

A service worker caches the shell and the 13 MB engine, so a second visit needs no
network, including running hledger, which works with the network switched off. There
is a web app manifest and icons, so it can be installed on a phone home screen, which
is where "anywhere" is most useful.

The engine's URL carries its SHA-256, so it is immutable and is served from the cache
without ever being revalidated; everything else is network-first with a cache
fallback, so an online visitor gets the current build and an offline one gets the
last.

The engine is compiled when a command needs it, and compiling 13 MB is the slow part of
a first command, not fetching it. So the app starts that as soon as you type something:
the first keystroke is the earliest honest sign that this visit will run a command, and
the compile proceeds while you finish typing. Someone who only reads the banner pays
nothing. If a run does have to wait, it says so rather than sitting silent, and the
window title says which command is running.

## How it works

```
index.html                  the shell: a <div>, xterm.js, and the WASI bridge
sw.js, manifest.webmanifest  offline support and installability
assets/js/
  hledger-worker.js         the WASI runtime, off the main thread
  hledger-wasi.js           the main-thread bridge, window.hledgerWasi
  vendor/*.js               browser_wasi_shim (MIT), vendored flat: wasi.js binds
                            it, fs_mem.js is the in-memory filesystem the engine
                            is given, fs_opfs.js is one we do not use
  vendor/xterm/             xterm.js (MIT), vendored
  vendor/remotestorage/     remoteStorage.js (MIT), vendored, loaded on demand
assets/wasm/                hledger.wasm, fetched at build time, verified against wasm.lock
assets/icons/               drawn by scripts/make-icons.py
src/terminal/mod.rs         the line editor, commands, quoting, search (pure)
src/terminal/view.rs        xterm.js, wrapped (wasm)
src/plugins/mod.rs          the plugin contract (pure)
src/remote/mod.rs           remoteStorage paths and listings (pure)
src/remote/client.rs        the remoteStorage library, glued in (wasm)
src/hledger/                the engine's request/response types, and the JS bridge
src/journal.rs              choosing which file is the journal (pure)
src/upload.rs               the file picker (wasm)
src/store.rs                the IndexedDB cache (wasm)
src/app.rs                  wiring: input, dispatch, and what the terminal shows (wasm)
hledger-wasm/               the cabal project and stubs used to build hledger for wasm
scripts/                    build/fetch the engine, run it natively, draw the icons
```

The crate is split along a wasm boundary, enforced by `cfg`: the pure modules compile
for the host and are covered by `cargo test`, and no `web_sys` import can leak into
them. That is why the line editor, the quoting rules, the search matcher, the
read-only rules and the remoteStorage path handling are all testable without a
browser.

**Plugins are how commands beyond the core's own are added.** The core is a terminal,
a set of loaded files, and a way to run hledger on them. A plugin declares a word, how
it reads in the help, what it adds to completion, and what to do with the text typed
after it; it never touches the app, which is what keeps it testable. It can also say
how to present the output it caused, or return nothing and get the ordinary terminal.

Nothing is bundled today. The first plugin was `chart`, which drew a report in the
terminal, and the tool it drew has been removed: a picture belongs in the plugin that
wants one, not in the core that runs reports. The contract is being reworked so a
plugin can be installed at runtime, from a repository, without rebuilding the app.

Three decisions worth knowing:

- **The app owns the line, not a shell.** xterm renders and collects keystrokes;
  everything about what they mean lives in `src/terminal/mod.rs`. Redrawing the prompt
  is `\r`, clear, write, and step the cursor back, which is why the editor can be
  plain data.
- **The file picker opens synchronously, inside the key handler.** A picker opened
  after an `await` is refused *silently* by browsers: no error, no dialog, a promise
  that never settles. See `src/upload.rs`.
- **The mount is rebuilt from the app's files before every command**, and the worker
  reports what the run changed. The app is the source of truth; the engine's
  filesystem is a copy of it. That is what makes `-o` work without the engine knowing
  anything about storage, and what makes it possible to refuse a run that would write
  over a loaded file.

**Reports are as wide as the terminal, as far as hledger makes them.** hledger normally
asks the operating system how wide the terminal is, and WASI has no terminal to ask;
the wasm build's `terminal-size` stub reads `$COLUMNS` and `$LINES` instead, and the
app exports xterm's size into every run's environment, including after a window
resize. What hledger does with it is hledger's business: `register` and `aregister`
lay their columns out to fill the width, while `balance` and `print` size themselves to
their content and look the same at any width.

## Building and running

[Trunk](https://trunkrs.dev) builds it; the toolchain is wasm32-unknown-unknown with
Rust 2024 edition (MSRV 1.88).

```sh
sh scripts/build-hledger-wasm.sh   # once: builds hledger.wasm (~13 MB; needs the
                                   # ghc-wasm toolchain, see the script's comments)
. scripts/env.sh                   # puts .tools/bin on PATH, redirects caches
trunk serve                        # http://127.0.0.1:8080
trunk build --release              # writes dist/, which is all you deploy
```

**The engine is fetched, not committed.** It is 13 MB and changes once per hledger
version, so `wasm.lock` pins it by URL, size and SHA-256, and a `pre_build` hook
downloads and verifies it, preferring `artifacts/hledger.wasm` when you have just
built one locally. A file that does not match the lock is rejected rather than run,
and if none is available the app still builds and the terminal says the engine is
missing.

## Testing

```sh
cargo test                                  # the pure modules
cargo clippy --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets -- -D warnings

# The shipped engine, natively, without a browser:
node --experimental-wasi-unstable-preview1 scripts/hledger-wasm.mjs \
    path/to/hledger.journal balance --tree

# The form that mirrors the app: journal mounted at /data, LEDGER_FILE exported,
# so a bare `balance` can be checked without a browser.
HLEDGER_NO_FILE_ARG=1 node --experimental-wasi-unstable-preview1 \
    scripts/hledger-wasm.mjs path/to/hledger.journal balance
```

CI runs the tests, both lints, that engine smoke test, and then the build.

Beyond the tests, the behaviour in this README was verified by driving the running
app in a browser: a first run with the session cleared, completion read off the
screen, an interrupted long command, offline mode with the network actually off, a real
`ClipboardEvent` paste, and the whole remoteStorage round trip, connect, `put`, and
reading the journals back into a fresh browser, against a real
[armadietto](https://github.com/remotestorage/armadietto) server on `127.0.0.1`. The
`put` half of that is gone with the other writers; the reading half still stands.

## Known limitations

- **Read-only.** Nothing changes a journal: `add` and `import` are refused, `-o` may
  not write over a loaded file, and files a command writes last only for the visit.
  Loading a journal and running reports on it is the whole of it for now.
- **No interactive commands.** The engine is a single synchronous `_start()` call, so
  nothing can be prompted part-way through, which is the other reason `hledger add`
  cannot work.
- **A cancelled command restarts the engine.** Ctrl+C throws the worker away; the next
  command starts a fresh one and recompiles the module (from the HTTP cache, so it
  costs a compile rather than a download).
- **Output over 2 MB is truncated.** `hledger print` on a real journal is tens of
  megabytes and writing that to the terminal stalls the tab. The note says to use
  `-o out.csv` and then `download out.csv`, which writes the whole thing.
- **Uploads replace rather than accumulate**, and are capped at 5 MB per file and
  50 MB in total. Two files landing on the same path collide, and the second is
  reported rather than silently shadowing the first.
- **Files deleted by a command are not noticed.** Nothing does this today.
- **The scrollback belongs to the session.** A reload restores the files and the
  command history, not what was on screen.
- **The terminal's quoting is shell-like**, so a literal `"` in an argument needs
  `\"`.
- **The width only reaches hledger because the engine was built that way.** Anything
  running this engine outside the app gets hledger's 80-column default, since nothing
  else sets `$COLUMNS`.

**Why not OPFS?** A file-backed filesystem in the browser has been considered since
before the engine could write at all, and the vendored shim even ships one
(`SyncOPFSFile`). It was measured rather than assumed: posting an 8 MB file set to the
worker costs about **23 ms**, and the size barely matters, 0.25 MB and 8 MB cost the
same, because it is message overhead, not copying, while hledger's own runtime is
seconds. IndexedDB holds what is loaded, the worker gets a copy per run, and none of
that is worth replacing.

## Deploying

Pushing to `main` runs
[deploy-pages.yml](.github/workflows/deploy-pages.yml): tests, both lints, an engine
smoke test, `trunk build --release`, a check that the service worker, manifest and
icons are in `dist/`, and a publish to GitHub Pages. Pushing a `wasm-*` tag runs
[publish-engine.yml](.github/workflows/publish-engine.yml), which attaches the engine
artifact to that tag's release using the runner's own token, because publishing a
release needs the GitHub API.

To publish a new engine after changing `hledger-wasm/`: build it, update `size` and
`sha256` in `wasm.lock`, push a `wasm-*` tag, and point `url` at the asset it
publishes, the header of `wasm.lock` has the exact commands.

The site is served over HTTPS; `http://` redirects to it.

## Licensing

This project is **AGPL-3.0-or-later**. hledger itself is GPL-3.0-or-later and is
loaded as a separate WASI module, never linked in; the vendored JavaScript, the build
stubs and the reason they exist are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
