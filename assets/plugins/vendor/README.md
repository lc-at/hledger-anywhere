# Vendored charting library

These are the files the bundled chart plugin loads into the window it opens. They are
committed rather than fetched, so building the app stays offline, which is how xterm.js
and remoteStorage.js are vendored too.

| file | what it is | version | licence |
| --- | --- | --- | --- |
| `chart.umd.js` | [Chart.js](https://www.chartjs.org), the charting library | 4.4.7 | MIT |
| `hammer.min.js` | [Hammer.js](https://hammerjs.github.io), which the zoom plugin needs for touch | 2.0.8 | MIT |
| `chartjs-plugin-zoom.umd.js` | [chartjs-plugin-zoom](https://www.chartjs.org/chartjs-plugin-zoom/), wheel zoom and drag pan | 2.2.0 | MIT |

They are loaded only in a chart window's own document, never in the app's page, so none of
this weight is part of loading hledger-anywhere itself. The UMD builds are used because the
window is a `blob:` document that loads classic scripts by absolute URL.

Chart.js registers the zoom plugin itself on load, so the order is: `chart.umd.js`,
`hammer.min.js`, `chartjs-plugin-zoom.umd.js`.
