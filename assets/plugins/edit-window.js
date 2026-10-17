/**
 * The editor window: Ace, one file, and a save that goes back through the app.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window;
 * the window imports `mount` to draw it. The data travels in a JSON block, the editor
 * arrives as a classic script from beside this plugin, and the window calls back through
 * a bridge on its opener — the same shape the chart window uses.
 */

/** The whole document, with the file in a JSON block and the editor to be mounted. */
export function page({ path, contents, writable, colors, token, module, scripts = [] }) {
  const data = JSON.stringify({ path, contents, writable, colors, token }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(path)}</title>
<style>
  :root { color-scheme: ${isLight(colors.background) ? 'light' : 'dark'}; }
  html, body { height: 100%; }
  body { margin:0; background:${colors.background}; color:${colors.foreground};
    font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; display:flex; flex-direction:column; }
  header { display:flex; align-items:baseline; gap:12px; padding:8px 12px;
    border-bottom:1px solid ${colors.dim}55; }
  h1 { font-size:14px; font-weight:600; margin:0; }
  .hint { color:${colors.dim}; font-size:12px; }
  #editor { flex:1; font-size:14px; background:${colors.background}; }
  footer { display:flex; gap:12px; align-items:center; padding:4px 12px;
    border-top:1px solid ${colors.dim}55; min-height:22px; }
  #status { color:${colors.dim}; font-size:12px; }
  #warn { color:${colors.accent}; font-size:12px; }
</style></head>
<body>
<header>
  <h1>${escape(path)}</h1>
  <span class="hint">${writable ? 'Ctrl/Cmd-S saves back to disk' : 'read-only: this file came from an upload, not an opened folder'}</span>
</header>
<div id="editor"></div>
<footer><span id="status"></span><span id="warn" hidden></span></footer>
<script type="application/json" id="edit-data">${data}</script>
${scripts.map((src) => `<script src="${escape(src)}"></script>`).join('\n')}
<script type="module">import { mount } from ${JSON.stringify(module)}; mount();</script>
</body></html>`;
}

/**
 * Draw the editor and wire its save.
 *
 * Only this function touches the DOM. The editor arrives in the page's own script
 * tags, so if it did not load this leaves a message rather than an empty page.
 */
export function mount(root = document) {
  const data = JSON.parse(root.getElementById('edit-data').textContent);
  const status = root.getElementById('status');
  const warn = root.getElementById('warn');

  if (typeof window.ace !== 'object') {
    show(warn, 'The editor did not load, so the file cannot be shown here.');
    return;
  }

  const colors = data.colors || FALLBACK_COLORS;
  const editor = window.ace.edit('editor', {
    showPrintMargin: false,
    fontSize: '14px',
    highlightActiveLine: true,
    // A `blob:` document has no origin Ace's workers can load from; without them
    // editing, search and multi-cursor still work and only live linting is lost.
    useWorker: false,
  });
  editor.session.setUseWorker(false);
  editor.session.setMode('ace/mode/text');
  editor.setTheme(defineTheme(window.ace, colors));
  editor.setValue(data.contents, -1);
  editor.clearSelection();

  let dirty = false;
  editor.session.on('change', () => {
    if (dirty) return;
    dirty = true;
    show(status, 'Unsaved changes');
  });

  editor.commands.addCommand({
    name: 'save',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: save,
  });

  async function save() {
    if (!data.writable) {
      show(warn, 'This file has nowhere to write: open its folder with `open` first.');
      return;
    }
    const bridges = window.opener && window.opener.__editBridges;
    const bridge = bridges && bridges[data.token];
    if (!bridge) {
      show(warn, 'This window has lost touch with the app. Run `edit` again.');
      return;
    }
    try {
      show(status, 'Saving…');
      await bridge.save(editor.getValue());
      dirty = false;
      show(status, 'Saved');
      show(warn, '');
    } catch (error) {
      show(status, '');
      show(warn, error && error.message ? error.message : String(error));
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  function show(element, message) {
    if (!element) return;
    element.textContent = message || '';
    element.hidden = !message;
  }
}

const FALLBACK_COLORS = {
  background: '#000000',
  foreground: '#d8d8d8',
  cursor: '#ff9f1c',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

/** Ace themes are modules; each window defines one from the app's own palette. */
let themes = 0;

function defineTheme(ace, colors) {
  const name = `ace/theme/hledger-anywhere-${(themes += 1)}`;
  const className = `ace-hledger-anywhere-${themes}`;
  const selection = mix(colors.background, colors.foreground, 25);
  const cssText = `
.${className}.ace_editor { background: ${colors.background}; color: ${colors.foreground}; }
.${className} .ace_gutter { background: ${colors.background}; color: ${colors.dim}; }
.${className} .ace_gutter-active-line { background: ${colors.dim}33; }
.${className} .ace_cursor { color: ${colors.cursor}; }
.${className} .ace_marker-layer .ace_selection { background: ${selection}; }
.${className} .ace_marker-layer .ace_active-line { background: ${colors.dim}22; }
.${className} .ace_marker-layer .ace_bracket { margin: -1px 0 0 -1px; border: 1px solid ${colors.dim}; }
.${className} .ace_marker-layer .ace_selected-word { border: 1px solid ${colors.accent}66; }
.${className} .ace_invisible { color: ${colors.dim}; }
.${className} .ace_print-margin { width: 1px; background: ${colors.dim}44; }
.${className} .ace_scrollbar { background: ${colors.background}; }
.${className} .ace_scrollbar::-webkit-scrollbar { width: 10px; }
.${className} .ace_scrollbar::-webkit-scrollbar-thumb { background: ${colors.dim}55; }
`.trim();
  ace.define(name, ['ace/lib/dom'], (require, exports) => {
    exports.isDark = !isLight(colors.background);
    exports.cssClass = className;
    exports.cssText = cssText;
    require('ace/lib/dom').importCssString(cssText, className, false);
  });
  return name;
}

/** Whether a hex colour is light, by the same measure the app's Rust side uses. */
function isLight(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
}

/** `other` mixed into `css`, `percent` of the way; the selection uses this. */
function mix(css, other, percent) {
  const read = (value) => {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
    if (!match) return [0, 0, 0];
    const number = parseInt(match[1], 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  };
  const mine = read(css);
  const theirs = read(other);
  return `#${mine
    .map((channel, index) => Math.round((channel * (100 - percent) + theirs[index] * percent) / 100))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}
