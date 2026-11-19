// The plugin host, built the way every check that runs a plugin needs one.
//
// The app builds this object in Rust: `App::host` in src/app.rs puts the nine methods the app
// answers on it, the loader adds `name` and `window` in assets/js/plugins.js, and
// docs/plugins.md writes all eleven down as one table. A check has no app and no loader, so
// this module is that same host, with only what genuinely varies behind it:
//
//   * the backend: where the files are and what writing one means. A map in memory, files on
//     disk with their stamps, a check's own `/live/*` server. It answers `files()`,
//     `read(path)`, `save(path, contents)` and `refresh()`.
//   * `hledger`: what runs a command. What a fixture prints, the shipped engine, a POST.
//   * `say`, `colors` and `window`: where the words, the theme and the page's html go.
//   * `setting` and `remember`: given by a check that keeps a store of its own, and left out
//     by one that does not, because an empty store is the app's own answer for a plugin that
//     has remembered nothing.
//
// Everything else is the contract, in one place. `scripts/check-host-contract.mjs` reads this
// file, `App::host` and the table in docs/plugins.md, and fails if the three name different
// methods.
//
// The shapes are the ones docs/plugins.md promises. `read` answers with the text itself
// rather than a promise of it, since the plan is worked out synchronously. `save` answers
// `{ok}` or `{error}` and never rejects, because a refusal is an answer; a backend refuses a
// file that changed under it rather than throwing, as the app's own save does. `refresh`
// answers `{changed, missing}`, with `error` beside them when something was refused. The one
// way a check makes `save` reject is by standing in for an app that has gone away
// (`window.__throw`), which is what a plugin sees when the app is gone and the bridge it
// asked gets no answer.

/**
 * The host a plugin is handed, from the parts that vary: the backend's four methods,
 * `hledger`, and the sinks a check has words for.
 *
 * `backend` and `hledger` are called as they are written here, with the host's own state
 * closed over where a check needs it: a check that makes the host refuse a write or stop
 * answering does it from inside its backend, the way the app's closures hold the app.
 */
export function makeHost({ name, colors, say, setting, remember, window: open, backend, hledger }) {
  // What this plugin remembered, for a check that keeps no store of its own.
  const kept = {};
  return {
    // `name` and `window` are the loader's half in the app (assets/js/plugins.js:54-55): a
    // window has to be opened by the browser before the plugin awaits, and the plugin's own
    // word travels with it. There is no loader here, so they are built with the rest.
    name,
    window: open,
    colors,
    say,
    setting: setting || ((key) => (key in kept ? kept[key] : null)),
    remember: remember || ((key, value) => { kept[key] = String(value); }),
    files: () => backend.files(),
    read: (path) => backend.read(path),
    save: async (path, contents) => {
      const answer = (await backend.save(path, contents)) || {};
      return answer.error ? answer : { ...answer, ok: true };
    },
    refresh: async () => {
      const report = (await backend.refresh()) || {};
      const answer = { changed: report.changed || [], missing: report.missing || [] };
      if (report.error) answer.error = report.error;
      return answer;
    },
    hledger,
  };
}
