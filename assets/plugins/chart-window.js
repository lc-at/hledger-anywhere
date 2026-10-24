/**
 * The chart window: one chart, and nothing else on the page.
 *
 * Every chart is drawn by D3, from the vendored UMD build the page loads as a classic script.
 * The balance charts (a line per series, a stacked area, a ranking, a doughnut) are built here
 * from hledger's balance CSV; the shaped charts (treemap, calendar, waterfall, sparklines,
 * Sankey) bring their own data from chart-d3.js.
 *
 * There are no buttons, no fields and no disclosures. What is drawn comes from the command that
 * was run, and under it a line of related charts, each a link that says its own command;
 * everything else you can do is done to the chart itself, which is what a chart is for:
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

import { chosen, chosenSeries, counted, format, leftOut, palette, percent, periodTotal, seriesTotal, shape, trimmed } from './chart-data.js';
import { escape, isLight } from './window-kit.js';
import { foldFlows, headlineFor, heightFor, isCustom, multiples, render, tableFor } from './chart-d3.js';
import { MORE, renderMore } from './chart-more.js';
import { player, timeline } from './chart-play.js';
import { ANIMATED, drill, parse } from './chart-args.js';
import { KEYS, keyFor, legend, save, tooltip } from './chart-ui.js';

// --------------------------------------------------------------------------- the report

/**
 * Which picture a balance report gets, from the type asked for and the shape of the report.
 *
 * A bar chart of one period ranks the accounts; of several it is columns per period. A line or
 * a stacked area of a single period would be one point, so it is drawn as the ranking. A pie
 * is a doughnut. A report with no type, as an older window might carry, is a line when it has
 * periods and a ranking when it does not.
 */
export function typeFor(report, kind) {
  const many = report.periods.length > 1;
  if (kind === 'pie') return 'doughnut';
  if (kind === 'bar') return many ? 'columns' : 'bar';
  if (!many) return 'bar';
  return ['stacked', 'stream', 'heatmap', 'bump'].includes(kind) ? kind : 'line';
}

/** What the page says under the heading. */
export function headline(report, type) {
  if (report.periods.length <= 1) {
    const positives = report.series.filter((series) => seriesTotal(series).value > 0).length;
    const dropped = type === 'doughnut' ? report.series.length - positives : 0;
    return `${counted(report.series.length, 'account')}, ${report.periods[0] || 'one period'}${
      dropped > 0 ? `, ${dropped} with nothing to show` : ''}`;
  }
  const first = report.periods[0];
  const last = report.periods[report.periods.length - 1];
  const dropped = report.dropped ? `; ${counted(report.dropped, 'empty period')} at the ends not drawn` : '';
  return `${report.periods.length} periods, ${first} to ${last}${dropped}`;
}

/**
 * What a balance chart shows, without a library in sight.
 *
 * The report is shaped by the chart options first (`shape`: inverted, accumulated, as
 * percentages), then the entries worth drawing are chosen (`chosen`: largest first, `--top N`
 * of them, `--sort name` if asked). A ranking and a doughnut get one row per account, a
 * doughnut only the positive ones, since a share of a negative is not a slice; lines, areas and
 * columns get one series per account. Every entry carries its colour and its share, and
 * `log` says whether the value axis is logarithmic, so the renderer only has to draw.
 */
export function modelFor({ report, colors, title, kind, options = {} }) {
  const type = typeFor(report, kind);
  const shaped = shape(report, options);
  const unit = shaped.unit;
  const log = Boolean(options.log);

  if (type === 'bar' || type === 'doughnut') {
    let rows = shaped.series.map((series) => ({ label: series.label, value: seriesTotal(series).value }));
    if (type === 'doughnut') rows = rows.filter((row) => row.value > 0);
    rows = chosen(rows, {
      top: options.top,
      sort: options.sort,
      size: (row) => row.value,
      combine: (rest) => ({ label: `other (${rest.length})`, value: rest.reduce((sum, row) => sum + row.value, 0), other: true }),
    });
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const colours = type === 'doughnut' ? palette(colors, rows.length) : rows.map((row) => (row.other ? colors.dim : colors.accent));
    return {
      type,
      title,
      unit,
      log,
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

  // A heatmap has a row per account and room for many; a stream or a stack has a band each.
  const fits = { heatmap: 24, stacked: 8, stream: 10, bump: 8 }[type] || 7;
  const series = chosenSeries(shaped, options, fits);
  const colours = palette(colors, series.length);
  return {
    type,
    title,
    unit,
    log,
    drillable: true,
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
 * Everything the window shows for a state, decided in one place: which renderer, with what
 * data, which legend, and the words and table around it. Both the first page and every redraw
 * after a drill-down come from here.
 */
export function viewOf(original) {
  // Balance reports are drawn without empty periods at either end; the table under the chart
  // and the subtitle say how many there were, so nothing disappears without a word.
  const state = original.report && original.report.periods && original.report.series
    ? { ...original, report: trimmed(original.report) }
    : original;
  const options = state.options || {};
  // Commodities the report held besides the one drawn are named under the subtitle.
  const mixed = leftOut(state.report.others, state.report.unit, state.command || '');
  if (options.animate && ANIMATED.includes(state.kind) && state.report && state.report.periods && state.report.periods.length > 1) {
    const play = timeline(state.kind, state.report, options, state.colors);
    const first = play.words(0);
    return {
      draw: 'animate', play, items: null,
      mixed: play.others ? leftOut(play.others, state.report.unit, state.command || '') : mixed,
      sub: `${counted(play.periods.length, 'period')}, ${play.periods[0]} to ${play.periods[play.periods.length - 1]}; ${first.sub}`,
      table: first.table,
      height: play.height || heightFor(state.kind === 'pie' ? 'doughnut' : state.kind === 'sunburst' ? 'sunburst' : 'treemap', {}),
    };
  }
  if (state.kind === 'multiples') {
    // Sparklines are a balance chart drawn small: shaped and chosen the same way.
    const data = multiples(shape(state.report, options), options.top || 8);
    if (options.sort === 'name') data.rows.sort((left, right) => left.label.localeCompare(right.label));
    data.log = Boolean(options.log);
    return {
      draw: 'multiples', data, items: null,
      sub: headlineFor('multiples', data), table: tableFor('multiples', data), height: heightFor('multiples', data), mixed,
    };
  }
  if (isCustom(state.kind)) {
    // A Sankey of every category is a fringe of hairlines: twelve is as many as stay readable,
    // and --top asks for fewer or more.
    const data = state.kind === 'sankey' ? foldFlows(state.report, options.top || 12) : state.report;
    return {
      draw: state.kind,
      data,
      items: null,
      // Said of everything the report held, not of what fit: a folded "other (9)" is nine.
      sub: headlineFor(state.kind, state.report),
      table: tableFor(state.kind, data),
      height: heightFor(state.kind, data),
      mixed,
    };
  }
  const model = modelFor(state);
  // The heatmap and the bump chart name their accounts where they are drawn, so need no legend.
  const items = model.series && !['heatmap', 'bump'].includes(model.type)
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
    mixed,
  };
}

// --------------------------------------------------------------------------- the page

/** The keys, as the window's footer says them. */
export function keysLine(animated = false) {
  const keys = animated ? [['Space', 'play, pause'], ...KEYS.map(([key, action]) => (key === '← →' ? [key, 'step a period'] : [key, action]))] : KEYS;
  return keys.map(([key, action]) => `${key} ${action}`).join(' · ');
}

/**
 * The whole document.
 *
 * The data travels in a JSON block, D3 arrives as a classic script from beside this plugin,
 * and the chart is drawn by `mount`. The table is rendered here rather than by script: an svg
 * of shapes says little to a screen reader, and a window that shows nothing until a script runs
 * shows nothing if the script does not.
 */
/**
 * The charts worth trying next, as links that say the command each one is.
 *
 * A link rather than a button: following one is a drill-down like clicking a mark, so Escape
 * comes back, and reading one shows how to ask for that chart in the terminal next time.
 */
export function alsoLine(related = []) {
  if (!related.length) return '';
  return `Also: ${related
    .map((entry) => `<a href="#" data-args="${escape(entry.args)}">${escape(entry.label)}</a>`)
    .join(' · ')}`;
}

export function page({ report, colors, title, command, token, kind, options = {}, args = '', related = [], module, scripts = [] }) {
  const view = viewOf({ report, colors, title, kind, options });
  const data = JSON.stringify({ report, colors, token, kind, options, title, command, args, related })
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
  .also { color:${colors.dim}; margin:8px 0 10px; font-size:12px; }
  .also { line-height:1.9; }
  /* A link is a command, so it is never broken across lines in the middle of an option. */
  .also a { color:${colors.foreground}; text-decoration:underline; text-decoration-color:${colors.dim};
    text-underline-offset:2px; white-space:nowrap; }
  .also a:focus-visible { outline:2px solid ${colors.foreground}; outline-offset:2px; border-radius:2px; }
  .keys { margin-top:4px; }
  .warn { color:${colors.foreground}; margin:0 0 12px; font-size:13px; }
  .mixed { color:${colors.foreground}; margin:-8px 0 12px; font-size:12px; border-left:2px solid ${colors.accent}; padding-left:8px; }
  code { color:${colors.foreground}; }
  .period { position:absolute; top:2px; right:6px; font-size:30px; font-weight:600; color:${colors.foreground};
    opacity:.4; pointer-events:none; font-variant-numeric:tabular-nums; }
  .period.bottom { top:auto; bottom:30px; right:14px; }
  .timeline { position:relative; margin:10px 0 4px; padding:6px 0 0; cursor:pointer; user-select:none; }
  .timeline .track { position:relative; height:4px; border-radius:2px; background:${colors.dim}44; }
  .timeline .done { height:100%; border-radius:2px; background:${colors.accent}; }
  .timeline .knob { position:absolute; top:-5px; width:14px; height:14px; border-radius:50%; background:${colors.accent};
    transform:translateX(-50%); box-shadow:0 0 0 2px ${colors.background}; }
  .timeline[data-playing="yes"] .knob { box-shadow:0 0 0 2px ${colors.background}, 0 0 0 4px ${colors.accent}55; }
  .timeline .labels { position:relative; height:18px; font-size:11px; color:${colors.dim}; }
  .timeline .labels span { position:absolute; top:5px; transform:translateX(-50%); white-space:nowrap; }
  .timeline .labels span:first-child { transform:none; }
  .timeline .labels span:last-child { transform:translateX(-100%); }
</style></head>
<body>
<main>
  <h1 id="heading">${escape(title)}</h1>
  <p class="sub" id="sub">${escape(view.sub)}</p>
  <p class="mixed" id="mixed"${view.mixed ? '' : ' hidden'}>${escape(view.mixed || '')}</p>
  <p class="warn" id="warn" hidden></p>
  <div id="legend" hidden></div>
  <div class="frame"><svg class="chart" id="chart" role="img" aria-label="${escape(title)}"></svg></div>
  <div class="timeline" id="timeline" hidden></div>
  <p class="also" id="also"${related.length ? '' : ' hidden'}>${alsoLine(related)}</p>
  <div id="table">${view.table}</div>
  <p class="note">from hledger's own numbers: <code id="command">${escape(command)}</code></p>
  <p class="keys" id="keys">${escape(keysLine(view.draw === 'animate'))}</p>
</main>
<script type="application/json" id="chart-data">${data}</script>
${scripts.map((src) => `<script src="${escape(src)}"></script>`).join('\n')}
<script type="module">import { mount } from ${JSON.stringify(module)}; mount();</script>
</body></html>`;
}

/** The data as a table, which is also the accessible rendering of the chart. */
export function tableView(report) {
  const many = report.periods.length > 1;
  // hledger writes an empty cell as a bare 0, so a period with nothing in it has no commodity
  // of its own; it takes the report's, so the column reads $0.00 rather than 0.00 among dollars.
  const unit = report.unit || { prefix: '', suffix: '' };
  const money = (amount) => format(amount.prefix || amount.suffix ? amount : { ...amount, ...unit });
  const head = many
    ? '<tr><th>Period</th><th class="n">Total</th></tr>'
    : '<tr><th>Account</th><th class="n">Balance</th></tr>';
  const rows = many
    ? report.periods
      .map((period, index) => `<tr><td>${escape(period)}</td><td class="n">${escape(money(periodTotal(report, index)))}</td></tr>`)
      .join('')
    : report.series
      .map((series) => `<tr><td>${escape(series.label)}</td><td class="n">${escape(money(seriesTotal(series)))}</td></tr>`)
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
  const also = root.getElementById('also');
  const mixed = root.getElementById('mixed');
  const line = root.getElementById('timeline');
  const keysNote = root.getElementById('keys');
  const reduced = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let playing = null;

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

  // Ask the plugin for another chart, by the line that would ask for it in the terminal, and
  // keep the one being left so Escape can come back to it.
  async function follow(args) {
    if (busy) return;
    busy = true;
    tip.hide();
    show(warn, `Reading chart ${args}…`);
    const answer = await requery(data.token, args);
    busy = false;
    if (!answer) return;
    stack.push({ state: { ...state }, view });
    Object.assign(state, answer, { options: answer.options || {}, related: answer.related || [] });
    view = { hidden: new Set() };
    draw();
  }

  const hooks = {
    tip,
    // A mark names an account: that account over time, in the same period, is the next chart.
    pick(account) {
      const parsed = parse(state.args || 'line');
      return follow(drill(parsed.error ? { type: 'line', query: [], options: {} } : parsed, account));
    },
  };

  // One listener for the links, since they are rewritten on every redraw.
  also.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-args]');
    if (!link) return;
    event.preventDefault();
    follow(link.dataset.args);
  });

  // Draw one picture: a renderer from chart-d3.js, or one from chart-more.js.
  function drawOne(kind, data) {
    return (MORE.includes(kind) ? renderMore : render)(kind, svg, data, state.colors, hooks, view) || {};
  }

  function paint(shown = viewOf(state)) {
    try {
      if (shown.draw === 'animate') {
        if (playing) playing.redraw();
        return;
      }
      controls = drawOne(shown.draw, shown.data);
      show(warn, '');
    } catch (error) {
      controls = {};
      show(warn, error && error.message ? error.message : String(error));
    }
  }

  // An animation: the player owns the clock, and each frame is drawn by the still renderer.
  function animate(shown) {
    tip.hide();
    playing = player({
      holder,
      line,
      play: shown.play,
      reduced,
      paint(frame) {
        try {
          drawOne(frame.draw, frame.data);
        } catch (error) {
          show(warn, error && error.message ? error.message : String(error));
        }
      },
      onPeriod(_, words) {
        sub.textContent = `${shown.sub.split('; ')[0]}; ${words.sub}`;
        table.innerHTML = words.table;
      },
    });
    controls = {
      step: (direction) => playing.step(direction),
      reset: () => playing.reset(),
      play: () => playing.toggle(),
    };
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
    if (playing) {
      playing.stop();
      playing = null;
    }
    const shown = viewOf(state);
    keysNote.textContent = keysLine(shown.draw === 'animate');
    heading.textContent = state.title;
    document.title = `hledger: ${state.title}`;
    sub.textContent = shown.sub;
    command.textContent = state.command;
    table.innerHTML = shown.table;
    show(mixed, shown.mixed);
    also.innerHTML = alsoLine(state.related || []);
    also.hidden = !(state.related || []).length;
    holder.style.height = `${shown.height}px`;
    svg.setAttribute('aria-label', state.title);
    drawLegend(shown.items);
    if (shown.draw === 'animate') animate(shown);
    else paint(shown);
  }

  window.addEventListener('keydown', (event) => {
    const action = keyFor(event);
    if (!action) return;
    // Space plays an animation; anywhere else, and on a mark that took it to open its account,
    // it is left alone.
    if (action === 'play' && (event.defaultPrevented || !controls.play)) return;
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
    if (action === 'play' && controls.play) controls.play();
    if (action === 'save-svg' || action === 'save-png') {
      // The picture says what the page around it said: the subtitle, and the legend for
      // what is still shown.
      const shown = viewOf(state);
      const items = (shown.items || []).filter((item) => !view.hidden.has(item.label));
      save(svg, state.colors, state.title, action === 'save-svg' ? 'svg' : 'png', { subtitle: sub.textContent || shown.sub, items })
        .catch((error) => show(warn, error && error.message ? error.message : String(error)));
    }
  });

  // A new size is a new layout, so the chart is redrawn rather than stretched.
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paint(), 120);
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
