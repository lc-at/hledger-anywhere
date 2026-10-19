# Charts with D3

**Status: proposed — not implemented.** This is the plan for replacing the charting
library and adding report types the current one cannot draw. Nothing here is
implemented yet; the bundled `chart` plugin still uses Chart.js.

## Why

The chart plugin draws a line chart, a bar ranking and a doughnut, all through Chart.js. That
was the right first step: it shipped a real chart quickly and the plugin API proved itself.
What it cannot do is the shapes an accounting tool actually wants — a treemap of where the
money went, a calendar of daily spending, a waterfall from income to net, a flow from income
to expense, a row of sparklines. Chart.js draws a fixed set of marks; D3 draws whatever the
data means.

D3 also removes two dependencies rather than adding pressure to keep them: `hammer.min.js`
and `chartjs-plugin-zoom.umd.js` exist only because Chart.js needs them for pan and zoom,
while D3 has `d3-zoom` built in. Three vendored files become one.

## The library

| | |
|---|---|
| package | `d3` **7.9.0** (ISC) |
| file | `dist/d3.min.js`, the UMD build — about 280 KB |
| vendored to | `assets/plugins/vendor/d3/d3.min.js` |
| loaded | as a classic `<script>` in the chart window, exactly as Chart.js is now |

The UMD build is the one to take: a chart window is a `blob:` document that loads classic
scripts by absolute URL, which is why the current chart library is vendored the same way
(`assets/plugins/vendor/README.md`). The licence row and `THIRD_PARTY_LICENSES.md` entry
follow the existing pattern.

## What hledger gives us

Verified against the pinned engine (`scripts/hledger-wasm.mjs`), so the parsers can be
written and tested against these shapes:

```
balance -O csv
  "account","balance"
  "assets:bank:checking","$2501.10"

balance --tree -O csv
  "account","balance"
  "expenses","$698.90"
  "  food","$98.90"
  "    coffee","$12.50"        <- hierarchy is the indentation

register -O csv
  "txnidx","date","code","description","account","amount","total"
  "2","2024-01-05","rent:january","Landlord","expenses:housing:rent","$600.00","$600.00"

balance -M -O csv
  "account","2024-01","2024-02"    <- one column per period
```

`chart.js` already parses the multi-period balance CSV (`read`, `split`, `money`) and
finds the header row rather than assuming it, because `balancesheet` and `cashflow` put a
title above it. Those functions are pure and tested, and the plan reuses them.

## The charts

Each is a new preset on the existing `chart` word, so the command surface stays one word
and `chart?` lists the presets. The report is still built by the plugin and run through
`host.hledger`; only the renderer changes.

| command | report | what it shows | D3 modules |
|---|---|---|---|
| `chart treemap [account]` | `balance --tree -O csv` | composition of spending, area proportional to amount, nested by account segment | `d3-hierarchy` |
| `chart calendar` | `register -O csv` | a year of daily spending as a calendar heatmap | `d3-time`, `d3-scale` |
| `chart waterfall [period]` | `register -O csv` | income down to expenses to net, as a waterfall | `d3-scale`, `d3-shape` |
| `chart sankey` | `register -O csv`, aggregated | money flowing from income accounts to expense accounts | `d3-sankey` |
| `chart multiples` | `balance -M -O csv` | one sparkline per account, small multiples | `d3-shape`, `d3-scale` |
| `chart stacked [account]` | `balance -M -O csv` | expenses by category over time, stacked area | `d3-shape`, `d3-scale` |

The existing `chart` presets (`spending`, `income`, `cashflow`, `networth`, `balances`,
`payees`, `top`, `shares`) keep their names.

## Architecture

**Keep the plugin boundary.** `chart` stays a plugin: it decides what to ask hledger, the
window decides what to draw. Nothing here belongs in the core.

**One window, two renderers.** The plugin already imports `page()` from
`chart-window.js`; the window module gets a renderer registry:

```
chart.js          build(args) -> {command, title, kind, options}   (pure, tested)
chart-window.js   page(...) -> html; mount(...) -> chooses the renderer
chart-d3.js       render(selection, data, colors) labelled svg renderer
```

The window's `scripts` list gains the d3 file, and `mount()` dispatches on `kind`. The
existing line/bar/doughnut can be ported to D3 in a later phase, or kept on Chart.js while
the new kinds use D3 — see the phases.

**Theming is already solved and must be kept.** The window receives `host.colors()`
(background, foreground, cursor, accent, dim). The series palette is the golden-angle
spread the current chart uses; labels are foreground and dim; gridlines are `dim` at low
alpha. Every new chart uses those, and the palette stays AA-readable against the
background, which the plugin check can assert for any theme.

**Accessibility is not optional here.** The app has a `screenreader` command and takes the
accessibility tree seriously. SVG is not readable, so every chart window carries a
visually-hidden `<table>` of the same data (visible on request), and interactive marks are
keyboard focusable with `aria-label`s.

**Failure is a message, not a blank window.** The window opens before the report is
fetched, writes a shell, and if d3 fails to load or the report returns nothing, says so.
That is the pattern the chart window already follows.

## Data work

Two new pure parsers, exported and tested:

- `readRegister(text)` — the register CSV (`txnidx,date,code,description,account,amount,total`),
  returning transactions the calendar and waterfall can aggregate.
- `readTree(text)` — the indented `--tree` CSV, turning the leading spaces into a
  parent/child hierarchy for the treemap.

Aggregations (`byDay`, `byAccount`, `flows`, `monthly`) are pure functions over those
shapes. The accounting judgement lives there: a transfer between two asset accounts is not
income, so the Sankey must not count it as one.

## Testing

`scripts/check-example-plugin.mjs` already imports the plugin's pure functions and checks
them in node. It grows the same way: sample CSV captured from the engine (the shapes above)
through the parsers, aggregation sums, treemap areas summing to the total, the palette's
contrast per theme, and the generated HTML carrying a script tag for d3 and an accessible
table. The rendered pixels still want a browser, which is what the last piece of work did
for the current charts.

## Phases

**Phase 0 — spike (half a day).** Vendor d3 and draw one line chart from the existing `read()`
output in a window. It answers the only question that could sink the plan: does d3 load and
render from a `blob:` document as a classic script, and does it take the theme colours.

**Phase 1 — scaffolding and parity (one to two days).** A small `chart-d3.js` with the shared
pieces (svg sizing, axes, legend, tooltip, accessible table), and the three existing kinds
ported to it. If parity holds, remove Chart.js, `hammer.min.js` and
`chartjs-plugin-zoom.umd.js`; if D3's zoom/hover is worse for the line chart, keep both for a
while and decide again later. **Acceptance:** the existing chart presets look and behave the
same, the plugin checks pass, three vendored files become one.

**Phase 2 — the new charts (two to three days).** Treemap, calendar, waterfall, Sankey,
multiples, stacked area, with their parsers and tests. **Acceptance:** each renders from the
demo journal and from a real journal, is themed, has an accessible table, and the plugin
check covers its pure parts.

**Phase 3 — polish.** SVG/PNG export from the window, keyboard navigation, transitions,
`docs/plugins.md` examples, and the README's chart section listing the new presets.

## Open questions

1. **Sankey meaning.** hledger has no flow report; flows have to be derived. The honest
   derivation is: income accounts to expense accounts over a period, from `register`, with
   transfers between asset accounts excluded. Is that the picture worth drawing, or is the
   waterfall a better answer to the same question?
2. **Replace or keep Chart.js.** Decided in Phase 1 by comparing the ported line chart with
   the current one. The tie-breaker is code: keeping one theming and one tooltip path is
   worth a lot, but not more than a worse chart.
3. **Dates and time zones.** `register` dates are journal dates with no zone. The calendar
   heatmap groups by the date as written; that is the plan, but it should be stated in the
   window rather than guessed.
4. **Bundle size.** d3 UMD is ~280 KB against the current chart stack's ~250 KB, loaded only
   in a chart window either way. Acceptable, but it is why Phase 3 delays and nothing else
   is added.
