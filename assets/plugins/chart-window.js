/**
 * The chart window: one chart, drawn by Chart.js, and nothing else on the page.
 *
 * There are no buttons, no fields and no disclosures. What is drawn comes from the command that
 * was run; everything you can do is done to the chart itself, which is what a chart is for:
 * hover for values, click the legend to hide a series, scroll to zoom, drag to pan,
 * double-click to reset, and click a point to chart that account on its own.
 *
 * Shared by both sides of the plugin. The plugin imports the page to write the window; the
 * window imports `mount` to draw it and to handle clicks. Everything that decides what a chart
 * looks like is a plain function from data to a config object, which is why it can be tested
 * without a browser, and only `mount` touches the DOM.
 *
 * The data shape is one row per series and one column per period, which is what hledger's
 * balance CSV is:
 *
 *   { periods: ['2024-01', '2024-02'],
 *     series: [{ label: 'expenses:rent', amounts: [{value, prefix, suffix}, ...] }],
 *     unit: { prefix: '$', suffix: '' } }
 */

/** Grid lines and axis labels, dimmed. A theme colour is `#rrggbb`, so an alpha is appended. */
const GRID_ALPHA = '3d';

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

/** The series worth drawing, largest first, with the rest added up as "other". */
export function ordered(report, limit = 7) {
  const ranked = report.series
    .map((series) => ({ ...series, sum: seriesTotal(series).value }))
    .sort((left, right) => Math.abs(right.sum) - Math.abs(left.sum));
  if (ranked.length <= limit) return ranked;
  const shown = ranked.slice(0, limit - 1);
  const rest = ranked.slice(limit - 1);
  return [
    ...shown,
    {
      label: `other (${rest.length})`,
      amounts: report.periods.map((_, index) => add(rest.map((series) => series.amounts[index]))),
      other: true,
    },
  ];
}

/** The total of every series in a period. */
export function periodTotal(report, index) {
  return add(report.series.map((series) => series.amounts[index]));
}

/** The total of one series across every period. */
export function seriesTotal(series) {
  return add(series.amounts);
}

function add(amounts) {
  const present = amounts.filter(Boolean);
  const sum = present.reduce((total, amount) => total + (Number.isFinite(amount.value) ? amount.value : 0), 0);
  return {
    value: sum,
    prefix: (present.find((amount) => amount.prefix) || {}).prefix || '',
    suffix: (present.find((amount) => amount.suffix) || {}).suffix || '',
  };
}

/** The colours the series are drawn in, worked out from the theme's accent. */
export function palette(colors, count) {
  const [hue, saturation] = toHsl(colors.accent);
  const light = isLight(colors.background);
  return Array.from({ length: Math.max(count, 1) }, (_, index) => {
    // Spread around the wheel, keeping the theme's own saturation and the lightness that reads
    // on its background, so the series belong to the theme rather than to a palette invented
    // here.
    const shifted = (hue + index * (index % 2 ? 137 : 47)) % 360;
    return `hsl(${shifted.toFixed(0)} ${Math.max(saturation, 35)}% ${light ? 38 : 62}%)`;
  });
}

/** Whether a CSS colour is light, near enough, for choosing readable series colours. */
export function isLight(css) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (299 * r + 587 * g + 114 * b) / 1000 >= 128;
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

// --------------------------------------------------------------------------- the report

/**
 * Which chart this report asks for.
 *
 * The window has no controls, so the shape of the data decides: several periods is a line,
 * a report with one column is a ranking, and a preset that is about shares is a doughnut.
 */
export function typeFor(report, kind) {
  if (kind === 'shares') return 'doughnut';
  return report.periods.length > 1 ? 'line' : 'bar';
}

/** What the page says under the heading. */
export function headline(report, type) {
  if (report.periods.length <= 1) {
    const positives = report.series.filter((series) => seriesTotal(series).value > 0).length;
    const dropped = type === 'doughnut' ? report.series.length - positives : 0;
    return `${report.series.length} accounts, ${report.periods[0] || 'one period'}${
      dropped > 0 ? `, ${dropped} with nothing to show` : ''}`;
  }
  const first = report.periods[0];
  const last = report.periods[report.periods.length - 1];
  return `${report.periods.length} periods, ${first} to ${last}`;
}

// --------------------------------------------------------------------------- the library

/**
 * The theme, as Chart.js options.
 *
 * One place maps the app's colours onto the library, so a theme change is one function to read
 * rather than a dozen scattered colours.
 */
export function themeFor(colors) {
  const grid = { color: `${colors.dim}${GRID_ALPHA}`, drawTicks: false };
  const ticks = { color: colors.dim, maxRotation: 0, autoSkipPadding: 12 };
  return {
    color: colors.foreground,
    maintainAspectRatio: false,
    animation: { duration: 220 },
    plugins: {
      legend: {
        labels: { color: colors.foreground, boxWidth: 10, boxHeight: 10, usePointStyle: true },
      },
      tooltip: {
        backgroundColor: colors.foreground,
        titleColor: colors.background,
        bodyColor: colors.background,
        borderColor: colors.dim,
        borderWidth: 1,
        padding: 8,
        displayColors: false,
      },
      zoom: {
        // Wheel to zoom, drag to pan, both along the axis that means time. Double-click resets.
        zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
        pan: { enabled: true, mode: 'x' },
      },
    },
    scales: {
      x: { grid, ticks, border: { color: `${colors.dim}${GRID_ALPHA}` } },
      y: { grid, ticks, border: { display: false } },
    },
  };
}

/**
 * The Chart.js config for a report.
 *
 * One function, three shapes: a line per series over time, horizontal bars for a ranking, and a
 * doughnut for shares. `options.total` collapses a running total such as net worth into one line.
 */
export function configFor({ report, colors, title, kind, options = {} }) {
  const type = typeFor(report, kind);
  const unit = report.unit || { prefix: '', suffix: '' };
  const theme = themeFor(colors);
  const amount = (value) => format({ value, ...unit });

  if (type === 'doughnut') {
    const rows = report.series
      .map((series) => ({ label: series.label, amount: seriesTotal(series) }))
      .filter((row) => row.amount.value > 0)
      .sort((left, right) => right.amount.value - left.amount.value);
    const total = rows.reduce((sum, row) => sum + row.amount.value, 0) || 1;
    return {
      type: 'doughnut',
      data: {
        labels: rows.map((row) => row.label),
        datasets: [{
          label: title,
          data: rows.map((row) => row.amount.value),
          backgroundColor: palette(colors, rows.length),
          borderColor: colors.background,
          borderWidth: 2,
        }],
      },
      options: {
        ...theme,
        cutout: '58%',
        scales: {},
        plugins: {
          ...theme.plugins,
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (item) => ` ${amount(item.parsed)} (${((100 * item.parsed) / total).toFixed(1)}%)`,
            },
          },
        },
      },
    };
  }

  if (type === 'bar') {
    const rows = report.series
      .map((series) => ({ label: series.label, amount: seriesTotal(series) }))
      .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value));
    const total = rows.reduce((sum, row) => sum + row.amount.value, 0) || 1;
    return {
      type: 'bar',
      data: {
        labels: rows.map((row) => row.label),
        datasets: [{
          label: title,
          data: rows.map((row) => row.amount.value),
          backgroundColor: colors.accent,
          borderColor: colors.accent,
          borderWidth: 0,
        }],
      },
      options: {
        ...theme,
        indexAxis: 'y',
        plugins: {
          ...theme.plugins,
          legend: { display: false },
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (item) => ` ${amount(item.parsed.x)} (${((100 * item.parsed.x) / total).toFixed(1)}%)`,
            },
          },
        },
      },
    };
  }

  const series = options.total
    ? [{ label: options.label || title, amounts: report.periods.map((_, index) => periodTotal(report, index)) }]
    : ordered(report, 7);
  const colors_ = palette(colors, series.length);
  return {
    type: 'line',
    data: {
      labels: report.periods,
      datasets: series.map((entry, index) => ({
        label: entry.label,
        data: entry.amounts.map((value) => value.value),
        borderColor: colors_[index],
        backgroundColor: series.length === 1 ? `${colors_[index]}2e` : colors_[index],
        fill: series.length === 1,
        tension: 0.25,
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
      })),
    },
    options: {
      ...theme,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        ...theme.plugins,
        tooltip: {
          ...theme.plugins.tooltip,
          callbacks: { label: (item) => ` ${item.dataset.label}: ${amount(item.parsed.y)}` },
        },
      },
    },
  };
}

/**
 * The account a click landed on, or null.
 *
 * A bar or a doughnut names an account per element; a line names one per dataset, so clicking a
 * point on a line means "chart this series". `other (n)` is a sum of several accounts and is not
 * something to drill into.
 */
export function accountAt(config, element) {
  if (!config || !element) return null;
  const datasets = config.data.datasets;
  const dataset = datasets[element.datasetIndex];
  if (!dataset) return null;
  const single = datasets.length === 1 && config.type !== 'line';
  const label = single ? config.data.labels[element.index] : dataset.label;
  if (!label || String(label).startsWith('other (')) return null;
  return String(label);
}

// --------------------------------------------------------------------------- the page

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

/**
 * The whole document.
 *
 * The data travels in a JSON block, the library arrives as classic scripts from beside this
 * plugin, and the chart is drawn by `mount`. The table is rendered here rather than by script:
 * a canvas says nothing to a screen reader, and a window that shows nothing until a script runs
 * shows nothing if the script does not.
 */
export function page({ report, colors, title, command, token, kind, options = {}, module, scripts = [] }) {
  const type = typeFor(report, kind);
  const data = JSON.stringify({ report, colors, token, kind, options, title, command })
    .replace(/</g, '\\u003c');
  const dark = !isLight(colors.background);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  body { margin:0; background:${colors.background}; color:${colors.foreground};
    font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:960px; margin:0 auto; padding:24px 24px 40px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 2px; }
  .sub { color:${colors.dim}; margin:0 0 16px; }
  .frame { position:relative; height:${type === 'doughnut' ? '380px' : '400px'}; }
  canvas { cursor:pointer; }
  table { border-collapse:collapse; margin-top:22px; font-size:13px; width:100%; }
  th { font-weight:500; text-align:left; color:${colors.dim}; padding-bottom:4px; }
  th.n, td.n { text-align:right; font-variant-numeric:tabular-nums; }
  td { padding:1px 0; }
  .note { color:${colors.dim}; margin:18px 0 0; font-size:12px; }
  .warn { color:${colors.foreground}; margin:0 0 12px; font-size:13px; }
  code { color:${colors.foreground}; }
</style></head>
<body>
<main>
  <h1 id="heading">${escape(title)}</h1>
  <p class="sub" id="sub">${escape(headline(report, type))}</p>
  <p class="warn" id="warn" hidden></p>
  <div class="frame"><canvas id="chart" role="img" aria-label="${escape(title)}"></canvas></div>
  <div id="table">${tableView(report)}</div>
  <p class="note">from hledger's own numbers: <code id="command">${escape(command)}</code></p>
</main>
<script type="application/json" id="chart-data">${data}</script>
${scripts.map((src) => `<script src="${escape(src)}"></script>`).join('\n')}
<script type="module">import { mount } from ${JSON.stringify(module)}; mount();</script>
</body></html>`;
}

/** The data as a table, which is also the accessible rendering of the chart. */
export function tableView(report) {
  const many = report.periods.length > 1;
  const head = many
    ? '<tr><th>Period</th><th class="n">Total</th></tr>'
    : '<tr><th>Account</th><th class="n">Balance</th></tr>';
  const rows = many
    ? report.periods
      .map((period, index) => `<tr><td>${escape(period)}</td><td class="n">${escape(format(periodTotal(report, index)))}</td></tr>`)
      .join('')
    : report.series
      .map((series) => `<tr><td>${escape(series.label)}</td><td class="n">${escape(format(seriesTotal(series)))}</td></tr>`)
      .join('');
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

// --------------------------------------------------------------------------- the window

/**
 * Draw the chart, and let a click ask for another one.
 *
 * Only this function touches the DOM. The library arrives in the page's own script tags, so if it
 * did not load this leaves the table standing and says so, rather than showing an empty canvas.
 *
 * The window keeps what it is showing and what it has shown. Undoing a drill-down needs no
 * hledger round trip, because the report it came from is still here.
 */
export function mount(root = document) {
  const data = JSON.parse(root.getElementById('chart-data').textContent);
  const canvas = root.getElementById('chart');
  const warn = root.getElementById('warn');
  const table = root.getElementById('table');
  const heading = root.getElementById('heading');
  const sub = root.getElementById('sub');
  const command = root.getElementById('command');

  if (typeof window.Chart !== 'function') {
    show(warn, 'The chart library did not load, so this is the numbers alone.');
    return;
  }

  const state = { ...data };
  const stack = [];
  let chart = null;

  function draw() {
    if (chart) chart.destroy();
    chart = new window.Chart(canvas, configFor(state));
    heading.textContent = state.title;
    document.title = `hledger: ${state.title}`;
    sub.textContent = headline(state.report, typeFor(state.report, state.kind));
    command.textContent = state.command;
    table.innerHTML = tableView(state.report);
    show(warn, '');
  }

  canvas.addEventListener('click', async (event) => {
    const [element] = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, true);
    const account = accountAt(chart.config, element);
    if (!account) return;
    const answer = await requery(data.token, account);
    if (!answer) return;
    stack.push({ ...state });
    Object.assign(state, answer, { options: answer.options || {} });
    draw();
  });

  // Escape undoes the last click. A key rather than a button, because the window has no
  // buttons, and a drill-down that could not be undone would be a dead end.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const previous = stack.pop();
    if (!previous) return;
    Object.assign(state, previous);
    draw();
  });

  draw();
}

function show(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

/** Ask the plugin on the other side of this window to chart an account on its own. */
async function requery(token, account) {
  const bridges = window.opener && window.opener.__chartBridges;
  const bridge = bridges && bridges[token];
  if (!bridge) {
    show(document.getElementById('warn'), 'This window has lost touch with the app. Run the command again.');
    return null;
  }
  try {
    return await bridge.requery(account);
  } catch (error) {
    show(document.getElementById('warn'), error && error.message ? error.message : String(error));
    return null;
  }
}
