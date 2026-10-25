/**
 * The pure part of the charts: reading hledger's CSV, and the numbers and colours that do not
 * need a browser.
 *
 * Both the plugin (which asks hledger and parses) and the window (which draws, with D3) import
 * from here, so the amount parser and the palette exist once. Everything in this
 * file is deterministic and covered by `scripts/check-example-plugin.mjs`.
 */

import { isLight } from './window-kit.js';

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
  // A commodity written as letters is a word, and is set apart from the number the way hledger
  // writes it: 27,500.00 IDR and IDR 27,500.00, but $12.50 and 12.5%.
  const prefix = amount.prefix || '';
  const suffix = amount.suffix || '';
  const before = /[a-z]/i.test(prefix) ? `${prefix} ` : prefix;
  const after = /[a-z]/i.test(suffix) ? ` ${suffix}` : suffix;
  return `${sign}${before}${group(amount.value, decimals)}${after}`;
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

/**
 * Every amount in one cell. hledger writes a balance held in several commodities as one cell,
 * "3500 CNY, 2530801.73 IDR, 300 USD"; a comma followed by a space separates them, which a
 * thousands separator never is.
 */
export function amountsIn(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return [];
  return raw.split(/,\s+/).map(money).filter((amount) => amount.raw !== '');
}

/** A commodity's name, as a person would say it: IDR, $, BBCA. */
export function commodityName(amount) {
  return (amount.suffix || amount.prefix || '').trim();
}

/**
 * A column of cells, read in one commodity: the one most of the cells are written in.
 *
 * Amounts in different commodities cannot be added up, and a chart adds up everything: its
 * totals, its stacks, its shares. So each cell is read as its amount in the main commodity, and
 * what was left out is named in `others`, for the window and the terminal to say, with how to
 * convert it. The first version read the first number in a cell as the whole of it, which drew
 * an account holding 2.5 million IDR and some yuan as 3,500 of a unit called "CNY, 260 EUR...".
 * A bare 0, which is how hledger writes an empty cell, belongs to every commodity.
 */
export function inOneCommodity(cells) {
  const parsed = cells.map(amountsIn);
  const counts = new Map();
  for (const parts of parsed) {
    for (const amount of parts) {
      if (!commodityName(amount)) continue;
      const key = `${amount.prefix}\u0000${amount.suffix}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let main = null;
  for (const [key, count] of counts) if (!main || count > main.count) main = { key, count };
  const [prefix, suffix] = main ? main.key.split('\u0000') : ['', ''];
  const others = new Set();
  const amounts = parsed.map((parts, index) => {
    let value = 0;
    const left = [];
    for (const amount of parts) {
      const plain = !commodityName(amount);
      if (plain || (amount.prefix === prefix && amount.suffix === suffix)) value += amount.value;
      else if (amount.value !== 0) left.push(commodityName(amount));
    }
    left.forEach((name) => others.add(name));
    return { value, prefix, suffix, raw: String(cells[index] == null ? '' : cells[index]).trim(), left };
  });
  return { amounts, unit: { prefix, suffix }, others: [...others].sort() };
}

/**
 * The commodities left out of the amounts a chart actually draws. A calendar of spending reads
 * the whole register, stock trades and all, but draws only the expenses; naming the stocks as
 * left out of it would be a warning about nothing.
 */
export function leftOutOf(amounts) {
  const names = new Set();
  for (const amount of amounts) for (const name of amount.left || []) names.add(name);
  return [...names].sort();
}

/**
 * What a chart says about commodities it left out, or nothing when there were none.
 *
 * The advice depends on the command: without a conversion, -X converts at market prices; with
 * one already asked for, what is left had no price to convert with, and a P directive is what
 * gives it one.
 */
export function leftOut(others, unit, command = '') {
  if (!others || !others.length) return '';
  const name = (unit && (unit.suffix || unit.prefix)) || 'one commodity';
  const listed = others.length > 6 ? `${others.slice(0, 6).join(', ')} and ${others.length - 6} more` : others.join(', ');
  const converting = /(^|\s)(-X|--exchange|-V|--market|--value)(\s|=|$)/.test(command);
  const advice = converting
    ? `hledger had no market price in ${name} for ${others.length === 1 ? 'it' : 'them'}; a P directive gives one.`
    : `Add -X ${name} to the query to convert them at market prices.`;
  return `Drawn in ${name}; amounts in ${listed} are left out. ${advice}`;
}

// --------------------------------------------------------------------------- series

/** Amounts added up, keeping the commodity of the first one that has it. */
export function add(amounts) {
  const present = amounts.filter(Boolean);
  const sum = present.reduce((total, amount) => total + (Number.isFinite(amount.value) ? amount.value : 0), 0);
  return {
    value: sum,
    prefix: (present.find((amount) => amount.prefix) || {}).prefix || '',
    suffix: (present.find((amount) => amount.suffix) || {}).suffix || '',
  };
}

/** The total of every series in a period. */
export function periodTotal(report, index) {
  return add(report.series.map((series) => series.amounts[index]));
}

/** The total of one series across every period. */
export function seriesTotal(series) {
  return add(series.amounts);
}

/**
 * The report without the empty periods at either end, and how many there were.
 *
 * `-p 2026` asks hledger for the whole year, months that have not happened included, and a
 * line that falls to zero in November reads as spending that stopped, not a month that has not
 * come. An empty period between two others is kept: there, nothing is an answer.
 */
export function trimmed(report) {
  const empty = (index) => report.series.every((entry) => !entry.amounts[index] || entry.amounts[index].value === 0);
  let first = 0;
  let last = report.periods.length - 1;
  while (first < last && empty(first)) first += 1;
  while (last > first && empty(last)) last -= 1;
  if (first === 0 && last === report.periods.length - 1) return { ...report, dropped: 0 };
  return {
    ...report,
    periods: report.periods.slice(first, last + 1),
    series: report.series.map((entry) => ({ ...entry, amounts: entry.amounts.slice(first, last + 1) })),
    dropped: report.periods.length - (last - first + 1),
  };
}

/**
 * The report as the chart options shape it: inverted, then accumulated, then as percentages.
 *
 * In that order because each reads the one before: a running total of inverted income is
 * income so far, and a percentage of running totals is each account's share of everything so
 * far. A percentage is of its period's total, so with one period it is each account's share.
 * The report is copied, never changed: the window keeps the original to come back to.
 */
export function shape(report, options = {}) {
  const series = report.series.map((entry) => ({
    ...entry,
    amounts: entry.amounts.map((amount) => ({ ...amount })),
  }));
  let unit = report.unit || { prefix: '', suffix: '' };
  if (options.invert) {
    for (const entry of series) for (const amount of entry.amounts) amount.value = -amount.value;
  }
  if (options.cumulative) {
    for (const entry of series) {
      let running = 0;
      for (const amount of entry.amounts) {
        running += amount.value;
        amount.value = running;
      }
    }
  }
  if (options.percent) {
    const totals = report.periods.map((_, index) => series.reduce((sum, entry) => sum + (entry.amounts[index] ? entry.amounts[index].value : 0), 0));
    for (const entry of series) {
      entry.amounts.forEach((amount, index) => {
        amount.value = totals[index] ? (100 * amount.value) / totals[index] : 0;
        amount.prefix = '';
        amount.suffix = '%';
      });
    }
    unit = { prefix: '', suffix: '%' };
  }
  return { ...report, series, unit };
}

/**
 * The entries worth drawing: largest first, the rest added up as one "other (n)".
 *
 * `--top N` keeps N. Without it a chart keeps up to `fits`, and past that `fits - 1` and an
 * other, so a chart never shows an other standing in for a single account. `--sort name` then
 * orders what was kept by name, with the other last, since it is not one of them.
 */
export function chosen(entries, { top, sort, fits = Infinity, size, combine }) {
  const ranked = [...entries].sort((left, right) => Math.abs(size(right)) - Math.abs(size(left)));
  const room = top || fits;
  let kept = ranked;
  if (ranked.length > room) {
    const keep = top || Math.max(1, fits - 1);
    kept = [...ranked.slice(0, keep), combine(ranked.slice(keep))];
  }
  if (sort === 'name') {
    kept = [...kept.filter((entry) => !entry.other).sort((left, right) => left.label.localeCompare(right.label)),
      ...kept.filter((entry) => entry.other)];
  }
  return kept;
}

/** The series of a report as `chosen` keeps them, the rest added up period by period. */
export function chosenSeries(report, options = {}, fits = 7) {
  return chosen(report.series, {
    top: options.top,
    sort: options.sort,
    fits,
    size: (entry) => seriesTotal(entry).value,
    combine: (rest) => ({
      label: `other (${rest.length})`,
      amounts: report.periods.map((_, index) => add(rest.map((entry) => entry.amounts[index]))),
      other: true,
    }),
  });
}

/** "1 account", "3 accounts". */
export function counted(count, noun) {
  return `${group(count, 0)} ${noun}${count === 1 ? '' : 's'}`;
}

/** "90.8%", or "<0.1%" for a sliver that would otherwise read as nothing. */
export function percent(value, total) {
  if (!total) return '0%';
  const share = (100 * value) / total;
  if (share > 0 && share < 0.05) return '<0.1%';
  return `${share.toFixed(1)}%`;
}

// --------------------------------------------------------------------------- colour

/**
 * A series palette that belongs to the theme.
 *
 * The hue starts at the accent and spreads by the golden angle, so two, five or nine series
 * are as far apart as the wheel allows, at one lightness that reads on the background. It is
 * one palette for every chart, so the eleven of them look like one plugin.
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

/** Hue, saturation and lightness of a hex colour. */
function toHsl(css) {
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
