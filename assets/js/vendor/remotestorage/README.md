# remoteStorage.js (vendored)

`remotestorage.js`, copied here so the project needs no npm dependency and no
JavaScript build step.

| File | From |
|---|---|
| `remotestorage.js` (UMD, publishes `window.RemoteStorage`) | `remotestoragejs@2.0.0-beta.10` `release/remotestorage.js` |
| `LICENSE` | the same package (MIT) |

The version is deliberate: `remotestoragejs`'s npm `latest` **and** `stable` tags
both point at `2.0.0-beta.10`, and 1.x is no longer published with a browser
bundle. The 2.x API is promise-based (`getListing` and `getFile` resolve), which is
what `src/remote/client.rs` expects.

To refresh it, download the same path from <https://unpkg.com/> and replace both
files.

It is **not** a `<script>` tag in `index.html`. It is 146 KB that most visits never
need, so `src/remote/client.rs` injects it the first time a remote command runs,
and the first thing this app has to do is be a terminal.
