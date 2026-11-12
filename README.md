# hledger-anywhere

A terminal for [hledger](https://hledger.org) that runs entirely in your browser.

**Live: <https://hledger.gru.fi>**. Nothing to install, nothing to sign up for.
The real hledger CLI, pinned at **1.52.4** and compiled for `wasm32-wasi`, runs in a Web
Worker, and everything you type goes to it unchanged. There is no server: the whole
application is static files, and nothing you load leaves the browser.

```
hledger-anywhere  hledger 1.52.4 · wasm sha256 acd7c4e955b1…
A terminal for hledger, running entirely in this tab.
Drop journal files on this window, or type:
upload  add journal files
open    open a folder on disk, editable
demo    load the sample journal
?       this help; put ? after a command for that one
```

## Quick start

Type `demo` for a small built-in journal, then any hledger command:

```
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

**`-f` is never needed.** Loaded files are mounted for the engine, and the one being read
is exported as `$LEDGER_FILE`, which hledger already consults when no file is given. A
leading `hledger` is optional.

The command line splits like a shell, so a period expression with a space in it is one
argument. Both quote styles work and the quotes are removed; a literal `"` needs `\"`.
`balance -p "this year"`, `print -o "my report.csv"`.

## The app's own commands

Everything not in this table is passed to hledger verbatim. `<command>?` prints a page for
any command, the app's own and hledger's (`balance?`).

| Command | What it does |
|---|---|
| `upload` | Choose files. **Replaces** what is loaded. Up to 5 MB per file, 50 MB total. |
| `open` | Choose a folder on disk, keeping its paths and staying editable. |
| `reopen` | Take back a remembered folder's write access after a reload. |
| `demo` | Load the built-in sample journal. |
| `journal [path]` | List the loaded files, or read a different one. |
| `download <path>` | Save a file into your browser's downloads. |
| `find <text>` | Search what commands printed. `/text` does the same, and `n`/`N` step through matches. |
| `alias` | List your aliases. |
| `alias name=cmd` | Make `name` run `cmd`. |
| `unalias <name>` | Remove one. |
| `font [size]` | Show or set the font size, 8 to 32 px. |
| `screenreader` | Turn xterm's accessibility tree on or off. |
| `clear` | Clear the screen. |
| `theme [name]` | List colour themes, or select one. |
| `plugins [add\|remove\|reload]` | List installed plugins, or manage repositories. |
| `settings [export\|import]` | Show what is remembered, or move it between instances. |
| `?` | Help, the engine's version and checksum. |

## Keys

**Enter** runs. **Tab** completes commands, flags, account names, aliases, paths and
plugin words, ignoring case, and lands the account's own spelling on the line. A second Tab
lists the options and steps through them; Escape puts back what you typed. **↑/↓** recall
history. **Ctrl+C** stops a running command.

The readline keys work too: `Ctrl+A`/`Ctrl+E` line ends, `Ctrl+B`/`Ctrl+F` characters,
`Alt+B`/`Alt+F` words, `Ctrl+K`/`Ctrl+U`/`Ctrl+W` kill, `Ctrl+Y` yank, `Ctrl+T` transpose,
`Ctrl+R` incremental history search, `Ctrl+L` clear, `Ctrl+=`/`Ctrl+-`/`Ctrl+0` font size.

## Loading a journal

Four ways in, all ending the same way: files mounted for the engine, one chosen as the
journal and shown in the prompt.

- `upload` picks files.
- `open` picks a folder, keeping its structure and staying editable.
- Drag and drop files anywhere on the page.
- `demo` loads the built-in journal.

Which file is read is worked out from what the others `include`, so a split journal works
without being told. What is loaded is remembered in IndexedDB and resumed next visit.

Reports never change the journal. `upload` and `demo` are read-only. `open` is the
exception: it keeps the browser's handle, so `edit` and `reconcile` can write back. A browser
drops write access on reload and returns it only on a gesture, which is what `reopen` is for.
A save refuses rather than clobbers if the file changed on disk, and `-o` may not write over
a loaded file. `add` and `import` are refused: they write to the journal they read.

A report can be written with `-o FILE`, which lands in the mount and lasts for the visit.
`download <path>` saves it through the browser.

## Plugins

Commands the app does not implement itself are plugins: JavaScript modules listed in a
repository manifest. One repository is bundled and installed at every start, so `chart`,
`edit` and `reconcile` are simply there.

```
hledger.journal » plugins
2 plugins, installed
  chart           open a chart of hledger's numbers in a window
  edit            edit a loaded journal in a window
Repositories
  /plugins/plugins.json  bundled
```

The manifest is authoritative for the word, the help text and completion, so an installed
repository costs one fetch and runs no code until a command is used. A repository may be
any URL the page can fetch, and a plugin runs with the page's own reach: you name it, so
you trust it. See [docs/plugins.md](docs/plugins.md) for the manifest, the host API and a
worked example.

### chart

```
chart [chart options] <type> [hledger arguments]
```

Options shape the picture and come first; then the type; then the query, which goes to
hledger as written, so anything `balance` takes works there: `-p 2026`, `-M`, `--depth 2`,
account names and patterns.

| type | draws | from |
| --- | --- | --- |
| `line` | one line per account, over time | `balance … -M` |
| `bar` | accounts ranked, or columns per period | `balance …` |
| `stacked`, `stream` | accounts stacked, or flowing around a centre | `balance … -M` |
| `heatmap`, `bump` | accounts by period, or each account's rank per period | `balance … -M` |
| `cashflow` | income up, spending down, and the net | `balance … -M --depth 2` |
| `budget` | spent against budgeted, per account | `balance --budget …` |
| `pie` | each account's share of the whole | `balance …` |
| `treemap`, `pack`, `sunburst` | the account tree as cards, circles or rings | `balance --tree …` |
| `sankey` | income flowing into spending, and what was saved | `balance … --depth 2` |
| `swarm`, `histogram` | purchases as dots in time, or by size | `register …` |
| `calendar`, `waterfall`, `multiples` | a square per day, a step per category, a line per account | `register …` / `balance … -M` |

| option | does | for |
| --- | --- | --- |
| `--animate` | play the chart period by period | bar, pie, treemap, sunburst, pack, sankey |
| `--log` | a logarithmic value axis | line, bar, heatmap, multiples |
| `--percent` | each period as shares of its total | line, bar, stacked, multiples |
| `--cumulative` | a running total across the periods | line, bar, stacked, multiples |
| `--top N` | the N largest accounts, the rest as "other" | those, pie, sankey |
| `--sort name\|value` | order by name, or by size | line, bar, stacked, pie, multiples |
| `--invert` | flip the sign, so income reads as positive | line, bar, stacked, pie, multiples |

```
chart cashflow -p 2026                        what came in, what went out, what was kept
chart bar --pivot payee expenses -p 2026      who the money went to
chart budget -p 2026-04..2026-10              spending against the budget
chart swarm -p 2026                           every purchase, the big ones standing out
chart --animate treemap -p 2026 expenses      where the money went, month by month
chart heatmap --depth 2 expenses              every category in every month at a glance
chart --top 5 pie -p 2026 expenses            2026's five largest expenses
chart line -H assets liabilities              balances at each month's end
```

A chart over time is monthly unless the query names an interval. Sankey and cash flow go
two levels deep unless the query sets `--depth`; `budget`, `swarm` and `histogram` chart
`expenses` when no account is named. `--pivot payee` (or a tag) breaks any balance chart
down by payee, and clicking a payee opens its spending month by month.

The window has no buttons or fields. What is drawn comes from the command; under it, an
"Also" line links the same query as the other types, written as the line it is. Everything
else is done to the chart: hover a mark for its numbers, click a legend entry to take a
series out and put it back, scroll to zoom, drag to pan, double-click to reset, and click
a mark to chart that account over time. Tab then Enter does the same from the keyboard, `s`
and `p` save the chart as SVG or PNG, and Escape or the browser's Back goes back.

A line that cannot be charted is answered in the terminal with no window opened, and says
what to type. `chart?` explains each type and option; Tab after `chart` lists them.

### edit

`edit` opens a loaded journal in a window, with syntax highlighting, and saves it back to
the folder an `open` granted. Files from anywhere else are read-only, and the editor says
so rather than losing the work.

### reconcile

```
reconcile assets:bank:checking --statement 2026-09-30
```

`reconcile` opens a window on the account's postings since its last balance assertion,
the point the balance was last proven. Lines already cleared are hidden ("40 cleared
postings hidden", with a control to show them), so it opens on what is left. An account
holding more than one currency shows one of them and says which: lines in another currency
are marked **not counted** and leave the running balance alone, because a journal file has
no rate to convert them with. The note names the command that counts another one,
`reconcile assets:bank --commodity USD`.

A sticky bar keeps the next step and the numbers in reach while a long list scrolls: the
statement's date, the closing balance you type, and the **difference** between that and the
cleared balance. Opening and the cleared balance, run to the statement date, sit under them
in small text. The date defaults to **today**, the date of the statement you are holding.
When everything up to that date is already cleared, the next step says so and asks only for
the closing balance. Problems and hints sit in one list under the bar, one line each.

Tick the lines the statement shows (click or Space; `a` ticks all up to the statement date,
`/` searches) until the difference is zero. When it is not, the window points at the likely
cause: a line exactly the difference, one of half the difference with the wrong sign, or a
difference divisible by nine, which two swapped digits leave.

On a journal from an `open` folder, every change is written to the file as you make it:
a tick, an edit, a new transaction, a date, the order of a day, a posting moved to this
account. The file is read from disk first, so an edit made in vim beside the window is never
written over; the change is found by its text, and refused, by name, if that transaction was
changed outside the window. hledger then reads the file back, which checks it and is what the
window shows; if hledger refuses, the file is put back and the window says which file and
why. While it works the window says *Writing to the file…* and then *Checking with hledger…*;
ticks made meanwhile are written together next. **Undo** (or `u`) takes the last change back
out, unless the file has moved on since. The window also notices when another program changes
the file and reads it again, keeping your place, your search and the statement's figures.

**Finish: assert balance** shows the assertion first, then appends it and checks it the same
way, putting the file back if hledger refuses. Finish waits until every line up to the
statement date is ticked, because an assertion counts all of them, and lists any
transactions whose marks disagree. Anything not from an `open` folder is read-only, said once
at the top: ticks and edits stay in the window, and Finish becomes "Show the assertion" to
copy by hand.

A line the statement has and the journal does not may be booked to the wrong account.
**Find a transaction** (`f`) looks under other accounts by amount (either sign), near a date,
or by words from the payee, starting from the difference. Each match shows the whole file
beside it, lit where it is, and **Move it to this account** on each posting changes that
posting's account in place: nothing is copied. The editor (`e`, `i`, `n`) shows the file
beside it too, with the transaction lit or a mark where a new one will go. A new one goes
where it was put: after the line it was inserted at on that day, first of its day when dated
a later day, and from **Add a transaction** at the end of its day. A day's order is file
order, so Shift+Up and Shift+Down (or the small arrows by the date) move a transaction within
its day in the file. A bare number in a new transaction is this account's commodity, and is
written with it.

```
2026-09-05 * Coffee
    Expenses:Food                                21000 IDR
    Assets:Bank:Checking

2026-09-30 * Reconciled with statement
    Assets:Bank:Checking    0.00 IDR = 1329539.01 IDR
```

Two quiet options sit above the bar, and both are remembered:

- **Mark as cleared**: on *this account's line* (`*` on the posting, leaving the other side
  of a transfer alone) or on *the whole transaction* (`*` on its first line, as above). It
  starts on whichever the journal already uses. hledger reads a posting as its own mark,
  else its transaction's, and a tick changes exactly the postings it means: unticking a
  posting cleared by its transaction moves that mark onto the other postings rather than
  writing pending. In whole-transaction mode, the lines of one transaction tick together and
  unticking takes the mark off the line.
- **Check line by line**: adds a column for the statement's balance after each line, so the
  first line where they part is found. Lines that match are asserted when you finish. Off,
  nothing typed there is written.

There is no column for whether a line is cleared: a ticked line is tinted, and its state
is in the line's name for a screen reader rather than in a word on it. Pending and not
counted do carry small words, because a colour cannot say those. `e` edits a transaction
as journal text (empty deletes
it), `n` adds a new one at the end, and `i` adds one after the line with the cursor. To
change a date, click it and edit it in place (`d` on the focused line), or step to a
neighbouring day with Alt+Up or Alt+Down. A date is never set before the asserted balance,
and a click on a row only ever ticks it: nothing on a row can be dragged.

## Themes

`theme` lists what is on offer and `theme <name>` selects one. The bundled repository carries
`gruvbox`, `gruvbox-light` and `midnight`, and a plugin repository may contribute its own. A
theme is a few colours by role (`background`, `foreground`, `cursor`, `accent`, `dim`); a
role it does not set keeps the built-in colour.

## Offline and installable

A service worker caches the shell and the 13 MB engine, so a second visit needs no network,
including running hledger. A web app manifest and a black and white ledger icon make it
installable on a phone home screen, which is where "anywhere" is most useful.

## Building and running

[Trunk](https://trunkrs.dev) builds it, for wasm32-unknown-unknown with Rust 2024 edition
(MSRV 1.88).

```sh
sh scripts/build-hledger-wasm.sh   # once: builds hledger.wasm (~13 MB), needs ghc-wasm
. scripts/env.sh                   # puts .tools/bin on PATH, redirects caches
trunk serve                        # http://127.0.0.1:8080
trunk build --release              # writes dist/, which is all you deploy
```

The engine is fetched, not committed: `wasm.lock` pins it by URL, size and SHA-256, and a
`pre_build` hook downloads and verifies it, preferring `artifacts/hledger.wasm` when you
have built one locally. A mismatched file is rejected rather than run.

## Testing

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown --all-targets -- -D warnings

# The bundled plugins without a DOM: commands, parsers, models, pages.
node scripts/check-example-plugin.mjs

# Their windows in headless Chrome, and how much of each file the two checks execute,
# failing under 90%. Chrome is found on PATH or named with CHROME=/path/to/chrome.
node scripts/check-plugin-windows.mjs

# The shipped engine, natively, without a browser.
node scripts/hledger-wasm.mjs path/to/hledger.journal balance --tree

# The form that mirrors the app: journal mounted at /data, $LEDGER_FILE exported.
HLEDGER_NO_FILE_ARG=1 node scripts/hledger-wasm.mjs path/to/hledger.journal balance
```

The crate is split along a wasm boundary, enforced by `cfg`: the pure modules compile for
the host and are covered by `cargo test`, and no `web_sys` import can leak into them. So the
line editor, the quoting rules, the search matcher, the plugins' parsers and the read-only
rules are all testable without a browser.

CI runs the tests, both lints, both plugin checks, an engine smoke test, and the build.

## Deploying

Pushing to `main` runs [deploy-pages.yml](.github/workflows/deploy-pages.yml): tests, both
lints, an engine smoke test, `trunk build --release`, a check that the service worker,
manifest and icons are in `dist/`, and a publish to GitHub Pages. Pushing a `wasm-*` tag
runs [publish-engine.yml](.github/workflows/publish-engine.yml), which attaches the engine
to that tag's release. To publish a new engine, build it, update `size` and `sha256` in
`wasm.lock`, push the tag, and point `url` at the asset it publishes; the header of
`wasm.lock` has the exact commands.

## Known limitations

- **No interactive commands.** The engine is one synchronous `_start()` call, so nothing
  can be prompted part-way through. That is the other reason `hledger add` cannot work.
- **A cancelled command restarts the engine**, which recompiles the module (from the HTTP
  cache, so it costs a compile rather than a download).
- **Output over 2 MB is truncated**, with a note saying to use `-o out.csv` and then
  `download out.csv`, which writes the whole thing.
- **Uploads replace rather than accumulate**, capped at 5 MB per file and 50 MB total.
- **The scrollback belongs to the session**: a reload restores the files and history, not
  what was on screen.
- **The width reaches hledger only because the engine was built that way**: anything
  running it elsewhere gets hledger's 80-column default.

## How it fits together

```
index.html                   the shell: a div, xterm.js, and the WASI bridge
sw.js, manifest.webmanifest  offline support and installability
assets/js/hledger-worker.js  the WASI runtime, off the main thread
assets/js/hledger-wasi.js    the main-thread bridge, window.hledgerWasi
assets/js/plugins.js         the plugin loader and the host API
assets/plugins/              the bundled repository: chart, edit, reconcile
assets/wasm/hledger.wasm     the engine, fetched at build time and verified
assets/icons/                the ledger mark, drawn by scripts/make-icons.py
src/terminal/                the line editor, commands, messages, quoting (pure)
src/terminal/view.rs         xterm.js, wrapped (wasm)
src/plugins/mod.rs           the plugin contract (pure)
src/hledger/                 the engine's request and response types, and its bridge
src/journal.rs               choosing which file is the journal (pure)
src/app.rs                   wiring: input, dispatch, and what the terminal shows (wasm)
hledger-wasm/                the cabal project and stubs used to build hledger for wasm
scripts/                     build and fetch the engine, run it natively, draw the icons
```

## Licensing

This project is **AGPL-3.0-or-later**. hledger itself is GPL-3.0-or-later and is loaded as
a separate WASI module, never linked in; the vendored JavaScript, the build stubs and the
reason they exist are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
