# hledger-anywhere

A terminal for [hledger](https://hledger.org), running entirely in your browser.

**Live: <https://hledger.gru.fi>**, nothing to install, and nothing to sign up for.

The real hledger CLI, the pinned **1.52.4** build for `wasm32-wasi`, runs in a Web
Worker, and everything you type goes to it unchanged. There is no server: the whole
application is static files. Nothing you load leaves the browser.


```
  hledger-anywhere  hledger 1.52.4 · wasm sha256 acd7c4e955b1…
  A terminal for hledger, running entirely in this tab.
  Drop journal files on this window, or type:
    upload       add journal files
    open         open a folder on disk, editable
    demo         load the sample journal
    ?            this help; put ? after a command for that one
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
| `open` | Choose a folder on disk, keeping the paths inside it, what a journal split into `2024.journal`, `2025.journal` and `prices/` needs. Through the File System Access API, so the files stay editable with `edit`. Falls back to a plain read-only folder picker where the API is unavailable. |
| `reopen` | Take the folder back after a reload. A browser drops a remembered folder's write access when the page reloads and only gives it back on a gesture, so this asks for it and reads the folder from disk again. |
| `demo` | Load a small built-in journal, so the app can be tried without uploading anything. |
| `journal` | List the loaded files and mark the one being read. |
| `journal <path>` | Read a different loaded file. |
| `download <path>` | Save a file into your browser's downloads. |
| `alias` | List your aliases. |
| `alias name=cmd` | Make `name` run `cmd`. The app says which alias expanded when a command runs. |
| `unalias <name>` | Remove one. |
| `/text` | Search what commands have printed. |
| `n` / `N` | Repeat that search forwards / backwards. |
| `font [size]` | Show or set the font size, 8 to 32 px. |
| `screenreader` | Turn xterm's accessibility tree `on` or `off`. |
| `clear` | Clear the screen. |
| `plugins [add\|remove\|reload]` | List the installed plugins, or install a repository by URL or path. One is bundled. |
| `settings [export\|import]` | Show what is remembered, or move it between instances as a file. `import` opens the file picker. |
| `theme [name]` | List the colour themes, or select one. Plugin themes are listed too. |
| `find <text>` | Search everything printed so far; `n` and `N` step through the matches. `/text` does the same. |
| `?` | The app's own help, the engine's version and its checksum. |
| `<command>?` | One command's own help: `open?`, `theme?`. The app answers for its own commands and the plugins', and hands anything else to hledger with `--help`, so `balance?` is hledger's own page. |

### Keys

**Enter** runs. **Tab** completes hledger's commands and flags, account names, your
aliases, and the paths of loaded files. Matching **ignores case**, and what lands on the
line is the account's own spelling: `EXP` completes to `expenses:`. When there is more
than one option left, a second Tab lists them in columns and puts the first on the line;
every Tab after that steps to the next one, Shift+Tab steps back, and Escape puts back
what you typed. The choice is made by pressing Tab, not by typing the rest of it. When
nothing starts with what you typed, the closest names are listed instead, and the line is
left exactly as you wrote it: a guess is worth showing you, not worth typing over you.

Tab on an **empty line** lists the commands you can run, the app's own first, rather than
completing one of them for you. Tab after a command lists the flags, accounts, aliases and
paths that can follow it. Neither touches what you have typed, because there was nothing there
to complete from. While a command runs, the
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
engine run, and it should be something you asked for. It never makes you wait for it.
That Tab completes from the commands, flags, aliases, paths and plugin words already
at hand, and the names are there for the next Tab. Nothing about the wait is written
into the terminal, so the prompt is not pushed down and the line is not disturbed
while you type; the window title says account names are being read, and if they cannot
be read at all, the app says so the next time you press Tab, when it is not in the
middle of a sentence.

## Loading a journal

Four ways in, and all of them end with the same result: files mounted for the engine,
one of them chosen as the journal to read and shown in the prompt.

- **`upload`**, pick files.
- **`open`**, pick a folder on disk, keeping its structure and staying editable.
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
browser's own download. Everything loaded is also in IndexedDB, so a reload does not
need another upload.

**What a command writes lasts for this visit.** The file is in the engine's filesystem
and in the list `download` reads, and it is deliberately not stored: an exported report
is something you take away, not something that joins your journal.

## Plugins

Commands the app does not implement itself are plugins, loaded at runtime. A plugin is a
JavaScript module listed in a repository manifest. One repository is bundled and installed
at every start, so its commands are simply there:

```
hledger.journal » chart bar -M expenses
chart: bar of 4 accounts over 2 periods, the last $47.49, down $1,238.91, in a new window.
```

The bundled repository is `/plugins/plugins.json`, and its `chart` plugin opens a chart in a
window of its own, using hledger's own numbers:

```
chart [chart options] <type> [hledger arguments]
```

Chart options shape the picture and come first; then the type; then the query, which goes to
hledger as you write it, so anything `balance` takes works there: `-p 2026`, `-M`, `--depth 2`,
`-H`, account names and patterns. The window shows the command it ran.

| type | draws | from |
| --- | --- | --- |
| `line` | one line per account, over time | `balance … -M` |
| `bar` | accounts ranked; with an interval such as `-M`, columns per period | `balance …` |
| `stacked` | accounts stacked over time | `balance … -M` |
| `stream` | a streamgraph: accounts flowing around a centre | `balance … -M` |
| `heatmap` | accounts by period, a square each, darker for more | `balance … -M` |
| `bump` | each account's rank, period by period | `balance … -M` |
| `pie` | each account's share of the whole | `balance …` |
| `treemap` | the account tree, area by balance | `balance --tree …` |
| `sunburst` | the account tree in rings, angle by balance | `balance --tree …` |
| `sankey` | income flowing into spending, and what was saved | `balance … --depth 2` |
| `calendar` | a square per day, darker for more spending | `register …` |
| `waterfall` | income, a step down per expense category, then net | `register …` |
| `multiples` | a small line per account | `balance … -M` |

A chart over time is monthly unless the query names an interval (`-D`, `-W`, `-Q`, `-Y`); a
Sankey is two levels deep unless the query sets `--depth`. Nothing else is added.

| option | does | for |
| --- | --- | --- |
| `--animate` | play the chart period by period | bar (a bar race), pie, treemap, sunburst, sankey |
| `--log` | a logarithmic value axis, for amounts of very different sizes | line, bar, heatmap, multiples |
| `--percent` | each period as shares of its total | line, bar, stacked, multiples |
| `--cumulative` | a running total across the periods | line, bar, stacked, multiples |
| `--top N` | the N largest accounts, and the rest as "other" | those, pie, sankey |
| `--sort name\|value` | order by name, or by size, which is the default | line, bar, stacked, pie, multiples |
| `--invert` | flip the sign, so income and liabilities read as positive | line, bar, stacked, pie, multiples |

```
chart --animate treemap -p 2026 expenses       where the money went, month by month
chart --animate --cumulative sankey -p 2026    income into spending, building up over the year
chart --animate --cumulative bar --depth 2 expenses   a bar race of spending so far
chart heatmap --depth 2 expenses               every category in every month at a glance
chart --log bar -p 2026 coffee                 coffee in 2026, on a log scale
chart bar -M expenses                          spending in monthly columns
chart --percent stacked --depth 2 expenses     what spending is made of, month by month
chart --cumulative --invert line income        income so far
chart --top 5 pie -p 2026 expenses             2026's five largest expenses
chart line -H assets liabilities               balances at each month's end
chart sankey -p 2026                           where 2026's income went
```

**Animated charts.** `--animate` asks hledger for every period once (`-M` unless the query
names an interval) and plays them in the window, easing each account from one period's amount
to the next. It starts by itself, unless the system asks for reduced motion; Space plays and
pauses, ← → step a period, 0 goes back to the first, and a click on the timeline under the chart
goes to that period. Things stay where the eye left them: a Sankey's nodes and a pie's slices
keep one order, a treemap's colours belong to their branch, and every frame is drawn to one
scale, so a month with half the spending is half the area. A bar race lets bars overtake, which
is the point of one. With `--cumulative` each frame is the running total so far. Click a mark at
any moment to chart that account over time; Escape comes back to the animation.

A line that cannot be charted is answered in the terminal, with no window opened, and the
answer says what to type: a missing type lists the types, a misspelt one (`lien`) is offered
the one it was probably meant to be, a chart option after the type is moved before it, and an
option a type cannot use is named along with the ones it can. Tab after `chart` lists the types
and options, and `chart?` explains each.

**The chart is the chart.** The window has no buttons, no fields, and nothing hidden behind a
disclosure. What is drawn comes from the command; under it, an "Also" line links the same query
drawn as the other types, each written as the line it is (`chart pie -p 2026 coffee`), so
following one shows how to ask for it next time. Everything else is done to the chart itself,
which is what a chart is for: hover a mark for its numbers, click a legend entry to take a
series out and put it back, scroll to zoom through time, drag to pan, double-click to reset,
and click a mark to chart that account over time, in the same period. Escape goes back to the
chart you came from.

Everything the pointer does, the keyboard does too, and the keys are written under the chart:

| key | does |
| --- | --- |
| Tab, then Enter | reach a mark and see its numbers, then chart that account over time |
| ← → | step a crosshair through the periods |
| + − 0 | zoom in, out, and reset |
| Esc | go back |
| s, p | save the chart as SVG, or as a PNG at twice the size |

A saved chart carries its title, subtitle and legend, so it still says what it is once it has
left the window. The numbers are always there as a table underneath, which is also what a
screen reader reads, and the command that produced them is at the bottom.

Every chart is drawn with [D3](https://d3js.org), vendored beside the plugin so the window
needs nothing from the network, and coloured from the theme in use, so a chart opened from
gruvbox light is cream rather than a dark window beside a light terminal. Nothing about it is in the
app's core: remove it with `plugins remove /plugins/plugins.json` and it is back on the next
visit, because bundled is where it came from, not what it is.

```
hledger.journal » plugins
2 plugins, installed
  chart           open a chart of hledger's numbers in a window
  edit            edit a loaded journal in a window
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
`host.say(text)` to print, `host.window(title)` to open a window, `host.colors()` for the
theme in use, their own settings, and — through `host.files()`, `host.read(path)` and
`host.save(path, contents)` — read and write the files an `open` made editable. The bundled
`edit` plugin uses those three to edit a journal in a window; anything else that calls
`host.save` is bound by the same rule: only files from an `open`ed folder can be written,
and a file that changed on disk since it was opened is refused rather than clobbered.

A repository may be any URL this page can fetch, including on another host, and a plugin
is code running in this page with the page's own reach: you name it, so you trust it. See
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

The bundled repository carries **gruvbox**, dark and warm, **gruvbox-light**, the same
palette on cream, and **midnight**, dark and blue.
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

## Read-only, except where you `open`

Reports never change the journal, and that is on purpose: a report is easier to trust
when nothing it read has changed underneath it. What `upload` and `demo` load is
read-only.

`open` is the exception. It mounts a folder on disk through the File System Access API
and keeps the browser's handle to it, so `edit` can write a journal back and a save
changes the file on disk. Nothing else writes: the change is yours, made by the editor,
not something a report did behind your back.

The handle is remembered in the browser's cache, so a later visit can read the same
folder without picking it again. Write access is not remembered: a browser drops it when
the page reloads and will only give it back in response to something you did, so the
terminal says the folder is remembered and `reopen` is what asks for it. Until then the
folder reads normally and saves are refused, the same as any other read-only file.

What that means:

- **`add` and `import` are refused**, with a message saying so. They are the two
  hledger commands that write to the journal it reads. `add` could not work here in any
  case: the engine is one run with no way to prompt for an entry.
- **`-o` may not write over a loaded file.** A new name is how a report is saved; the
  name of a loaded journal is refused, because a report over it would be an edit made
  by a report.
- **A save refuses rather than clobbers.** If the file changed on disk since it was
  opened — another editor wrote it — `edit` says so and asks you to `open` again.
- **`>>`, `append` and `put` are gone.** Loading files, running reports, saving a
  report with `-o`, and `download` all still work.

Files an `open` mounted are written back to disk on save; files from anywhere else are
read-only, and a save to one reports that it has nowhere to write.

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
assets/wasm/                hledger.wasm, fetched at build time, verified against wasm.lock
assets/icons/               drawn by scripts/make-icons.py
src/terminal/mod.rs         the line editor, commands, quoting, search (pure)
src/terminal/view.rs        xterm.js, wrapped (wasm)
src/plugins/mod.rs          the plugin contract (pure)
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
them. That is why the line editor, the quoting rules, the search matcher and the
read-only rules are all testable without a browser.

**Plugins are how commands beyond the core's own are added.** The core is a terminal,
a set of loaded files, and a way to run hledger on them. A plugin declares a word, how
it reads in the help, what it adds to completion, and what to do with the text typed
after it; it never touches the app, which is what keeps it testable. It can also say
how to present the output it caused, or return nothing and get the ordinary terminal.

Two plugins ship in the bundled repository, `chart` and `edit`, and both are installed at
runtime the same way a third-party one is: from a manifest, as JavaScript modules, with no
rebuild of the app. A picture or an editor belongs in the plugin that wants one, not in the
core that runs reports.

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

# The bundled plugins: commands, parsers, models, pages, everything without a DOM.
node scripts/check-example-plugin.mjs

# Their windows in headless Chrome: every chart in both themes, hover, legend, keys, zoom,
# drill-down, saving, the editor's save and its refusals. It also measures how much of the
# plugins' code the two checks execute, and fails if any file is under 90%.
# Chrome is found on PATH, or named with CHROME=/path/to/chrome. Needs Node 22.
node scripts/check-plugin-windows.mjs

# The shipped engine, natively, without a browser:
node --experimental-wasi-unstable-preview1 scripts/hledger-wasm.mjs \
    path/to/hledger.journal balance --tree

# The form that mirrors the app: journal mounted at /data, LEDGER_FILE exported,
# so a bare `balance` can be checked without a browser.
HLEDGER_NO_FILE_ARG=1 node --experimental-wasi-unstable-preview1 \
    scripts/hledger-wasm.mjs path/to/hledger.journal balance
```

CI runs the tests, both lints, both plugin checks, that engine smoke test, and then the
build.

Coverage, measured: the natively compiled Rust is 97% of lines executed by `cargo test`
(`cargo llvm-cov`), which is every pure module; the wasm-only glue in `src/app.rs` and its
neighbours is exercised by the app itself, not by a test. The plugins are 95 to 99% executed
per file, and the browser check enforces 90%.

Beyond the tests, the behaviour in this README was verified by driving the running
app in a browser: a first run with the session cleared, completion read off the
screen, an interrupted long command, offline mode with the network actually off, a real
`ClipboardEvent` paste, and the file picker, the editor window and the chart window.

## Known limitations

- **Editing is the editor's job, and only for `open`ed folders.** `add` and `import`
  are still refused, `-o` may not write over a loaded file, and only files mounted by
  `open` can be written back — through `edit`. Files a command writes otherwise last
  only for the visit, for `download`.
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
that is worth replacing. That argument is about the *engine's* mount, not about editing:
the editor writes straight to the user's disk through the File System Access handle, and
no in-browser filesystem is in that path.

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
