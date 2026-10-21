# Vendored plugin libraries

These are the files the bundled plugins load into the windows they open. They are
committed rather than fetched, so building the app stays offline, which is how xterm.js is vendored too.

| file | what it is | version | licence |
| --- | --- | --- | --- |
| `d3/d3.min.js` | [D3](https://d3js.org), which draws every chart, with its zoom and pan | 7.9.0 | ISC |
| `ace/ace.js` | [Ace](https://ace.c9.io), the editor in the `edit` window | 1.45.0 | BSD-3-Clause |

They are loaded only in a plugin window's own document, never in the app's page, so none
of this weight is part of loading hledger-anywhere itself. The UMD / classic-script builds
are used because a window is a `blob:` document that loads classic scripts by absolute URL.

A chart window loads `d3/d3.min.js` and nothing else: D3 has zoom, pan and the layouts the
charts need built in. Chart.js, Hammer.js and chartjs-plugin-zoom were here until every chart
had been ported to D3, and were removed with the last of them. Ace is loaded alone; the `edit`
window sets
`useWorker: false`, because a `blob:` origin cannot resolve Ace's worker scripts, and
without workers editing, search and multi-cursor still work.

