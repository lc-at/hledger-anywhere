# uPlot (vendored)

[uPlot](https://github.com/leeoniya/uPlot) is the time-series charting library
behind the "balance over time" line chart. It is vendored as source, like
`../` (the browser WASI shim), so the app needs no npm step and no bundler.

## Pinned version

**uPlot 1.6.32**, fetched from jsDelivr on 2026-10-07:

| File | Source URL | SHA-256 |
|---|---|---|
| `uPlot.esm.js` | <https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.esm.js> | `5dd9b3281aa64b461b42d9945f6adb2649d346502b12281a9ae0d46599a80eba` |
| `uPlot.min.css` | <https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.min.css> | `df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04` |
| `LICENSE` | <https://cdn.jsdelivr.net/npm/uplot@1.6.32/LICENSE> | `8f989229699b4fe2f1a0432d0e9edc338a8a911e250e2d1b01ecd770a5f5b1bd` |

The hashes match the Subresource Integrity digests jsDelivr publishes for the
package. To confirm a copy still matches the pin:

```sh
sha256sum uPlot.esm.js uPlot.min.css LICENSE
```

## What is upstream and what is ours

* `uPlot.esm.js`, `uPlot.min.css`, `LICENSE` — verbatim upstream files, do not
  edit. Re-vendor by re-downloading from a pinned URL and checking the hash.
* `uplot-global.js` — **ours**, not upstream. It is the two-line bridge that
  imports the ESM default export and publishes it as `window.uPlot`, which is
  the surface `src/charts/uplot.rs` constructs charts through. A global rather
  than a Rust import specifier for the same reason `hledger-wasi.js` uses one:
  it keeps wasm-bindgen out of Trunk's output layout.

`uPlot.min.css` is linked from `index.html`; `uplot-global.js` is loaded there
as a module.

## Licence

MIT — see [`LICENSE`](./LICENSE). uPlot is © 2020 Leon Sorokin.
