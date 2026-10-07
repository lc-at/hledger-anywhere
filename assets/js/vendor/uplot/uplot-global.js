/**
 * hledger-anywhere — uPlot loader (project code, not upstream).
 *
 * Imports the vendored ESM build and publishes it as `window.uPlot`, which is
 * the entire surface `src/charts/uplot.rs` talks to. A global rather than a
 * wasm-bindgen module import, for the same reason `hledger-wasi.js` uses one:
 * it keeps the Rust side independent of Trunk's output layout, and it makes the
 * boundary debuggable from the browser console (`window.uPlot`).
 *
 * Loaded as a module from index.html. Module scripts are deferred, and the
 * wasm bootstrap suspends on its own top-level `await init(...)`, so this file
 * runs before the Rust chart view mounts. If it ever did not, the Rust side
 * reports "uPlot is not loaded" instead of failing silently.
 */
import uPlot from './uPlot.esm.js';

window.uPlot = uPlot;
