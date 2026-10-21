/**
 * The chart window: one chart, and nothing else on the page.
 *
 * Every chart is drawn by D3, from the vendored UMD build the page loads as a classic script.
 * The balance charts (a line per series, a stacked area, a ranking, a doughnut) are built here
 * from hledger's balance CSV; the shaped charts (treemap, calendar, waterfall, sparklines,
 * Sankey) bring their own data from chart-d3.js.
 *
 * There are no buttons, no fields and no disclosures. What is drawn comes from the command that
 * was run; everything you can do is done to the chart itself, which is what a chart is for:
 * hover or Tab to a mark for its numbers, click a legend entry to hide a series, scroll to zoom
 * and drag to pan through time, double-click to reset, click or Enter on a mark to chart that
 * account on its own, and Escape to go back. The keys are listed under the chart.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window; the window
 * imports `mount` to draw it. Everything that decides what a chart shows is a plain function
 * from data to a model — `modelFor`, `viewOf` — which is why it can be tested without a
 * browser, and only `mount` touches the DOM.
 *
 * The balance data is one row per series and one column per period, which is what hledger's
 * balance CSV is:
 *
 *   { periods: ['2024-01', '2024-02'],
 *     series: [{ label: 'expenses:rent', amounts: [{value, prefix, suffix}, ...] }],
 *     unit: { prefix: '$', suffix: '' } }
 */

import { format, isLight, ordered, palette, percent, periodTotal, seriesTotal } from './chart-data.js';
import { headlineFor, heightFor, isCustom, render, tableFor } from './chart-d3.js';
import { KEYS, keyFor, legend, save, tooltip } from './chart-ui.js';

// The formatter, the palette and the series arithmetic are defined once in chart-data.js, so
// the plugin, this window and the drawing cannot drift apart. Re-exported here because this is
// where the window's own helpers are read, by tests and by callers.
export { format, group, isLight, ordered, palette, periodTotal, seriesTotal } from './chart-data.js';

// --------------------------------------------------------------------------- the report

/**
 * Which chart a balance report asks for.
 *
 * The window has no controls, so the shape of the data decides: several periods is a line (or
 * a stacked area, when that was asked for), one column is a ranking, and a preset that is about
 * shares is a doughnut.
 */
export function typeFor(report, kind) {
  if (kind === 'shares') return 'doughnut';
  if (report.periods.length <= 1) return 'bar';
  return kind === 'stacked' ? 'stacked' : 'line';
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

/**
 * What a balance chart shows, without a library in sight.
 *
 * One function, four shapes. A line or stacked area gets the series worth drawing, largest
 * first, with the rest folded into "other (n)"; `options.total` collapses a running total such
 * as net worth into one filled line. A ranking gets one row per account, largest first; a
 * doughnut gets the positive ones only, since a share of a negative is not a slice. Every row
 * carries its colour and its share, so the renderer only has to draw.
 *
 * `drillable` says whether clicking a mark should chart that account on its own. A running
 * total is not an account, so it is the one thing that is not.
 */
export function modelFor({ report, colors, title, kind, options = {} }) {
  const type = typeFor(report, kind);
  const unit = report.unit || { prefix: '', suffix: '' };

  if (type === 'bar' || type === 'doughnut') {
    let rows = report.series.map((series) => ({ label: series.label, value: seriesTotal(series).value }));
    rows = type === 'doughnut'
      ? rows.filter((row) => row.value > 0).sort((left, right) => right.value - left.value)
      : rows.sort((left, right) => Math.abs(right.value) - Math.abs(left.value));
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const colours = type === 'doughnut' ? palette(colors, rows.length) : rows.map(() => colors.accent);
    return {
      type,
      title,
      unit,
      drillable: true,
      total,
      rows: rows.map((row, index) => ({
        ...row,
        colour: colours[index],
        share: total ? row.value / total : 0,
        shareText: percent(row.value, total),
      })),
    };
  }

  const series = options.total
    ? [{ label: options.label || title, amounts: report.periods.map((_, index) => periodTotal(report, index)) }]
    : ordered(report, type === 'stacked' ? 8 : 7);
  const colours = palette(colors, series.length);
  return {
    type,
    title,
    unit,
    drillable: !options.total,
    periods: report.periods,
    fill: type === 'line' && series.length === 1,
    series: series.map((entry, index) => ({
      label: entry.label,
      values: entry.amounts.map((amount) => (amount ? amount.value : 0)),
      colour: colours[index],
      other: Boolean(entry.other),
    })),
  };
}

/**
 * The account a hit on a mark stands for, or null.
 *
 * A hit names a series (`{ series: i }`, for lines and areas) or a row (`{ row: i }`, for bars
 * and slices). `other (n)` is a sum of several accounts and is not something to drill into, and
 * nothing is, in a chart that is not drillable.
 */
export function accountAt(model, hit) {
  if (!model || !hit || !model.drillable) return null;
  const entry = hit.series !== undefined ? (model.series || [])[hit.series] : (model.rows || [])[hit.row];
  if (!entry || entry.other || String(entry.label).startsWith('other (')) return null;
  return String(entry.label);
}

/** A line of tooltip for a point: "rent: $1,286.40". */
export function pointText(label, value, unit) {
  return `${label}: ${format({ value, ...unit })}`;
}

/** A line of tooltip for a share: "$1,200.00 (90.8%)". */
export function shareText(value, total, unit) {
  return `${format({ value, ...unit })} (${percent(value, total)})`;
}

/**
 * Everything the window shows for a state, decided in one place: which renderer, with what
 * data, which legend, and the words and table around it. Both the first page and every redraw
 * after a drill-down come from here.
 */
export function viewOf(state) {
  if (isCustom(state.kind)) {
    return {
      draw: state.kind,
      data: state.report,
      items: null,
      sub: headlineFor(state.kind, state.report),
      table: tableFor(state.kind, state.report),
      height: heightFor(state.kind, state.report),
    };
  }
  const model = modelFor(state);
  const items = model.series
    ? model.series.map((series) => ({ label: series.label, colour: series.colour }))
    : model.type === 'doughnut'
      ? model.rows.map((row) => ({ label: row.label, colour: row.colour }))
      : null;
  return {
    draw: model.type,
    data: model,
    items,
    sub: headline(state.report, model.type),
    table: tableView(state.report),
    height: heightFor(model.type, model),
  };
}

// --------------------------------------------------------------------------- the page

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

/** The keys, as the window's footer says them. */
export function keysLine() {
  return KEYS.map(([key, action]) => `${key} ${action}`).join(' · ');
}

/**
 * The whole document.
 *
 * The data travels in a JSON block, D3 arrives as a classic script from beside this plugin,
 * and the chart is drawn by `mount`. The table is rendered here rather than by script: an svg
 * of shapes says little to a screen reader, and a window that shows nothing until a script runs
 * shows nothing if the script does not.
 */
export function page({ report, colors, title, command, token, kind, options = {}, module, scripts = [] }) {
  const view = viewOf({ report, colors, title, kind, options });
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
  .sub { color:${colors.dim}; margin:0 0 14px; }
  .frame { position:relative; height:${view.height}px; }
  svg.chart { display:block; width:100%; height:100%; overflow:visible; }
  svg.chart :focus { outline:none; }
  .legend { display:flex; flex-wrap:wrap; gap:4px 16px; list-style:none; margin:0 0 12px; padding:0; font-size:12px; }
  .legend li { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; border-radius:3px; }
  .legend li:focus-visible { outline:2px solid ${colors.foreground}; outline-offset:2px; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:50%; }
  table { border-collapse:collapse; margin-top:22px; font-size:13px; width:100%; }
  th { font-weight:500; text-align:left; color:${colors.dim}; padding-bottom:4px; }
  th.n, td.n { text-align:right; font-variant-numeric:tabular-nums; }
  td { padding:1px 0; }
  .note, .keys { color:${colors.dim}; margin:18px 0 0; font-size:12px; }
  .keys { margin-top:4px; }
  .warn { color:${colors.foreground}; margin:0 0 12px; font-size:13px; }
  code { color:${colors.foreground}; }
</style></head>
<body>
<main>
  <h1 id="heading">${escape(title)}</h1>
  <p class="sub" id="sub">${escape(view.sub)}</p>
  <p class="warn" id="warn" hidden></p>
  <div id="legend" hidden></div>
  <div class="frame"><svg class="chart" id="chart" role="img" aria-label="${escape(title)}"></svg></div>
  <div id="table">${view.table}</div>
  <p class="note">from hledger's own numbers: <code id="command">${escape(command)}</code></p>
  <p class="keys">${escape(keysLine())}</p>
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
 * Draw the chart, and let the pointer and the keyboard ask for another one.
 *
 * Only this function touches the DOM. D3 arrives in the page's own script tag, so if it did not
 * load this leaves the table standing and says so, rather than showing an empty frame.
 *
 * The window keeps what it is showing and what it has shown. Undoing a drill-down needs no
 * hledger round trip, because the report it came from is still here, and neither does
 * restoring which series were hidden and how far the chart was zoomed.
 */
export function mount(root = document) {
  const data = JSON.parse(root.getElementById('chart-data').textContent);
  const svg = root.getElementById('chart');
  const holder = svg.parentElement;
  const warn = root.getElementById('warn');
  const table = root.getElementById('table');
  const heading = root.getElementById('heading');
  const sub = root.getElementById('sub');
  const command = root.getElementById('command');
  const legendBox = root.getElementById('legend');

  if (!window.d3) {
    show(warn, 'The chart library did not load, so this is the numbers alone.');
    return;
  }

  const state = { ...data };
  const stack = [];
  const tip = tooltip(holder, data.colors);
  let view = { hidden: new Set() };
  let controls = {};
  let busy = false;

  const hooks = {
    tip,
    async pick(account) {
      if (busy) return;
      busy = true;
      tip.hide();
      show(warn, `Reading ${account}…`);
      const answer = await requery(data.token, account);
      busy = false;
      if (!answer) return;
      stack.push({ state: { ...state }, view });
      Object.assign(state, answer, { options: answer.options || {} });
      view = { hidden: new Set() };
      draw();
    },
  };

  function paint() {
    const shown = viewOf(state);
    try {
      controls = render(shown.draw, svg, shown.data, state.colors, hooks, view) || {};
      show(warn, '');
    } catch (error) {
      controls = {};
      show(warn, error && error.message ? error.message : String(error));
    }
  }

  function drawLegend(items) {
    legend(legendBox, items, view.hidden, (label) => {
      if (view.hidden.has(label)) view.hidden.delete(label);
      else view.hidden.add(label);
      drawLegend(items);
      paint();
      // Keep the keyboard where it was, on the entry just toggled.
      const entry = [...legendBox.querySelectorAll('li')].find((item) => item.textContent === label);
      if (entry) entry.focus();
    }, state.colors);
  }

  function draw() {
    const shown = viewOf(state);
    heading.textContent = state.title;
    document.title = `hledger: ${state.title}`;
    sub.textContent = shown.sub;
    command.textContent = state.command;
    table.innerHTML = shown.table;
    holder.style.height = `${shown.height}px`;
    svg.setAttribute('aria-label', state.title);
    drawLegend(shown.items);
    paint();
  }

  window.addEventListener('keydown', (event) => {
    const action = keyFor(event);
    if (!action) return;
    // A key typed into something editable is not a command, should the page ever have one.
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    event.preventDefault();
    if (action === 'back') {
      // Escape undoes the last drill-down. A key rather than a button, because the window has
      // no buttons, and a drill-down that could not be undone would be a dead end.
      const previous = stack.pop();
      if (!previous) return;
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, previous.state);
      view = previous.view;
      draw();
      return;
    }
    if (action === 'previous' && controls.step) controls.step(-1);
    if (action === 'next' && controls.step) controls.step(1);
    if (action === 'zoom-in' && controls.zoomBy) controls.zoomBy(1.6);
    if (action === 'zoom-out' && controls.zoomBy) controls.zoomBy(1 / 1.6);
    if (action === 'reset' && controls.reset) controls.reset();
    if (action === 'save-svg' || action === 'save-png') {
      // The picture says what the page around it said: the subtitle, and the legend for
      // what is still shown.
      const shown = viewOf(state);
      const items = (shown.items || []).filter((item) => !view.hidden.has(item.label));
      save(svg, state.colors, state.title, action === 'save-svg' ? 'svg' : 'png', { subtitle: shown.sub, items })
        .catch((error) => show(warn, error && error.message ? error.message : String(error)));
    }
  });

  // A new size is a new layout, so the chart is redrawn rather than stretched.
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(paint, 120);
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
