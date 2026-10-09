# xterm.js (vendored)

The terminal emulator the app renders into, copied here so the project needs no
npm dependency and no JavaScript build step.

| File | From |
|---|---|
| `xterm.js` (UMD, publishes `window.Terminal`) | `@xterm/xterm@5.5.0` `lib/xterm.js` |
| `xterm.css` | `@xterm/xterm@5.5.0` `css/xterm.css` |
| `addon-fit.js` (publishes `window.FitAddon.FitAddon`) | `@xterm/addon-fit@0.10.0` `lib/addon-fit.js` |
| `LICENSE` | `@xterm/xterm@5.5.0` `LICENSE` (MIT) |

To refresh it, download the same paths from <https://unpkg.com/> and replace them.

They are loaded by plain `<script>`/`<link>` tags in `index.html` — deliberately
not as modules — because `src/terminal/view.rs` asks for the globals when the wasm
bootstrap runs, and a non-module script in the head has always executed by then.
