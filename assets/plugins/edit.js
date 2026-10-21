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
import { beside, bridge, colorsOf, shell } from './window-kit.js';

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
          `${have ? ` Loaded: ${have}.` : ' Run open or upload first.'}`,
      );
      return;
    }

    const colors = colorsOf(host);

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

    // The window writes back through the plugin, which is the side that can reach the disk.
    const token = bridge('__editBridges', 'edit', {
      async save(text) {
        const answer = await host.save(chosen.path, text);
        if (answer && answer.error) throw new Error(answer.error);
        return true;
      },
    });
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
