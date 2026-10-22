# Charts

**Status: done.** Every chart the `chart` plugin opens is drawn with D3 7.9.0, the one library a
chart window loads. Chart.js, Hammer.js and chartjs-plugin-zoom have been removed. This page
began as the plan for that change; it now records what was built, what was decided, and why.

## The command

```
chart [chart options] <type> [hledger arguments]
chart --log bar -p 2026 coffee
```

Chart options shape the picture and come before the type; everything after the type is the
query, handed to hledger as it was typed. Each type adds only what its picture cannot do
without, and the command under the chart shows it.

| type | asks hledger for | draws |
|---|---|---|
| `line` | `balance <query> -M` | a line per account over time |
| `bar` | `balance <query>` | a ranking; columns per period when the query has an interval |
| `stacked` | `balance <query> -M` | accounts stacked over time |
| `pie` | `balance <query>` | a doughnut of the positive balances |
| `treemap` | `balance --tree <query>` | the account tree, area by balance |
| `sankey` | `balance <query> --depth 2` | income flowing into spending and savings |
| `calendar` | `register <query>` | a square per day, darker for more spending |
| `waterfall` | `register <query>` | income, a step down per category, and net |
| `multiples` | `balance <query> -M` | a sparkline per account |

`-M` is added only when the query names no interval, and `--depth 2` only when it sets no
depth. The options, and the types each applies to:

| option | does | types |
|---|---|---|
| `--log` | symmetric log value axis, so zero and negatives still draw | line, bar, multiples |
| `--percent` | each period as shares of its total | line, bar, stacked, multiples |
| `--cumulative` | running totals across periods | line, bar, stacked, multiples |
| `--top N` | the N largest, the rest as "other (n)" | line, bar, stacked, pie, multiples, sankey |
| `--sort name\|value` | by name, or by size (the default) | line, bar, stacked, pie, multiples |
| `--invert` | flip the sign | line, bar, stacked, pie, multiples |

An option given to a type it does not apply to is refused and the ones that do are named,
rather than ignored. `--invert`, `--cumulative` and `--percent` are applied in that order by
`shape()`, so a percentage of running totals is each account's share of everything so far.

Clicking a mark charts that account as a line, keeping the query's flags (its period, interval,
depth) and the options that still mean something for one account (`--log`, `--cumulative`,
`--invert`). The "Also" line under each chart is the same query drawn as the other types of its
family, each written as the line it is.

## How it is built

```
chart-args.js     the grammar: parse, command, title, drill, related              pure
chart.js          run(); build(args); parseReport(kind, csv)                      pure but run
chart-data.js     CSV, amounts, formatting, series arithmetic, the palette        pure
chart-window.js   modelFor(report) -> model; viewOf(state); page(); mount()      pure but mount
chart-d3.js       parsers and aggregations for the shaped charts, the Sankey
                  layout, the words and tables (pure), and render(kind, svg, ...)
chart-ui.js       tooltip, legend, keys, saving                                  DOM, keyFor pure
window-kit.js     escaping, theme colours, the waiting page, bridges; shared with edit   pure
vendor/d3/        d3.min.js, the UMD build, and its licence
```

**The plugin boundary held.** `chart` decides what to ask hledger; the window decides what to
draw. Nothing here is in the core.

**Two families, one renderer.** The balance charts (line, stacked, bar, doughnut) are built by
`modelFor` from hledger's balance CSV: a plain object naming the series or rows, their
colours, their shares, and whether a click can open them. The shaped charts (treemap,
calendar, waterfall, multiples, Sankey) read the report their picture needs and aggregate it
in `parseReport`, so the window, the headline and the table all receive the same finished
data. Either way, `render(kind, svg, data, colors, hooks, state)` draws it.

**Every mark answers through the same hooks.** A chart draws marks and reports what was
pointed at, focused or clicked; `chart-ui.js` turns that into the tooltip, and the window into
a drill-down. That is why all eleven behave alike.

## What hledger writes

Verified against the pinned engine (`scripts/hledger-wasm.mjs`), and copied into the plugin
check byte for byte:

```
balance -M -O csv
  "account","2024-01","2024-02"        one column per period, one row per account

balance --tree -O csv
  "account","balance"
  "expenses","$1333.89"
  "␣␣food","$98.90"                    ␣ is U+00A0, the no-break space
  "␣␣␣␣coffee","$12.50"                two a level; the hierarchy is the indentation

balance income expenses --depth 2 -O csv
  "expenses:food","$98.90"
  "income:salary","$-3200.00"          income is negative

register -O csv
  "txnidx","date","code","description","account","amount","total"
```

The tree's indentation is the one that bit. A terminal shows a no-break space as a space, so
the first fixture used spaces, the parser counted spaces, the check passed, and the real tree
drew `expenses` as a leaf beside its own children. The parser now reads no-break spaces,
spaces and tabs, and the fixture is the engine's bytes.

## Decisions

**Replace Chart.js, not keep it beside D3.** The plan said to decide by porting the line
chart and comparing. The port kept everything Chart.js did (hover values, legend toggling,
wheel zoom and drag pan along time, double-click reset, click to drill down, Escape back) and
then did more: the crosshair lists every series at a period, the keyboard reaches every mark
that stands for something, and a saved picture carries its legend. One theming path and one
tooltip path won, and three vendored files became one.

**A type and a query, not named questions.** The plugin used to answer to fourteen named
questions (`chart spending`, `chart networth`...) and read periods out of plain words. Both
were replaced by `chart [options] <type> [hledger arguments]`: the query is hledger's own
language, so nothing has to be learned twice and nothing is guessed, and what a question
added is now an option (`--cumulative`, `--invert`, `--top`) that works on every type it
makes sense for. Errors are said before a window opens, and say what to type.

**The Sankey is income into spending, from `balance`, not `register`.** hledger has no flow
report, so flows are derived from income and expense rows; any other row in the report, such
as a transfer between two asset accounts, is never drawn as income or spending. The two sides are balanced the way a
budget is: income above spending flows to *saved*, and spending above income is drawn from a
*from savings* source, so every pixel of every link is money that moved.

**No `d3-sankey`.** The flow has a fixed shape (sources, one hub, sinks), so its layout is a
short pure function, `sankeyLayout`, tested in node for what matters: links into the
hub are exactly as thick as the hub, every node is drawn at one scale, and everything fits.
A general Sankey package would have been another vendored file for a layout this simple.

**The waterfall walks down.** Income is the first bar; each expense category steps down from
where the last one ended; net stands on zero. The first D3 version drew the categories rising
from zero, which read as a stacked total rather than a waterfall.

**Dates are the journal's.** The calendar groups by the date as written in the journal, with
no time zone, and says so under the grid.

**Size.** d3.min.js is 280 KB, against the 242 KB of Chart.js, Hammer and the zoom plugin it
replaces. It is loaded only in a chart window, never in the app's page.

## Using a chart

The window has no buttons and no fields; everything is done to the chart.

| pointer | keyboard | does |
|---|---|---|
| hover a mark | Tab to it | its numbers in a tooltip |
| click a mark | Enter | chart that account on its own |
| hover the plot of a line or area | ← → | a crosshair listing every series at that period |
| click a legend entry | Tab, Enter | hide or show that series, and rescale |
| scroll, drag | + − | zoom and pan through time |
| double-click | 0 | reset the zoom |
| | Esc | back to the chart you came from |
| | s, p | save as SVG, or as a PNG at twice the size |

Tab stops are the marks that stand for something: bars, slices, treemap cells, Sankey nodes,
sparklines, and calendar days with spending. Empty days and Sankey links are left out, so Tab
does not walk through hundreds of squares or repeat a node's numbers. A saved chart carries
its title, subtitle and legend, and leaves out the crosshair and other interaction-only
layers. The numbers are always in a table under the chart, which is also
what a screen reader reads.

## Testing

Two checks, both run by CI.

`node scripts/check-example-plugin.mjs` checks every pure part: the grammar and every refusal
it can give, the commands it builds, the options' arithmetic, the parsers on the engine's own
CSV, the aggregations and their sums, the model behind each balance chart, the Sankey's flows
and layout, axis labels, the keys, the saved picture's header, the page markup, the bridge a
window calls, and that `chart?` lists every type and option the grammar reads.

`node scripts/check-plugin-windows.mjs` draws every chart in both themes in headless Chrome
and uses it the way a person would, with real input events: hover, the legend, Tab and
Enter, the arrow keys, wheel, drag, keyboard and double-click zoom, click drill-down and
Escape, SVG and PNG export (the files are read back), and the failures: no library, a window
whose app has gone, a refused drill-down. It measures how much of each plugin file the two
checks execute together and fails below 90%; every file is between 95 and 99%.

Writing it found two bugs a person would have hit: the highest and latest points of a line
were half outside the area that listens for clicks, so the point most worth clicking did
nothing; and a double-click to reset the zoom also drilled into an account, because its first
click was a click. A click on a zoomable chart now waits a moment to see whether a second one
follows.

## Not done

- **Transitions.** Zoom animates; a redraw after hiding a series or drilling down does not. It
  is a redraw from data, which is simpler to trust than an animated one.
- **Touch gestures** beyond what `d3-zoom` provides for pinch and drag, which is untested on a
  real phone.
