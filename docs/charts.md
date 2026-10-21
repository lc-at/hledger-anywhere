# Charts

**Status: done.** Every chart the `chart` plugin opens is drawn with D3 7.9.0, the one library a
chart window loads. Chart.js, Hammer.js and chartjs-plugin-zoom have been removed. This page
began as the plan for that change; it now records what was built, what was decided, and why.

## The charts

Every chart is a preset on the one `chart` word, so `chart?` lists them all. The plugin asks
hledger for the report, the window draws it.

| command | asks hledger for | draws |
|---|---|---|
| `chart`, `chart spending` | `balance expenses -M` | a line per account, month by month |
| `chart income`, `cashflow`, `balances`, `payees` | a monthly `balance` | lines |
| `chart networth` | `balance assets liabilities -H -M` | one filled line, the running total |
| `chart top` | `balance expenses` | a ranking of bars, largest first |
| `chart shares` | `balance expenses` | a doughnut of the positive balances |
| `chart stacked [account]` | `balance <account> -M --depth n+1` | categories stacked over time |
| `chart treemap [account]` | `balance --tree <account>` | the account tree, area by balance |
| `chart sankey` | `balance income expenses --depth 2` | income flowing into spending and savings |
| `chart calendar` | `register` | a square per day, darker for more spending |
| `chart waterfall` | `register` | income, a step down per category, and net |
| `chart multiples` | `balance -M` | a sparkline per account |
| `chart <account>` | `balance <account> -M` | lines, for any account |
| `chart <report …>` | the report, verbatim | whatever shape it comes back in |

A period passes through to hledger: `chart sankey -p 2024`, `chart calendar -p 2024`.

## How it is built

```
chart.js          build(args) -> {command, title, kind}; parseReport(kind, csv)    pure
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
that stands for something, and a saved picture carries its legend. One theming path and one tooltip path won, and three
vendored files became one.

**The Sankey is income into spending, from `balance`, not `register`.** hledger has no flow
report, so flows are derived. Asking for `balance income expenses --depth 2` gives income
sources and expense categories and nothing else, so a transfer between two asset accounts can
never be drawn as income: it is not in the report. The two sides are balanced the way a
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

`node scripts/check-example-plugin.mjs` checks every pure part: the presets and the commands
they build, the parsers on the engine's own CSV, the aggregations and their sums, the model
behind each balance chart, the Sankey's flows and layout, axis labels, the keys, the saved
picture's header, the page markup, the bridge a drill-down calls, and that `chart?` lists
every question `chart.js` answers to.

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
