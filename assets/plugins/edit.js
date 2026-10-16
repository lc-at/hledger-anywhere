/**
 * Edit a loaded journal in a window, with Ace.
 *
 * This is the worked example of a plugin that *writes back*: it reads a file with
 * `host.read`, shows it in Ace, and `host.save` writes it to the folder an `open`
 * granted.
 *
 *     host.files()              the loaded files, as [{path, writable, main}]
 *     host.read(path)           one file's contents, or null
 *     host.save(path, contents) write it back; resolves {ok} or {error}
 *     host.window(title)        a window, filled in later
 *     host.colors()             the theme colours, so the window matches
 *     host.say(text)            a line in the terminal
 *
 * `edit` alone edits the main journal; `edit books/2024.journal` edits that file.
 * Only files that came from an `open` are writable; the rest open read-only.
 */

import { page } from './edit-window.js';

const FALLBACK_COLORS = {
  background: '#000000',
  foreground: '#d8d8d8',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

export default {
  async run(args, host) {
    const asked = String(args == null ? '' : args).trim();
    const files = typeof host.files === 'function' ? host.files() : [];
    const chosen = asked
      ? files.find((file) => file.path === asked)
      : (files.find((file) => file.main) || files[0]);

    if (!chosen) {
      const have = files.map((file) => file.path).join(', ');
      host.say(
        `${host.name}: ${asked ? `${asked} is not loaded` : 'nothing is loaded'}.` +
          `${have ? ` Loaded: ${have}.` : ' Run `open` or `upload` first.'}`,
      );
      return;
    }

    const colors = typeof host.colors === 'function' ? host.colors() : FALLBACK_COLORS;

    // Opened first, filled when the contents are ready.
    const view = host.window(`hledger: ${chosen.path}`);
    if (!view) {
      host.say(`${host.name}: the browser blocked the window for ${chosen.path}.`);
      return;
    }
    view.write(shell(colors, chosen.path, 'Opening…'));

    const contents = typeof host.read === 'function' ? host.read(chosen.path) : null;
    if (contents == null) {
      view.write(shell(colors, chosen.path, 'The file could not be read.'));
      host.say(`${host.name}: ${chosen.path} could not be read.`);
      return;
    }

    const token = listen(host, chosen.path);
    view.write(
      page({
        path: chosen.path,
        contents,
        writable: !!chosen.writable,
        colors,
        token,
        module: beside('edit-window.js'),
        scripts: [beside('vendor/ace/ace.js')],
      }),
    );
    host.say(
      `${host.name}: ${chosen.path} in a new window${chosen.writable ? '' : ', read-only'}.`,
    );
  },
};

/**
 * Let this window write back through the plugin on this side of the window.
 *
 * The window is a page with no API of its own, so the bridge is a function on the
 * opener, kept by a token the page carries — the same shape the chart plugin uses.
 */
function listen(host, path) {
  const token = `edit-${(listen.count = (listen.count || 0) + 1)}-${Date.now().toString(36)}`;
  const scope = typeof window === 'undefined' ? globalThis : window;
  const bridges = (scope.__editBridges = scope.__editBridges || {});
  bridges[token] = {
    async save(contents) {
      const answer = await host.save(path, contents);
      if (answer && answer.error) {
        throw new Error(answer.error);
      }
      return true;
    },
  };
  return token;
}

/** A file beside this plugin, as an absolute URL. */
function beside(name) {
  return new URL(`./${name}`, import.meta.url).href;
}

/** The window before there is anything to show, and when something went wrong. */
function shell(colors, title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(title)}</title></head>
<body style="margin:0;background:${colors.background};color:${colors.foreground};
  font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:960px;margin:0 auto;padding:24px">
  <h1 style="font-size:18px;font-weight:600;margin:0 0 4px">${escape(title)}</h1>
  <p style="color:${colors.dim};margin:0">${escape(message)}</p>
</main>
</body></html>`;
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}
