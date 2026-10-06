# Third-party licences

hledger-anywhere's own code is licensed **AGPL-3.0-or-later**. It depends on the
following third-party components, which remain under their own licences.

## hledger — GPL-3.0-or-later

**This is the important one.** The application runs hledger, which is licensed
under the GNU General Public License v3.0 or later.

- Upstream: <https://github.com/hledgerorg/hledger>
- Pinned version: **1.52.4** (see `wasm.lock` and `scripts/build-hledger-wasm.sh`)

Because a compiled `hledger.wasm` is delivered to the browser, its GPL
obligations travel with it. The approach taken here:

- `hledger.wasm` is a **separate, independently loaded WASI command module**. It
  is invoked over argv and stdio and is never statically linked into the Rust
  WebAssembly module, which orchestrates it the way a shell would.
- The exact upstream source is always identifiable: it is pinned by tag in
  `scripts/build-hledger-wasm.sh`, and the built artifact is pinned by size and
  SHA-256 in `wasm.lock`.
- `scripts/build-hledger-wasm.sh` reproduces the binary from that source, so the
  corresponding source for any shipped build is available from upstream plus the
  two local build inputs listed below.

If you distribute a build of this application, you must also satisfy the GPL for
the hledger binary: convey the corresponding source, or a written offer to
provide it.

### Local build inputs that are part of the corresponding source

| Path | Licence | Purpose |
|---|---|---|
| `hledger-wasm/cabal.project` | AGPL-3.0-or-later (this project) | Pins GHC boot libraries and adds the stub package |
| `hledger-wasm/terminal-size-stub/` | AGPL-3.0-or-later (this project) | Drop-in replacement for `terminal-size`, whose `ioctl`-based implementation cannot work under WASI. The module interface mirrors the BSD-3-Clause `terminal-size` package |

## @bjorn3/browser_wasi_shim — MIT

Vendored as source in `assets/js/vendor/` (a copy of the published `dist/`
directory of version 0.4.2) so the app needs no npm step and no bundler.

- Upstream: <https://github.com/bjorn3/browser_wasi_shim>

## Interim artifact: hledger-wasm — GPL-3.0-or-later

`wasm.lock` may point at the `hledger-wasm@0.1.0` npm package
(<https://github.com/reesericci/hledger-wasm>), used only as a fallback while the
full CLI build is unavailable. It is a fork of hledger and is likewise
GPL-3.0-or-later. Only its `dist/hledger-wasm.wasm` binary is fetched; its
JavaScript bridge is deliberately not used.

## Rust crates

The Rust dependency tree is not listed here; run `cargo license` or
`cargo tree` for the exact set at a given revision. The direct dependencies and
their licences are:

| Crate | Licence |
|---|---|
| `leptos` | MIT |
| `wasm-bindgen`, `js-sys`, `web-sys`, `wasm-bindgen-futures` | MIT OR Apache-2.0 |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `rust_decimal` | MIT |
| `thiserror` | MIT OR Apache-2.0 |
| `console_error_panic_hook` | MIT OR Apache-2.0 |
