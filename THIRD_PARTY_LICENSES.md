# Third-party licences

hledger-anywhere's own code is licensed **AGPL-3.0-or-later**. It depends on the
following third-party components, which remain under their own licences.

## hledger — GPL-3.0-or-later

**This is the important one.** The application runs hledger, which is licensed
under the GNU General Public License v3.0 or later. hledger is not just linked
against here, it is the whole point: the app is a terminal in front of it.

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

## xterm.js — MIT

Vendored in `assets/js/vendor/xterm/`, so the app has no JavaScript build step:

| File | Upstream |
|---|---|
| `xterm.js`, `xterm.css`, `LICENSE` | `@xterm/xterm@5.5.0` — <https://github.com/xtermjs/xterm.js> |
| `addon-fit.js` | `@xterm/addon-fit@0.10.0` — <https://github.com/xtermjs/xterm.js> |

They are loaded by plain `<script>`/`<link>` tags in `index.html` and reached
through the globals they publish (`window.Terminal`, `window.FitAddon.FitAddon`),
which is why no npm dependency and no bundler are involved.

## remoteStorage.js — MIT

Vendored in `assets/js/vendor/remotestorage/`, loaded on demand by
`src/remote/client.rs` when a remote command is first used.

- Upstream: <https://github.com/remotestorage/remotestorage.js>
- Pinned version: **2.0.0-beta.10** (npm's `latest` and `stable` both point at it)

## Rust crates

The Rust dependency tree is not listed here; run `cargo license` or
`cargo tree` for the exact set at a given revision. The direct dependencies and
their licences are:

| Crate | Licence |
|---|---|
| `wasm-bindgen`, `js-sys`, `web-sys`, `wasm-bindgen-futures` | MIT OR Apache-2.0 |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `idb` | MIT OR Apache-2.0 |
| `thiserror` | MIT OR Apache-2.0 |
| `console_error_panic_hook` | MIT OR Apache-2.0 |
