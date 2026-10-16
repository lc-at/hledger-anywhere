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
  const data = JSON.stringify({ path, contents, writable, token }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(path)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body { margin:0; background:${colors.background}; color:${colors.foreground};
    font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; display:flex; flex-direction:column; }
  header { display:flex; align-items:baseline; gap:12px; padding:8px 12px;
    border-bottom:1px solid ${colors.dim}55; }
  h1 { font-size:14px; font-weight:600; margin:0; }
  .hint { color:${colors.dim}; font-size:12px; }
  #editor { flex:1; font-size:14px; }
  footer { display:flex; gap:12px; align-items:center; padding:4px 12px;
    border-top:1px solid ${colors.dim}55; min-height:22px; }
  #status { color:${colors.dim}; font-size:12px; }
  #warn { color:${colors.accent}; font-size:12px; }
  .ace_editor { background:${colors.background}; color:${colors.foreground}; }
  .ace_gutter { background:${colors.background}; color:${colors.dim}; }
  .ace_cursor { color:${colors.accent}; }
  .ace_active-line { background:${colors.dim}22; }
  .ace_selection { background:${colors.accent}44; }
  .ace_marker-layer .ace_selected-word { border:1px solid ${colors.accent}66; }
  .ace_scrollbar { background:${colors.background}; }
  .ace_scrollbar::-webkit-scrollbar { width:10px; }
  .ace_scrollbar::-webkit-scrollbar-thumb { background:${colors.dim}55; }
</style></head>
<body>
<header>
  <h1>${escape(path)}</h1>
  <span class="hint">${writable ? 'Ctrl/Cmd-S saves back to disk' : 'read-only: this file did not come from `open`'}</span>
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

  const editor = window.ace.edit('editor', {
    showPrintMargin: false,
    fontSize: '14px',
    highlightActiveLine: true,
  });
  // A `blob:` document has no origin Ace's workers can load from; without them,
  // editing, search and multi-cursor still work and only live linting is lost.
  editor.session.setUseWorker(false);
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

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}
