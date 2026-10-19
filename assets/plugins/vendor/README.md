# Vendored plugin libraries

These are the files the bundled plugins load into the windows they open. They are
committed rather than fetched, so building the app stays offline, which is how xterm.js is vendored too.

| file | what it is | version | licence |
| --- | --- | --- | --- |
| `chart.umd.js` | [Chart.js](https://www.chartjs.org), the charting library | 4.4.7 | MIT |
| `hammer.min.js` | [Hammer.js](https://hammerjs.github.io), which the zoom plugin needs for touch | 2.0.8 | MIT |
| `chartjs-plugin-zoom.umd.js` | [chartjs-plugin-zoom](https://www.chartjs.org/chartjs-plugin-zoom/), wheel zoom and drag pan | 2.2.0 | MIT |
| `ace/ace.js` | [Ace](https://ace.c9.io), the editor in the `edit` window | 1.45.0 | BSD-3-Clause |

They are loaded only in a plugin window's own document, never in the app's page, so none
of this weight is part of loading hledger-anywhere itself. The UMD / classic-script builds
are used because a window is a `blob:` document that loads classic scripts by absolute URL.

Chart.js registers the zoom plugin itself on load, so the order is: `chart.umd.js`,
`hammer.min.js`, `chartjs-plugin-zoom.umd.js`. Ace is loaded alone; the `edit` window sets
`useWorker: false`, because a `blob:` origin cannot resolve Ace's worker scripts, and
without workers editing, search and multi-cursor still work.

