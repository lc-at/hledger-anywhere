/**
 * What every bundled plugin's window needs, once: escaping, the theme's colours, the page shown
 * while a window waits, and the bridge a window calls back through.
 *
 * The chart and edit plugins each open a window of their own. They used to carry a copy of all
 * of this each, and five copies of `escape` had already started to differ in how they were
 * written. Pure apart from `bridge`, which registers on the page that opened the window.
 */

/** The app's built-in theme, for a host that cannot say which theme is in use. */
export const FALLBACK_COLORS = {
  background: '#000000',
  foreground: '#d8d8d8',
  cursor: '#ff9f1c',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

/** The colours of the theme in use, or the built-in ones. */
export function colorsOf(host) {
  return typeof host.colors === 'function' ? host.colors() : FALLBACK_COLORS;
}

/** Text made safe to put inside HTML, an attribute included. */
export function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

/** Whether a hex colour is light, by the same measure the app's Rust side uses. */
export function isLight(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
}

/** `other` mixed into `css`, `percent` of the way. */
export function mix(css, other, percent) {
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

/**
 * The window before there is anything to show, and when something went wrong.
 *
 * The same heading and the same dimmed line in every plugin's window, so a chart that is still
 * reading hledger and an editor that is still opening a file look like one app.
 */
export function shell(colors, title, message) {
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

/**
 * A file beside the plugins, as an absolute URL.
 *
 * A window is a `blob:` document, so a relative path in it would resolve against nothing, and a
 * repository may live anywhere: everything a window needs travels with the plugins.
 */
export function beside(name) {
  return new URL(`./${name}`, import.meta.url).href;
}

/**
 * Register a bridge a window can call back through, and return the token that finds it.
 *
 * The window is a page with no API of its own, so the bridge is an object on the page that
 * opened it, `window[registry][token]`, and the page carries its token. In node, where the
 * checks run the plugins, `globalThis` stands in for the window.
 */
export function bridge(registry, prefix, api) {
  bridge.count = (bridge.count || 0) + 1;
  const token = `${prefix}-${bridge.count}-${Date.now().toString(36)}`;
  const scope = typeof window === 'undefined' ? globalThis : window;
  const bridges = (scope[registry] = scope[registry] || {});
  bridges[token] = api;
  return token;
}
