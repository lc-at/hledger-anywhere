/**
 * The pure part of the charts: reading hledger's CSV, and the numbers and colours that do not
 * need a browser.
 *
 * Both the plugin (which asks hledger and parses) and the window (which draws, with Chart.js or
 * D3) import from here, so the amount parser and the palette exist once. Everything in this
 * file is deterministic and covered by `scripts/check-example-plugin.mjs`.
 */

// --------------------------------------------------------------------------- numbers

/** 1234567.891 -> "1,234,567.89", without asking the browser's locale. */
export function group(number, decimals = 2) {
  const fixed = Math.abs(number).toFixed(decimals);
  const [whole, fraction] = fixed.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

/** An amount as a person writes it: -$1,286.40. */
export function format(amount, decimals = 2) {
  const sign = amount.value < 0 ? '-' : '';
  return `${sign}${amount.prefix}${group(amount.value, decimals)}${amount.suffix}`;
}

// --------------------------------------------------------------------------- CSV

/** One CSV line, honouring quoted cells. */
export function split(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { cells.push(cell); cell = ''; }
    else cell += character;
  }
  cells.push(cell);
  return cells;
}

/**
 * An amount, with the commodity hledger wrote around it kept.
 *
 * hledger writes "$1,286.40", "-$12.00" or "1234.56 EUR" depending on the journal, and the
 * currency belongs on the chart. Both decimal styles are read, since `--decimal-mark` is a
 * thing a journal can set. `raw` is kept so a section row can be told from a row of zeroes.
 */
export function money(text) {
  const raw = String(text == null ? '' : text).trim();
  const empty = { value: 0, prefix: '', suffix: '', raw: '' };
  if (raw === '') return empty;

  // The sign is read before the digits are looked for, because hledger puts the commodity
  // between them: `-$12.00` is negative, and a digit match that never saw the minus read it
  // as twelve. `$12.00-` and the accounting `(12.00)` are read too.
  let body = raw;
  let sign = 1;
  if (/^\(.*\)$/.test(body)) {
    sign = -1;
    body = body.slice(1, -1).trim();
  }
  if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1).trim();
  } else if (body.endsWith('-')) {
    sign = -1;
    body = body.slice(0, -1).trim();
  }

  // The sign can also sit between the commodity and the digits: hledger writes `$-12.00`,
  // which a digits-only match read as twelve. It is part of the number, so it is matched.
  const found = body.match(/-?[\d.,]+/);
  if (!found) return { ...empty, raw };
  let digits = found[0];
  const comma = digits.lastIndexOf(',');
  const dot = digits.lastIndexOf('.');
  digits = comma > dot
    ? digits.replace(/\./g, '').replace(',', '.')   // 1.234,56
    : digits.replace(/,/g, '');                     // 1,234.56
  const value = Number(digits);
  if (!Number.isFinite(value)) return { ...empty, raw };

  return {
    value: sign * value,
    prefix: body.slice(0, found.index).trim(),
    suffix: body.slice(found.index + found[0].length).trim(),
    raw,
  };
}

/** The commodity to label an axis with: the first one hledger actually wrote. */
export function unitOf(amounts) {
  const found = amounts.find((amount) => amount.prefix || amount.suffix);
  return { prefix: found ? found.prefix : '', suffix: found ? found.suffix : '' };
}

// --------------------------------------------------------------------------- colour

/**
 * A series palette that belongs to the theme.
 *
 * The hue starts at the accent and spreads by the golden angle, so two, five or nine series
 * are as far apart as the wheel allows, at one lightness that reads on the background. It is
 * the same palette the Chart.js chart used, so the two libraries look like one plugin.
 */
export function palette(colors, count) {
  const [hue] = toHsl(colors.accent);
  const light = isLight(colors.background);
  const lightness = light ? 40 : 66;
  return Array.from({ length: Math.max(count, 1) }, (_, index) => {
    const shifted = (hue + index * 137.508) % 360;
    return `hsl(${shifted.toFixed(0)} 55% ${lightness}%)`;
  });
}

/** Whether a hex colour is light, by the same measure the app's Rust side uses. */
export function isLight(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
}

/** Hue, saturation and lightness of a hex colour. */
export function toHsl(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return [210, 60];
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness * 100];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return [(hue + 360) % 360, saturation * 100, lightness * 100];
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
