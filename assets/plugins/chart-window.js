/**
 * The chart window: five ways to look at the same numbers, and the controls to switch.
 *
 * Shared by both sides of the plugin. The plugin imports the drawing to write the first page;
 * the window imports `mount` to redraw without asking hledger again. Everything that decides
 * what a chart looks like is a plain function from data to a string, so it can be tested
 * without a browser, and only `mount` touches the DOM.
 *
 * The data shape is one row per series and one column per period, which is what hledger's
 * balance CSV is:
 *
 *   { periods: ['2024-01', '2024-02'],
 *     series: [{ label: 'expenses:rent', amounts: [{value, prefix, suffix}, ...] }],
 *     unit: { prefix: '$', suffix: '' } }
 */

const TYPES = [
  { id: 'line', name: 'Line', needs: 'many' },
  { id: 'stacked', name: 'Stacked', needs: 'many' },
  { id: 'columns', name: 'Columns', needs: 'many' },
  { id: 'ranking', name: 'Ranking', needs: 'any' },
  { id: 'donut', name: 'Donut', needs: 'any' },
];

/** How many periods the range buttons show, and what they are called. */
const RANGES = [
  { id: '3', name: '3', periods: 3 },
  { id: '6', name: '6', periods: 6 },
  { id: '12', name: '12', periods: 12 },
  { id: 'all', name: 'All', periods: Infinity },
];

const PADDING = { top: 24, right: 28, bottom: 46, left: 88 };
const WIDTH = 900;

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

/** A short form for axis labels: -$1.2k, $986, $0. */
export function compact(amount) {
  const size = Math.abs(amount.value);
  const sign = amount.value < 0 ? '-' : '';
  if (size >= 1000) {
    return `${sign}${amount.prefix}${group(amount.value / 1000, 1)}k${amount.suffix}`;
  }
  return format(amount, size !== 0 && size < 10 ? 2 : 0);
}

/**
 * Round numbers for an axis: a step of 1, 2 or 5 times a power of ten.
 *
 * An axis labelled 1,037.42 and 2,074.84 is not an axis.
 */
export function ticks(low, high) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high === low) return [low || 0];
  const raw = (high - low) / 4;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((multiple) => multiple * power).find((size) => size >= raw) || power;
  const start = Math.floor(low / step) * step;
  const marks = [];
  for (let value = start; value <= high + step / 2; value += step) {
    marks.push(Math.abs(value) < step / 1000 ? 0 : value);
  }
  return marks;
}

/** The colours the series are drawn in, worked out from the theme's accent. */
export function palette(colors, count) {
  const [hue, saturation, lightness] = toHsl(colors.accent);
  const light = isLight(colors.background);
  return Array.from({ length: Math.max(count, 1) }, (_, index) => {
    // Spread around the wheel, keeping the theme's own saturation and lightness so the
    // series belong to the theme rather than to a palette invented here.
    const shifted = (hue + index * (index % 2 ? 137 : 47)) % 360;
    return `hsl(${shifted.toFixed(0)} ${Math.max(saturation, 35)}% ${light ? 38 : 62}%)`;
  });
}

/** Whether a CSS colour is light, near enough, for choosing readable series colours. */
function isLight(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
}

/** Hue, saturation and lightness of a hex colour. */
function toHsl(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return [210, 60, 55];
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

// --------------------------------------------------------------------------- the report

/** The series worth drawing, largest first, with the rest added up as "other". */
export function ordered(report, limit = 7) {
  const ranked = report.series
    .map((series) => ({ ...series, sum: sum(values(series)) }))
    .sort((left, right) => Math.abs(right.sum) - Math.abs(left.sum));
  if (ranked.length <= limit) return ranked;
  const shown = ranked.slice(0, limit - 1);
  const rest = ranked.slice(limit - 1);
  return [
    ...shown,
    {
      label: `other (${rest.length})`,
      amounts: report.periods.map((_, index) => add(rest.map((series) => series.amounts[index]))),
      sum: sum(rest.map((series) => series.sum)),
      other: true,
    },
  ];
}

/** The periods to show, from the range buttons. */
export function windowed(report, range) {
  const wanted = RANGES.find((entry) => entry.id === range) || RANGES[3];
  if (wanted.periods >= report.periods.length) return report;
  const keep = report.periods.length - wanted.periods;
  return {
    ...report,
    periods: report.periods.slice(keep),
    series: report.series.map((series) => ({ ...series, amounts: series.amounts.slice(keep) })),
  };
}

function values(series) {
  return series.amounts.map((amount) => amount.value);
}

function sum(numbers) {
  return numbers.reduce((total, number) => total + (Number.isFinite(number) ? number : 0), 0);
}

function add(amounts) {
  const present = amounts.filter(Boolean);
  return {
    value: sum(present.map((amount) => amount.value)),
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

/** What the page says under the heading. */
export function headline(report, range) {
  if (report.periods.length <= 1) {
    return `${report.series.length} accounts, ${report.periods[0] || 'one period'}`;
  }
  const first = report.periods[0];
  const last = report.periods[report.periods.length - 1];
  return `${report.periods.length} periods, ${first} to ${last}${range === 'all' ? '' : ` (last ${range})`}`;
}

// --------------------------------------------------------------------------- drawing

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

function svg(body, height, label) {
  return `<svg viewBox="0 0 ${WIDTH} ${height}" width="100%" style="max-width:960px;display:block"
  role="img" aria-label="${escape(label)}">${body}</svg>`;
}

/** Gridlines and the labels down the side. */
function yAxis(marks, y, plot, unit, colors) {
  return marks.map((value) => `
    <line x1="${plot.left}" y1="${y(value)}" x2="${plot.right}" y2="${y(value)}"
      stroke="${colors.dim}" stroke-opacity="${value === 0 ? '0.85' : '0.25'}"
      stroke-dasharray="${value === 0 ? '' : '3 4'}"/>
    <text x="${plot.left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="11"
      fill="${colors.dim}">${escape(compact({ value, ...unit }))}</text>`).join('');
}

/** The labels along the bottom, thinned so they never collide. */
function xAxis(periods, x, height, colors) {
  const every = Math.max(1, Math.ceil(periods.length / 12));
  return periods.map((label, index) => (index % every === 0 || index === periods.length - 1
    ? `<text x="${x(index)}" y="${height - 16}" text-anchor="middle" font-size="11"
        fill="${colors.dim}">${escape(label)}</text>`
    : '')).join('');
}

/** One line per series, with the total when the query asked for a single line. */
export function line(report, colors, options = {}) {
  const height = 360;
  const plot = { left: PADDING.left, right: WIDTH - PADDING.right, top: PADDING.top, bottom: height - PADDING.bottom };
  const series = options.total
    ? [{ label: options.label || 'total', amounts: report.periods.map((_, index) => periodTotal(report, index)) }]
    : ordered(report, 7);
  const palette_ = palette(colors, series.length);
  const every = [0, ...series.flatMap((entry) => values(entry)), ...report.periods.map((_, index) => periodTotal(report, index).value)];
  const marks = ticks(Math.min(0, ...every), Math.max(0, ...every));
  const low = marks[0];
  const high = marks[marks.length - 1];
  const span = high - low || 1;
  const step = report.periods.length > 1 ? (plot.right - plot.left) / (report.periods.length - 1) : 0;
  const x = (index) => plot.left + index * step;
  const y = (value) => plot.bottom - ((value - low) / span) * (plot.bottom - plot.top);

  const lines = series.map((entry, index) => {
    const points = entry.amounts.map((amount, position) => `${x(position)},${y(amount.value)}`).join(' ');
    const colour = palette_[index];
    const dots = entry.amounts.map((amount, position) => `
      <circle cx="${x(position)}" cy="${y(amount.value)}" r="3.5" fill="${colour}"
        stroke="${colors.background}" stroke-width="1.5" data-point="${escape(entry.label)}"
        data-period="${escape(report.periods[position])}" data-value="${escape(format(amount))}">
        <title>${escape(entry.label)} · ${escape(report.periods[position])}: ${escape(format(amount))}</title>
      </circle>`).join('');
    return `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" data-series="${escape(entry.label)}"/>${dots}`;
  }).join('');

  const area = series.length === 1 && options.fill !== false
    ? `<polygon points="${plot.left},${y(0)} ${series[0].amounts.map((amount, index) => `${x(index)},${y(amount.value)}`).join(' ')} ${x(report.periods.length - 1)},${y(0)}"
        fill="${palette_[0]}" fill-opacity="0.16"/>`
    : '';

  return svg(`
    ${yAxis(marks, y, plot, report.unit, colors)}
    ${area}
    ${lines}
    ${xAxis(report.periods, x, height, colors)}`, height, options.label || 'Balance over time');
}

/** Stacked areas: the shape of spending by category. */
export function stacked(report, colors, options = {}) {
  const height = 360;
  const plot = { left: PADDING.left, right: WIDTH - PADDING.right, top: PADDING.top, bottom: height - PADDING.bottom };
  const series = ordered(report, 7);
  const palette_ = palette(colors, series.length);
  const step = report.periods.length > 1 ? (plot.right - plot.left) / (report.periods.length - 1) : 0;
  const x = (index) => plot.left + index * step;

  const bands = series.map((entry) => values(entry));
  const totals = report.periods.map((_, index) => sum(bands.map((band) => band[index])));
  const marks = ticks(Math.min(0, ...totals), Math.max(0, ...totals));
  const low = marks[0];
  const high = marks[marks.length - 1];
  const span = high - low || 1;
  const y = (value) => plot.bottom - ((value - low) / span) * (plot.bottom - plot.top);

  let running = report.periods.map(() => 0);
  const areas = series.map((entry, index) => {
    const lower = [...running];
    running = running.map((value, position) => value + bands[index][position]);
    const up = running.map((value, position) => `${x(position)},${y(value)}`).join(' ');
    const down = [...lower].reverse().map((value, position) => `${x(lower.length - 1 - position)},${y(value)}`).join(' ');
    return `<polygon points="${up} ${down}" fill="${palette_[index]}" fill-opacity="0.85"
      data-series="${escape(entry.label)}">
      <title>${escape(entry.label)}</title>
    </polygon>`;
  }).join('');

  return svg(`
    ${yAxis(marks, y, plot, report.unit, colors)}
    ${areas}
    ${xAxis(report.periods, x, height, colors)}`, height, options.label || 'Balance by category over time');
}

/** Columns, stacked: the same data as bars, which some questions are read better as. */
export function columns(report, colors, options = {}) {
  const height = 360;
  const plot = { left: PADDING.left, right: WIDTH - PADDING.right, top: PADDING.top, bottom: height - PADDING.bottom };
  const series = ordered(report, 7);
  const palette_ = palette(colors, series.length);
  const slot = (plot.right - plot.left) / report.periods.length;
  const bar = Math.max(Math.min(slot * 0.7, 54), 3);

  const bands = series.map((entry) => values(entry));
  const totals = report.periods.map((_, index) => sum(bands.map((band) => band[index])));
  const marks = ticks(Math.min(0, ...totals), Math.max(0, ...totals));
  const low = marks[0];
  const high = marks[marks.length - 1];
  const span = high - low || 1;
  const y = (value) => plot.bottom - ((value - low) / span) * (plot.bottom - plot.top);
  const centre = (index) => plot.left + slot * (index + 0.5);

  const stacked = report.periods.map((_, position) => {
    let running = 0;
    return series.map((entry, index) => {
      const value = bands[index][position];
      const top = y(running + value);
      const base = y(running);
      running += value;
      const height_ = Math.max(Math.abs(base - top), 0.5);
      return `<rect x="${centre(position) - bar / 2}" y="${Math.min(top, base)}" width="${bar}"
        height="${height_}" fill="${palette_[index]}" fill-opacity="0.9" data-series="${escape(entry.label)}"
        data-period="${escape(report.periods[position])}" data-value="${escape(format(entry.amounts[position]))}">
        <title>${escape(entry.label)} · ${escape(report.periods[position])}: ${escape(format(entry.amounts[position]))}</title>
      </rect>`;
    }).join('');
  }).join('');

  return svg(`
    ${yAxis(marks, y, plot, report.unit, colors)}
    ${stacked}
    ${xAxis(report.periods, centre, height, colors)}`, height, options.label || 'Balance by period');
}

/** Horizontal bars, largest first: how "where did it go" is read. */
export function ranking(report, colors, options = {}) {
  const rows = report.series
    .map((series) => ({ label: series.label, amount: seriesTotal(series) }))
    .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value));
  const height = rows.length * 28 + 24;
  const labelWidth = 250;
  const barWidth = WIDTH - labelWidth - 140;
  const largest = Math.max(...rows.map((row) => Math.abs(row.amount.value)), 0) || 1;
  const negatives = rows.some((row) => row.amount.value < 0);
  const zero = negatives ? labelWidth + barWidth / 2 : labelWidth;
  const total = sum(rows.map((row) => row.amount.value)) || 1;

  const bars = rows.map((row, index) => {
    const top = index * 28 + 8;
    const length = (Math.abs(row.amount.value) / largest) * (negatives ? barWidth / 2 : barWidth);
    const x = row.amount.value < 0 ? zero - length : zero;
    const label = row.label.length > 36 ? `${row.label.slice(0, 35)}…` : row.label;
    const share = `${(100 * row.amount.value / total).toFixed(1)}%`;
    return `<g data-series="${escape(row.label)}" style="cursor:pointer">
      <title>${escape(row.label)}: ${escape(format(row.amount))}</title>
      <rect x="${x}" y="${top}" width="${Math.max(length, 1)}" height="15" rx="2"
        fill="${colors.accent}" fill-opacity="${0.35 + 0.65 * (Math.abs(row.amount.value) / largest)}"/>
      <text x="${labelWidth - 12}" y="${top + 13}" text-anchor="end" font-size="12"
        fill="${colors.foreground}">${escape(label)}</text>
      <text x="${zero + barWidth / 2 + 12}" y="${top + 13}" font-size="12" fill="${colors.dim}">
        ${escape(format(row.amount))} · ${share}</text>
    </g>`;
  }).join('');

  const axis = negatives
    ? `<line x1="${zero}" y1="4" x2="${zero}" y2="${height - 8}" stroke="${colors.dim}" stroke-opacity="0.5"/>`
    : '';

  return svg(`${axis}${bars}`, height, options.label || 'Balance by account');
}

/** A donut: the share each series has of the total. */
export function donut(report, colors, options = {}) {
  const rows = report.series
    .map((series) => ({ label: series.label, amount: seriesTotal(series) }))
    .filter((row) => row.amount.value > 0)
    .sort((left, right) => right.amount.value - left.amount.value);
  const height = 380;
  const radius = 130;
  const inner = 78;
  const centre = { x: 210, y: height / 2 };
  const total = sum(rows.map((row) => row.amount.value)) || 1;
  const palette_ = palette(colors, rows.length);

  let angle = -Math.PI / 2;
  const arcs = rows.map((row, index) => {
    const sweep = (row.amount.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const point = (radius_, at) => `${(centre.x + Math.cos(at) * radius_).toFixed(2)},${(centre.y + Math.sin(at) * radius_).toFixed(2)}`;
    const path = `M ${point(radius, angle)} A ${radius} ${radius} 0 ${large} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, angle)} Z`;
    angle = end;
    return `<path d="${path}" fill="${palette_[index]}" stroke="${colors.background}" stroke-width="1.5"
      data-series="${escape(row.label)}" style="cursor:pointer">
      <title>${escape(row.label)}: ${escape(format(row.amount))} (${(100 * row.amount.value / total).toFixed(1)}%)</title>
    </path>`;
  }).join('');

  const legend = rows.map((row, index) => `
    <g transform="translate(420, ${58 + index * 24})" data-series="${escape(row.label)}" style="cursor:pointer">
      <rect width="11" height="11" rx="2" fill="${palette_[index]}"/>
      <text x="18" y="10" font-size="12" fill="${colors.foreground}">${escape(row.label.length > 30 ? `${row.label.slice(0, 29)}…` : row.label)}</text>
      <text x="330" y="10" font-size="12" text-anchor="end" fill="${colors.dim}">${escape(format(row.amount))} · ${(100 * row.amount.value / total).toFixed(1)}%</text>
    </g>`).join('');

  return svg(`${arcs}${legend}`, height, options.label || 'Share of the total');
}

/** Draw whichever type was asked for. */
export function draw(type, report, colors, options = {}) {
  switch (type) {
    case 'stacked': return stacked(report, colors, options);
    case 'columns': return columns(report, colors, options);
    case 'ranking': return ranking(report, colors, options);
    case 'donut': return donut(report, colors, options);
    default: return line(report, colors, options);
  }
}

/** The types that make sense for a report. */
export function typesFor(report) {
  const many = report.periods.length > 1;
  return TYPES.filter((type) => (type.needs === 'any' ? true : many));
}

// --------------------------------------------------------------------------- the page

/**
 * The whole document.
 *
 * The data travels in a JSON block and the controls call `mount`, so switching type or range
 * redraws from what is already here. Only a drill-down asks hledger again, through the plugin
 * on the other side of the window.
 */
export function page({ report, colors, title, command, range = 'all', type, token, options = {}, module }) {
  const chosen = type || (report.periods.length > 1 ? 'line' : 'ranking');
  // The page carries everything it needs to redraw: the data, the colours, the options, and
  // the token its bridge is filed under. `<` is escaped because a JSON block inside a
  // script element ends at the first `</script>`, and an account name could contain one.
  const data = JSON.stringify({ report, colors, token, options, command, range, type: chosen })
    .replace(/</g, '\\u003c');
  const buttons = typesFor(report)
    .map((entry) => `<button data-type="${entry.id}" class="tool">${entry.name}</button>`)
    .join('');
  const ranges = RANGES
    .filter((entry) => entry.periods >= Math.min(report.periods.length, 12))
    .map((entry) => `<button data-range="${entry.id}" class="tool">${entry.name}</button>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  :root { color-scheme: ${isLight(colors.background) ? 'light' : 'dark'}; }
  body { margin:0; background:${colors.background}; color:${colors.foreground};
    font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:960px; margin:0 auto; padding:24px 24px 40px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 2px; }
  .sub { color:${colors.dim}; margin:0 0 14px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px; align-items:center; }
  .tool { font:inherit; font-size:12px; padding:3px 10px; border-radius:999px; cursor:pointer;
    border:1px solid ${colors.dim}44; background:transparent; color:${colors.dim}; }
  .tool:hover { color:${colors.foreground}; border-color:${colors.dim}; }
  .tool[aria-pressed="true"] { background:${colors.accent}; border-color:${colors.accent};
    color:${isLight(colors.accent) ? '#1d2021' : '#ffffff'}; }
  .spacer { flex:1; }
  .legend { display:flex; flex-wrap:wrap; gap:10px; margin:10px 0 0; font-size:12px; }
  .legend button { border:0; background:transparent; color:${colors.foreground}; cursor:pointer;
    font:inherit; font-size:12px; display:flex; align-items:center; gap:6px; padding:0; }
  .legend span.dot { width:10px; height:10px; border-radius:2px; display:inline-block; }
  .legend button[aria-pressed="false"] { color:${colors.dim}; text-decoration:line-through; }
  details { margin-top:18px; }
  summary { cursor:pointer; color:${colors.dim}; }
  table { border-collapse:collapse; margin-top:8px; font-size:13px; width:100%; }
  th { font-weight:500; text-align:left; color:${colors.dim}; padding-bottom:4px; }
  th.n, td.n { text-align:right; font-variant-numeric:tabular-nums; }
  #tip { position:fixed; pointer-events:none; opacity:0; transition:opacity .08s;
    background:${colors.foreground}; color:${colors.background}; padding:4px 8px; border-radius:6px;
    font-size:12px; white-space:nowrap; z-index:10; }
  .note { color:${colors.dim}; margin:18px 0 0; font-size:12px; }
  code { color:${colors.foreground}; }
</style></head>
<body>
<main>
  <h1 id="heading">${escape(title)}</h1>
  <p class="sub" id="sub">${escape(headline(report, range))}</p>
  <div class="toolbar">
    <span id="types">${buttons}</span>
    <span class="spacer"></span>
    <span id="ranges">${ranges}</span>
  </div>
  <div id="chart">${draw(chosen, report, colors, options)}</div>
  <div class="legend" id="legend"></div>
  <details>
    <summary>The numbers</summary>
    <div id="table">${tableView(report)}</div>
  </details>
  <p class="note">from hledger's own numbers: <code id="command">${escape(command)}</code>
    <button class="tool" id="copy" style="margin-left:10px">Copy as CSV</button></p>
</main>
<div id="tip"></div>
<script type="application/json" id="chart-data">${data}</script>
<script type="module">import { mount } from ${JSON.stringify(module)}; mount();</script>
</body></html>`;
}

// --------------------------------------------------------------------------- the window

/**
 * Wire the page up. Only this function touches the DOM, which is why everything above can be
 * tested without a browser.
 */
export function mount(root = document) {
  const data = JSON.parse(root.getElementById('chart-data').textContent);
  const state = {
    report: data.report,
    colors: data.colors,
    options: data.options || {},
    command: data.command,
    range: data.range,
    type: data.type,
    hidden: new Set(),
  };
  const chart = root.getElementById('chart');
  const legend = root.getElementById('legend');
  const table = root.getElementById('table');
  const tip = root.getElementById('tip');
  const heading = root.getElementById('heading');
  const sub = root.getElementById('sub');
  const command = root.getElementById('command');

  /** Ask the plugin on the other side of this window for another report. */
  async function requery(args) {
    const bridges = window.opener && window.opener.__chartBridges;
    const bridge = bridges && bridges[data.token];
    if (!bridge) return null;
    try {
      return await bridge.requery(args);
    } catch (error) {
      sub.textContent = error && error.message ? error.message : String(error);
      return null;
    }
  }

  function visible(report) {
    return { ...report, series: report.series.filter((series) => !state.hidden.has(series.label)) };
  }

  function render() {
    const shown = windowed(visible(state.report), state.range);
    const options = state.options || {};
    chart.innerHTML = draw(state.type, shown, state.colors, options);
    sub.textContent = headline(shown, state.range);
    command.textContent = state.command;
    table.innerHTML = tableView(shown);
    legend.innerHTML = legendFor(state.report, state.colors, state.type, state.hidden);
    for (const button of chart.querySelectorAll('[data-series]')) {
      button.addEventListener('click', () => drill(button.dataset.series));
      button.addEventListener('mousemove', (event) => showTip(event));
      button.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    }
    for (const button of legend.querySelectorAll('[data-legend]')) {
      button.addEventListener('click', () => {
        const label = button.dataset.legend;
        if (state.hidden.has(label)) state.hidden.delete(label);
        else state.hidden.add(label);
        render();
      });
    }
    for (const button of root.querySelectorAll('[data-type]')) {
      button.setAttribute('aria-pressed', String(button.dataset.type === state.type));
    }
    for (const button of root.querySelectorAll('[data-range]')) {
      button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
    }
  }

  function showTip(event) {
    const target = event.currentTarget;
    const label = target.dataset.point || target.dataset.series || '';
    const period = target.dataset.period;
    const value = target.dataset.value;
    if (!value) return;
    tip.textContent = `${label}${period ? ` · ${period}` : ''}: ${value}`;
    tip.style.left = `${event.clientX + 14}px`;
    tip.style.top = `${event.clientY + 14}px`;
    tip.style.opacity = '1';
  }

  /** Clicking a series charts it on its own, which is the question behind the question. */
  async function drill(label) {
    if (!label || label.startsWith('other (')) return;
    sub.textContent = `Asking hledger about ${label}…`;
    const answer = await requery(label);
    if (!answer) return;
    state.history = [...(state.history || []), { report: state.report, command: state.command, title: heading.textContent }];
    Object.assign(state, { report: answer.report, command: answer.command, options: answer.options });
    heading.textContent = answer.title || label;
    state.hidden = new Set();
    document.title = `hledger: ${label}`;
    render();
  }

  async function back() {
    const previous = (state.history || []).pop();
    if (!previous) return;
    Object.assign(state, { report: previous.report, command: previous.command, options: {} });
    heading.textContent = previous.title;
    document.title = previous.title;
    render();
  }

  for (const button of root.querySelectorAll('[data-type]')) {
    button.addEventListener('click', () => { state.type = button.dataset.type; render(); });
  }
  for (const button of root.querySelectorAll('[data-range]')) {
    button.addEventListener('click', () => { state.range = button.dataset.range; render(); });
  }
  const copy = root.getElementById('copy');
  if (copy) {
    copy.addEventListener('click', async () => {
      const name = heading.textContent.split(',')[0];
      const csv = [['period', ...state.report.series.map((series) => series.label)].join(','),
        ...state.report.periods.map((period, index) => [period,
          ...state.report.series.map((series) => series.amounts[index].value)].join(','))].join('\n');
      try {
        await navigator.clipboard.writeText(csv);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = `${name}: copy failed`;
      }
      setTimeout(() => { copy.textContent = 'Copy as CSV'; }, 1500);
    });
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Backspace') back();
  });

  render();
}

/**
 * The legend: a colour and a name per series, for the types where a colour means a series.
 *
 * Empty for a ranking, whose bars are labelled where they are, and for a donut, which carries
 * its own list. A colour key that does not match the chart is worse than no key.
 */
export function legendFor(report, colors, type, hidden = new Set()) {
  if (!['line', 'stacked', 'columns'].includes(type)) return '';
  const drawn = ordered(report, 7);
  const palette_ = palette(colors, drawn.length);
  return drawn
    .map((series, index) => `<button data-legend="${escape(series.label)}" aria-pressed="${!hidden.has(series.label)}">
        <span class="dot" style="background:${palette_[index]}"></span>${escape(series.label)}
      </button>`)
    .join('');
}

/** The data as a table, which is sometimes what is wanted. */
export function tableView(report) {
  const head = report.periods.length > 1
    ? `<tr><th>Period</th><th class="n">Total</th></tr>`
    : `<tr><th>Account</th><th class="n">Balance</th></tr>`;
  const rows = report.periods.length > 1
    ? report.periods.map((period, index) => `<tr><td>${escape(period)}</td><td class="n">${escape(format(periodTotal(report, index)))}</td></tr>`).join('')
    : report.series
      .map((series) => `<tr><td>${escape(series.label)}</td><td class="n">${escape(format(seriesTotal(series)))}</td></tr>`)
      .join('');
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}
