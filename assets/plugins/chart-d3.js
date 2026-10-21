/**
 * Every chart the window draws, and the parsing and arithmetic behind the ones that read a
 * report of their own.
 *
 * The window is a `blob:` document, so D3 arrives as the vendored UMD build in a classic
 * script and is read from `window.d3`. Everything that does not need the DOM — the register
 * and tree parsers, the aggregations, the Sankey layout, the table and the headline — is
 * exported and tested in node.
 *
 * Two families of chart:
 *
 *   * The balance charts read hledger's balance CSV through chart-window.js's model: a line
 *     per series over time, a stacked area, a ranking of bars, and a doughnut of shares.
 *   * The shaped charts read the report their picture needs: a treemap of the account tree, a
 *     calendar and a waterfall from the register, small multiples of monthly balances, and a
 *     Sankey of income flowing into spending.
 *
 * Every chart draws marks and reports what was pointed at, focused or clicked through the
 * `hooks` it is given; chart-ui.js turns that into a tooltip, and the window into a
 * drill-down. So all eleven behave alike: hover or Tab to a mark for its numbers, click or
 * Enter to chart that account on its own.
 */

import { format, group, mix, money, palette, percent, seriesTotal, split, unitOf } from './chart-data.js';

/** The kinds that read a report of their own rather than a balance report. */
export const CUSTOM = ['treemap', 'calendar', 'waterfall', 'multiples', 'sankey'];

export function isCustom(kind) {
  return CUSTOM.includes(kind);
}

// --------------------------------------------------------------------------- parsing

/** Whether an account is the root or under it. */
function under(account, root) {
  return account === root || account.startsWith(`${root}:`);
}

/** `2024-01-05` as a local date, with no timezone in the middle. */
export function dateOf(text) {
  const [year, month, day] = String(text).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

/**
 * Read hledger's register CSV.
 *
 *   "txnidx","date","code","description","account","amount","total"
 *   "2","2024-01-05","rent:january","Landlord","expenses:housing:rent","$600.00","$600.00"
 *
 * One row per posting, so a transaction appears once per account it touched. The header is
 * found rather than assumed, because a report can carry a title above it.
 */
export function readRegister(text) {
  const rows = String(text == null ? '' : text).trim().split('\n').map(split);
  const start = rows.findIndex((cells) => (cells[0] || '').trim().toLowerCase() === 'txnidx');
  if (start < 0) return null;
  const head = rows[start].map((cell) => cell.trim().toLowerCase());
  const at = {
    date: head.indexOf('date'),
    account: head.indexOf('account'),
    amount: head.indexOf('amount'),
    description: head.indexOf('description'),
  };
  if (at.date < 0 || at.account < 0 || at.amount < 0) return null;

  const postings = [];
  for (const cells of rows.slice(start + 1)) {
    if (cells.length <= Math.max(at.date, at.account, at.amount)) continue;
    const date = (cells[at.date] || '').trim();
    const account = (cells[at.account] || '').trim();
    const amount = money(cells[at.amount]);
    if (!dateOf(date) || !account || !amount.raw) continue;
    postings.push({
      date,
      account,
      amount,
      description: at.description >= 0 ? (cells[at.description] || '').trim() : '',
    });
  }
  if (postings.length === 0) return null;
  return { postings, unit: unitOf(postings.map((posting) => posting.amount)) };
}

/**
 * Read hledger's `--tree` balance CSV.
 *
 *   "account","balance"
 *   "expenses","$698.90"
 *   "␣␣food","$98.90"
 *   "␣␣␣␣coffee","$12.50"
 *
 * The hierarchy is the indentation, two characters a level, and a label can carry several
 * segments at once: `housing:rent` is one row because hledger elides a chain with no siblings.
 * `depth`, `label` and the amount are all a caller needs to rebuild the tree.
 *
 * The indentation hledger writes is the no-break space, U+00A0, not a space: `trim()` strips
 * it, which is how a parser that only counted spaces put every row at depth zero and drew the
 * parent beside its own children. Spaces and tabs are read too, for a report that went
 * through something that normalised them.
 */
export function readTree(text) {
  const rows = String(text == null ? '' : text).trim().split('\n').map(split);
  const start = rows.findIndex((cells) => (cells[0] || '').trim().toLowerCase() === 'account');
  if (start < 0) return null;

  const entries = [];
  for (const cells of rows.slice(start + 1)) {
    const raw = (cells[0] || '').replace(/\r$/, '');
    const label = raw.trim();
    if (!label || /^total:?$/i.test(label)) continue;
    const amount = money(cells[1]);
    if (!amount.raw) continue;
    // Two no-break spaces (or spaces) a level; a tab is a level on its own.
    const lead = (raw.match(/^[ \t\u00a0]+/) || [''])[0];
    const tabs = (lead.match(/\t/g) || []).length;
    const depth = tabs + Math.floor((lead.length - tabs) / 2);
    entries.push({ depth, label, amount });
  }
  if (entries.length === 0) return null;
  return {
    rows: entries,
    unit: unitOf(entries.map((entry) => entry.amount)),
    total: entries
      .filter((entry, index) => {
        const next = entries[index + 1];
        return !next || next.depth <= entry.depth;
      })
      .reduce((sum, entry) => sum + Math.abs(entry.amount.value), 0),
  };
}

// --------------------------------------------------------------------------- aggregations

/** Spending per day, largest day first, from a register. */
export function byDay(report) {
  const totals = new Map();
  for (const posting of report.postings) {
    if (!under(posting.account, 'expenses')) continue;
    if (posting.amount.value <= 0) continue;
    totals.set(posting.date, (totals.get(posting.date) || 0) + posting.amount.value);
  }
  const days = [...totals]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return {
    days,
    unit: report.unit,
    total: days.reduce((sum, day) => sum + day.value, 0),
  };
}

/**
 * Income, each expense category, and what is left.
 *
 * Only income and expense accounts take part: moving money between two asset accounts is not
 * income and must not appear as one. Expense categories are the first segment below
 * `expenses`, because a waterfall with one bar per leaf account is unreadable.
 */
export function waterfall(report) {
  let income = 0;
  const categories = new Map();
  for (const posting of report.postings) {
    if (under(posting.account, 'income')) {
      income += -posting.amount.value;
    } else if (under(posting.account, 'expenses')) {
      const [, category = 'other'] = posting.account.split(':');
      categories.set(category, (categories.get(category) || 0) + posting.amount.value);
    }
  }
  const expenses = [...categories]
    .map(([label, value]) => ({ label, value }))
    .filter((category) => Math.abs(category.value) > 0.005)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value));
  const spent = expenses.reduce((sum, category) => sum + category.value, 0);
  const steps = [
    { label: 'income', value: income, kind: 'income' },
    ...expenses.map((category) => ({ label: category.label, value: -category.value, kind: 'expense' })),
    { label: 'net', value: income - spent, kind: 'net' },
  ];
  return { steps, unit: report.unit, income, spent, net: income - spent };
}

/** The accounts worth a sparkline, largest first. */
export function multiples(report, limit = 8) {
  const rows = report.series
    .map((series) => ({
      label: series.label,
      amounts: series.amounts,
      total: series.amounts.reduce((sum, amount) => sum + amount.value, 0),
    }))
    .sort((left, right) => Math.abs(right.total) - Math.abs(left.total))
    .slice(0, limit);
  return { periods: report.periods, rows, unit: report.unit };
}

// --------------------------------------------------------------------------- flows

/** `expenses:food` -> `food`: the top segment is the column the node is in already. */
function shortName(account) {
  const parts = String(account).split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : parts[0];
}

/**
 * Income flowing into each kind of spending, and what was left.
 *
 * Read from `balance income expenses --depth 2`: one row per income source and expense
 * category. Asking hledger for those two trees is what keeps the picture honest — a transfer
 * between two asset accounts is in neither, so it cannot be mistaken for income or spending.
 *
 * Income is negative in hledger's sign convention and is turned around here. The two sides
 * are balanced the way a budget is: income above spending flows to "saved", and spending
 * above income is drawn from a "from savings" source, so every pixel of every link is money
 * that actually moved.
 */
export function flows(report) {
  const sources = [];
  const sinks = [];
  for (const series of report.series) {
    const value = seriesTotal(series).value;
    const account = series.label;
    if (/^(income|revenues?)(:|$)/i.test(account)) {
      if (-value > 0.005) sources.push({ account, label: shortName(account), value: -value, kind: 'income' });
    } else if (/^expenses?(:|$)/i.test(account)) {
      if (value > 0.005) sinks.push({ account, label: shortName(account), value, kind: 'expense' });
    }
  }
  sources.sort((left, right) => right.value - left.value);
  sinks.sort((left, right) => right.value - left.value);
  const income = sources.reduce((sum, node) => sum + node.value, 0);
  const spent = sinks.reduce((sum, node) => sum + node.value, 0);
  if (income - spent > 0.005) sinks.push({ account: null, label: 'saved', value: income - spent, kind: 'saved' });
  if (spent - income > 0.005) sources.push({ account: null, label: 'from savings', value: spent - income, kind: 'drawn' });
  return {
    sources,
    sinks,
    income,
    spent,
    net: income - spent,
    total: Math.max(income, spent),
    unit: report.unit || { prefix: '', suffix: '' },
  };
}

/**
 * Where every node and link of the Sankey goes, without a DOM.
 *
 * Three columns: the sources, one hub for the money that came in, and the sinks. Every column
 * is drawn at the same scale, the one that fits the tallest, so a link is as thick at both
 * ends and a node is as tall as the links that meet it. A link is a band between two cubic
 * curves, its top and bottom edges stacked down each node in the order the nodes are listed.
 */
export function sankeyLayout(data, width, height, { nodeWidth = 14, gap = 12, left = 0, right = 0, top = 8, bottom = 8 } = {}) {
  const hub = { account: null, label: 'income', value: data.total, kind: 'hub' };
  const columns = [data.sources, data.total > 0 ? [hub] : [], data.sinks];
  const usable = Math.max(1, height - top - bottom);
  const scale = Math.min(
    ...columns
      .filter((column) => column.length > 0)
      .map((column) => (usable - gap * (column.length - 1)) / (column.reduce((sum, node) => sum + node.value, 0) || 1)),
  );
  const xs = [left, (left + width - right - nodeWidth) / 2, width - right - nodeWidth];
  const nodes = [];
  columns.forEach((column, index) => {
    const tall = column.reduce((sum, node) => sum + node.value * scale, 0) + gap * Math.max(0, column.length - 1);
    let y = top + (usable - tall) / 2;
    for (const node of column) {
      const h = node.value * scale;
      nodes.push({ ...node, column: index, x: xs[index], y, w: nodeWidth, h });
      y += h + gap;
    }
  });

  const centre = nodes.find((node) => node.column === 1);
  const links = [];
  if (centre) {
    let into = centre.y;
    for (const node of nodes.filter((entry) => entry.column === 0)) {
      links.push(band(node, centre, node.y, into, node.h));
      into += node.h;
    }
    let out = centre.y;
    for (const node of nodes.filter((entry) => entry.column === 2)) {
      links.push(band(centre, node, out, node.y, node.h));
      out += node.h;
    }
  }
  return { nodes, links, scale };
}

function band(from, to, y0, y1, thickness) {
  const x0 = from.x + from.w;
  const x1 = to.x;
  const middle = (x0 + x1) / 2;
  return {
    from: from.label,
    to: to.label,
    value: thickness,
    x0,
    x1,
    y0,
    y1,
    thickness,
    path: `M${x0},${y0}C${middle},${y0} ${middle},${y1} ${x1},${y1}`
      + `L${x1},${y1 + thickness}C${middle},${y1 + thickness} ${middle},${y0 + thickness} ${x0},${y0 + thickness}Z`,
  };
}

// --------------------------------------------------------------------------- the words

const amountOf = (value, unit) => format({ value, ...(unit || { prefix: '', suffix: '' }) });

/** The line under the heading. */
export function headlineFor(kind, data) {
  if (kind === 'treemap') {
    const leaves = data.rows.filter((row, index) => {
      const next = data.rows[index + 1];
      return !next || next.depth <= row.depth;
    }).length;
    return `${leaves} accounts, ${amountOf(data.total, data.unit)} at the leaves`;
  }
  if (kind === 'calendar') {
    if (data.days.length === 0) return 'no spending in the register';
    return `${data.days.length} days of spending, ${amountOf(data.total, data.unit)}`;
  }
  if (kind === 'waterfall') {
    return `income ${amountOf(data.income, data.unit)}, spent ${amountOf(data.spent, data.unit)}, net ${amountOf(data.net, data.unit)}`;
  }
  if (kind === 'sankey') {
    if (data.total <= 0) return 'no income or spending to draw';
    const categories = data.sinks.filter((node) => node.kind === 'expense').length;
    const left = data.net >= 0
      ? `${amountOf(data.net, data.unit)} saved`
      : `${amountOf(-data.net, data.unit)} more spent than came in`;
    return `income ${amountOf(data.income, data.unit)} into ${categories} ${categories === 1 ? 'category' : 'categories'}, ${left}`;
  }
  return `${data.rows.length} accounts, ${data.periods.length} periods`;
}

/** The same data as a table, which is what a screen reader gets. */
export function tableFor(kind, data) {
  const table = (head, rows) => `<table><thead><tr><th>${head[0]}</th><th class="n">${head[1]}</th></tr></thead><tbody>${rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="n">${escape(value)}</td></tr>`)
    .join('')}</tbody></table>`;
  if (kind === 'treemap') {
    return table(['Account', 'Balance'], data.rows.map((row) => [`${'&nbsp;'.repeat(row.depth * 3)}${escape(row.label)}`, format(row.amount)]));
  }
  if (kind === 'calendar') {
    return table(['Day', 'Spent'], data.days.map((day) => [escape(day.date), amountOf(day.value, data.unit)]));
  }
  if (kind === 'waterfall') {
    return table(['Step', 'Amount'], data.steps.map((step) => [escape(step.label), amountOf(step.value, data.unit)]));
  }
  if (kind === 'sankey') {
    return table(['Flow', 'Amount'], [
      ...data.sources.map((node) => [`from ${escape(node.label)}`, amountOf(node.value, data.unit)]),
      ...data.sinks.map((node) => [node.kind === 'saved' ? 'saved' : `to ${escape(node.label)}`, amountOf(node.value, data.unit)]),
    ]);
  }
  return table(['Account', 'Total'], data.rows.map((row) => [escape(row.label), amountOf(row.total, data.unit)]));
}

/** A label for an axis: "$1,200", "$12k", "$1.4M". */
export function tick(value, unit = { prefix: '', suffix: '' }) {
  const size = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  let body;
  // One decimal below a hundred of a unit, so $12,500 is $12.5k rather than a rounded $13k,
  // and a trailing .0 is dropped: $20k, not $20.0k.
  const short = (number, digits) => number.toFixed(digits).replace(/\.0$/, '');
  if (size >= 1e6) body = `${short(size / 1e6, size >= 1e8 ? 0 : 1)}M`;
  else if (size >= 1e4) body = `${short(size / 1e3, size >= 1e5 ? 0 : 1)}k`;
  else body = group(size, size > 0 && size < 10 && size % 1 !== 0 ? 1 : 0);
  return `${sign}${unit.prefix || ''}${body}${unit.suffix ? ` ${unit.suffix}` : ''}`;
}

/** How tall a chart wants to be, before it is drawn. The charts may grow their frame. */
export function heightFor(kind, data) {
  if (kind === 'bar') return Math.min(900, Math.max(180, data.rows.length * 30 + 50));
  if (kind === 'doughnut') return 380;
  if (kind === 'sankey') {
    const column = Math.max(data.sources.length, data.sinks.length, 1);
    return Math.min(900, Math.max(300, column * 46 + 40));
  }
  if (kind === 'calendar') return 220;
  return 420;
}

// --------------------------------------------------------------------------- drawing

/**
 * Set up the svg and hand back d3, its size, and a selection to draw into.
 *
 * The svg fills its frame, and the frame's height is the chart's to choose: `want` is the
 * height this chart needs for its width, when that is not what the page guessed.
 */
function frame(svg, want) {
  const d3 = window.d3;
  if (!d3) throw new Error('the chart library did not load');
  const holder = svg.parentElement;
  const width = Math.max(320, Math.round(holder?.clientWidth || svg.clientWidth || 900));
  if (want && holder) holder.style.height = `${Math.round(want(width))}px`;
  const height = Math.max(160, Math.round(holder?.clientHeight || svg.clientHeight || 420));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.replaceChildren();
  return { d3, width, height, root: d3.select(svg) };
}

/** The middle of an element, in the svg's coordinates, for a tooltip that follows focus. */
function centreOf(node, svg) {
  const inner = node.getBoundingClientRect();
  const outer = svg.getBoundingClientRect();
  return [inner.left - outer.left + inner.width / 2, inner.top - outer.top + inner.height / 2];
}

/**
 * Make marks answer the pointer and the keyboard the same way.
 *
 * Hover and focus show the tooltip; click and Enter open the account the mark stands for, when
 * it stands for one. A focused mark gets a ring in the foreground colour, since an SVG shape
 * has no focus outline of its own.
 */
function interactive(selection, { d3, svg, hooks, colors, tip, account, label }) {
  selection
    .attr('tabindex', 0)
    .attr('focusable', 'true')
    .attr('role', (d) => (account && account(d) ? 'button' : 'img'))
    .attr('aria-label', (d) => label(d))
    .style('cursor', (d) => (account && account(d) ? 'pointer' : null))
    .style('outline', 'none')
    .on('pointerenter pointermove', (event, d) => {
      const [x, y] = d3.pointer(event, svg);
      hooks.tip.show(tip(d), x, y);
    })
    .on('pointerleave', () => hooks.tip.hide())
    .on('focus', (event, d) => {
      const node = event.currentTarget;
      node.dataset.stroke = node.getAttribute('stroke') || '';
      node.dataset.strokeWidth = node.getAttribute('stroke-width') || '';
      node.setAttribute('stroke', colors.foreground);
      node.setAttribute('stroke-width', '2');
      const [x, y] = centreOf(node, svg);
      hooks.tip.show(tip(d), x, y);
    })
    .on('blur', (event) => {
      const node = event.currentTarget;
      if (node.dataset.stroke) node.setAttribute('stroke', node.dataset.stroke); else node.removeAttribute('stroke');
      if (node.dataset.strokeWidth) node.setAttribute('stroke-width', node.dataset.strokeWidth); else node.removeAttribute('stroke-width');
      hooks.tip.hide();
    })
    .on('click', (event, d) => {
      const name = account && account(d);
      if (name) hooks.pick(name);
    })
    .on('keydown', (event, d) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const name = account && account(d);
      if (!name) return;
      event.preventDefault();
      hooks.pick(name);
    });
  return selection;
}

/** A label cut to fit, with an ellipsis, at the 11px the charts use. */
function fit(text, pixels) {
  const room = Math.max(3, Math.floor(pixels / 6.4));
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

function nothing(root, colors, message = 'Nothing to draw.') {
  root.append('text').attr('x', 8).attr('y', 24).attr('fill', colors.dim).text(message);
}

/**
 * Draw whichever chart the kind names, and hand back what the keyboard can do to it.
 *
 * `state` survives a redraw: which series are hidden, and the zoom. The returned controls are
 * the keys' half of the bargain: `step`, `zoomBy` and `reset` on the charts where they mean
 * something, and nothing elsewhere.
 */
export function render(kind, svg, data, colors, hooks, state = {}) {
  state.hidden = state.hidden || new Set();
  if (kind === 'line' || kind === 'stacked') return drawSeries(svg, data, colors, hooks, state);
  if (kind === 'bar') return drawBar(svg, data, colors, hooks);
  if (kind === 'doughnut') return drawDoughnut(svg, data, colors, hooks, state);
  if (kind === 'treemap') return drawTreemap(svg, data, colors, hooks);
  if (kind === 'calendar') return drawCalendar(svg, data, colors, hooks);
  if (kind === 'waterfall') return drawWaterfall(svg, data, colors, hooks);
  if (kind === 'multiples') return drawMultiples(svg, data, colors, hooks);
  if (kind === 'sankey') return drawSankey(svg, data, colors, hooks);
  throw new Error(`no chart for ${kind}`);
}

// ---------------------------------------------------------------- lines and stacked areas

/**
 * Series over time: a line each, or stacked areas.
 *
 * The pointer is read by period rather than by mark: hovering anywhere in the plot finds the
 * nearest period, draws a crosshair there and lists every visible series, which is what a
 * question about a month wants. A click opens the series nearest the pointer at that period.
 * The wheel zooms along time, a drag pans, a double-click resets, and ← → step the crosshair.
 */
function drawSeries(svg, model, colors, hooks, state) {
  const { d3, width, height, root } = frame(svg);
  const stacked = model.type === 'stacked';
  const visible = model.series.filter((series) => !state.hidden.has(series.label));
  const count = model.periods.length;
  const unit = model.unit;
  if (visible.length === 0 || count === 0) {
    nothing(root, colors, visible.length === 0 ? 'Every series is hidden. Click one in the legend.' : undefined);
    return {};
  }

  let layers = null;
  let low = Infinity;
  let high = -Infinity;
  if (stacked) {
    const rows = model.periods.map((_, index) => Object.fromEntries(visible.map((series, key) => [key, series.values[index] || 0])));
    layers = d3.stack().keys(visible.map((_, key) => key)).offset(d3.stackOffsetDiverging)(rows);
    for (const layer of layers) for (const [a, b] of layer) { low = Math.min(low, a, b); high = Math.max(high, a, b); }
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  } else {
    for (const series of visible) for (const value of series.values) { low = Math.min(low, value); high = Math.max(high, value); }
    // Zero is on the axis when it is near the data; a balance that hovers around 9,000 is
    // not flattened into a line at the top of a chart that starts at nothing.
    if (low >= 0 && low <= high * 0.35) low = 0;
    if (high <= 0 && high >= low * 0.35) high = 0;
  }
  if (low === high) { low -= 1; high += 1; }

  const margin = { top: 12, right: 18, bottom: 28, left: 12 };
  // One count for both: a domain made nice for ten ticks and labelled with eight leaves its
  // top unlabelled, and the highest value floating above the last gridline.
  const tickCount = Math.max(2, Math.floor((height - margin.top - margin.bottom) / 46));
  const y = d3.scaleLinear().domain([low, high]).nice(tickCount).range([height - margin.bottom, margin.top]);
  const ticksY = y.ticks(tickCount);
  margin.left = 12 + Math.max(...ticksY.map((value) => tick(value, unit).length)) * 6.6;
  const x0 = d3.scaleLinear()
    .domain(count > 1 ? [0, count - 1] : [-0.5, 0.5])
    .range([margin.left, width - margin.right]);
  let x = x0;

  const grid = root.append('g');
  for (const value of ticksY) {
    grid.append('line')
      .attr('x1', margin.left).attr('x2', width - margin.right)
      .attr('y1', y(value)).attr('y2', y(value))
      .attr('stroke', colors.dim).attr('stroke-opacity', value === 0 ? 0.55 : 0.22);
    grid.append('text')
      .attr('x', margin.left - 8).attr('y', y(value)).attr('dy', '0.32em')
      .attr('text-anchor', 'end').attr('fill', colors.dim).attr('font-size', 11)
      .text(tick(value, unit));
  }

  const clipId = `clip-${Math.random().toString(36).slice(2, 8)}`;
  root.append('clipPath').attr('id', clipId).append('rect')
    .attr('x', margin.left - 4).attr('y', 0)
    .attr('width', width - margin.left - margin.right + 8).attr('height', height);
  const plot = root.append('g').attr('clip-path', `url(#${clipId})`);
  const axis = root.append('g');
  const cursor = root.append('g').attr('data-transient', '').style('pointer-events', 'none');

  const paths = [];
  if (stacked) {
    layers.forEach((layer, key) => {
      paths.push(plot.append('path')
        .datum(layer)
        .attr('fill', visible[key].colour)
        .attr('fill-opacity', 0.82)
        .attr('stroke', colors.background)
        .attr('stroke-width', 0.8));
    });
  } else {
    if (model.fill && visible.length === 1) {
      paths.push(plot.append('path').datum(visible[0].values).attr('class', 'fill')
        .attr('fill', visible[0].colour).attr('fill-opacity', 0.18));
    }
    for (const series of visible) {
      paths.push(plot.append('path').datum(series.values).attr('class', 'line')
        .attr('fill', 'none').attr('stroke', series.colour).attr('stroke-width', 2)
        .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round'));
    }
  }
  const dots = stacked || count > 60 ? null : visible.map((series) => plot.append('g')
    .selectAll('circle').data(series.values).join('circle')
    .attr('r', 2.8).attr('fill', series.colour));

  function place(scale) {
    x = scale;
    const curve = d3.curveMonotoneX;
    if (stacked) {
      const area = d3.area().curve(curve).x((_, index) => x(index)).y0((d) => y(d[0])).y1((d) => y(d[1]));
      for (const path of paths) path.attr('d', area);
    } else {
      const line = d3.line().curve(curve).defined((value) => Number.isFinite(value)).x((_, index) => x(index)).y((value) => y(value));
      const fill = d3.area().curve(curve).x((_, index) => x(index)).y0(height - margin.bottom).y1((value) => y(value));
      for (const path of paths) path.attr('d', path.attr('class') === 'fill' ? fill : line);
    }
    if (dots) for (const group of dots) group.attr('cx', (_, index) => x(index)).attr('cy', (value) => y(value));

    // Period labels: as many as fit, never overlapping, always whole periods.
    axis.selectAll('*').remove();
    const [from, to] = x.domain();
    const first = Math.max(0, Math.ceil(from));
    const last = Math.min(count - 1, Math.floor(to));
    const widest = Math.max(...model.periods.map((period) => period.length)) * 6.6 + 14;
    const every = Math.max(1, Math.ceil((last - first + 1) / Math.max(1, Math.floor((width - margin.left - margin.right) / widest))));
    for (let index = first; index <= last; index += every) {
      axis.append('text')
        .attr('x', x(index)).attr('y', height - margin.bottom + 18)
        .attr('text-anchor', count === 1 ? 'middle' : index === 0 && x(index) < margin.left + widest / 2 ? 'start' : index === count - 1 && x(index) > width - margin.right - widest / 2 ? 'end' : 'middle')
        .attr('fill', colors.dim).attr('font-size', 11)
        .text(model.periods[index]);
    }
    if (state.at !== undefined && state.at !== null) mark(state.at);
  }

  function valuesAt(index) {
    return visible.map((series, key) => ({
      series,
      value: series.values[index] || 0,
      top: stacked ? layers[key][index][1] : series.values[index],
      bottom: stacked ? layers[key][index][0] : null,
    }));
  }

  function mark(index, pointer) {
    cursor.selectAll('*').remove();
    if (index === null || index === undefined) { hooks.tip.hide(); return; }
    const at = x(index);
    if (at < margin.left - 1 || at > width - margin.right + 1) { hooks.tip.hide(); return; }
    cursor.append('line')
      .attr('x1', at).attr('x2', at).attr('y1', margin.top).attr('y2', height - margin.bottom)
      .attr('stroke', colors.foreground).attr('stroke-opacity', 0.35);
    const values = valuesAt(index);
    for (const entry of values) {
      cursor.append('circle')
        .attr('cx', at).attr('cy', y(entry.top)).attr('r', 4.5)
        .attr('fill', entry.series.colour).attr('stroke', colors.background).attr('stroke-width', 1.5);
    }
    const rows = [...values]
      .sort((left, right) => right.value - left.value)
      .map((entry) => ({ colour: entry.series.colour, label: entry.series.label, value: amountOf(entry.value, unit) }));
    if (stacked || visible.length > 1) {
      rows.push({ label: 'total', value: amountOf(values.reduce((sum, entry) => sum + entry.value, 0), unit) });
    }
    const top = Math.min(...values.map((entry) => y(entry.top)));
    hooks.tip.show({ title: model.periods[index], rows }, at, pointer ?? top);
  }

  // The series a pointer at height `py` means, at period `index`.
  function nearest(index, py) {
    const values = valuesAt(index);
    if (stacked) {
      const inside = values.find((entry) => py <= y(Math.min(entry.top, entry.bottom)) && py >= y(Math.max(entry.top, entry.bottom)));
      if (inside) return inside.series;
    }
    return values.reduce((best, entry) => (Math.abs(y(entry.top) - py) < Math.abs(y(best.top) - py) ? entry : best)).series;
  }

  const overlay = root.append('rect')
    .attr('data-transient', '')
    .attr('x', margin.left).attr('y', margin.top)
    .attr('width', Math.max(0, width - margin.left - margin.right))
    .attr('height', Math.max(0, height - margin.top - margin.bottom))
    .attr('fill', 'transparent')
    .style('cursor', model.drillable ? 'pointer' : 'crosshair');
  const indexAt = (px) => Math.max(0, Math.min(count - 1, Math.round(x.invert(px))));
  overlay
    .on('pointermove', (event) => {
      const [px, py] = d3.pointer(event, svg);
      state.at = indexAt(px);
      mark(state.at, py);
    })
    .on('pointerleave', () => { state.at = null; mark(null); })
    .on('click', (event) => {
      if (!model.drillable) return;
      const [px, py] = d3.pointer(event, svg);
      const series = nearest(indexAt(px), py);
      if (series && !series.other) hooks.pick(series.label);
    });

  // Zoom along time only. Two periods cannot be zoomed into, so the wheel is left alone there.
  const most = Math.max(1, (count - 1) / 2);
  const zoom = d3.zoom()
    .scaleExtent([1, most])
    .extent([[margin.left, 0], [width - margin.right, height]])
    .translateExtent([[margin.left, -Infinity], [width - margin.right, Infinity]])
    .clickDistance(4)
    .filter((event) => most > 1 && event.type !== 'dblclick' && !event.button)
    .on('zoom', (event) => {
      state.transform = event.transform;
      place(event.transform.rescaleX(x0));
    });
  root.call(zoom).on('dblclick.zoom', null);
  overlay.on('dblclick', () => root.transition().duration(220).call(zoom.transform, d3.zoomIdentity));
  place(x0);
  if (state.transform && most > 1) root.call(zoom.transform, state.transform);

  return {
    step(direction) {
      const current = state.at ?? (direction > 0 ? -1 : count);
      state.at = Math.max(0, Math.min(count - 1, current + direction));
      // Keep the crosshair on screen: pan to it when it walks off the zoomed range.
      const [from, to] = x.domain();
      if (state.at < from || state.at > to) {
        root.call(zoom.translateTo, x0(state.at), height / 2);
      }
      mark(state.at);
    },
    zoomBy(factor) {
      if (most <= 1) return;
      const centre = state.at !== null && state.at !== undefined ? x(state.at) : (margin.left + width - margin.right) / 2;
      root.transition().duration(180).call(zoom.scaleBy, factor, [centre, height / 2]);
    },
    reset() {
      root.transition().duration(220).call(zoom.transform, d3.zoomIdentity);
    },
    pickCurrent() {
      if (!model.drillable || state.at === null || state.at === undefined || visible.length !== 1) return;
      if (!visible[0].other) hooks.pick(visible[0].label);
    },
  };
}

// ---------------------------------------------------------------- a ranking

/** One bar per account, largest first, labelled on the left and valued on the right. */
function drawBar(svg, model, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  const rows = model.rows;
  if (rows.length === 0) { nothing(root, colors); return {}; }
  const unit = model.unit;
  const longest = Math.max(...rows.map((row) => row.label.length));
  const left = Math.min(width * 0.4, 16 + longest * 6.4);
  const right = 16 + Math.max(...rows.map((row) => amountOf(row.value, unit).length)) * 6.6;
  const margin = { top: 6, bottom: 26 };
  const values = rows.map((row) => row.value);
  const x = d3.scaleLinear()
    .domain([Math.min(0, ...values), Math.max(0, ...values)]).nice()
    .range([left, width - right]);
  const y = d3.scaleBand().domain(rows.map((_, index) => index))
    .range([margin.top, height - margin.bottom]).paddingInner(0.24).paddingOuter(0.12);

  for (const value of x.ticks(Math.max(2, Math.floor((width - left - right) / 90)))) {
    root.append('line')
      .attr('x1', x(value)).attr('x2', x(value)).attr('y1', margin.top).attr('y2', height - margin.bottom)
      .attr('stroke', colors.dim).attr('stroke-opacity', value === 0 ? 0.55 : 0.2);
    root.append('text')
      .attr('x', x(value)).attr('y', height - margin.bottom + 17).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(tick(value, unit));
  }

  const bars = root.append('g').selectAll('rect').data(rows).join('rect')
    .attr('x', (row) => x(Math.min(0, row.value)))
    .attr('y', (_, index) => y(index))
    .attr('width', (row) => Math.max(1, Math.abs(x(row.value) - x(0))))
    .attr('height', y.bandwidth())
    .attr('rx', 2)
    .attr('fill', (row) => row.colour);
  interactive(bars, {
    d3, svg, hooks, colors,
    tip: (row) => ({ title: row.label, rows: [{ label: amountOf(row.value, unit), value: `${row.shareText} of the total` }] }),
    account: (row) => (model.drillable && !row.other ? row.label : null),
    label: (row) => `${row.label}, ${amountOf(row.value, unit)}, ${row.shareText}`,
  });

  root.append('g').selectAll('text').data(rows).join('text')
    .attr('x', left - 8).attr('y', (_, index) => y(index) + y.bandwidth() / 2).attr('dy', '0.32em')
    .attr('text-anchor', 'end').attr('fill', colors.foreground).attr('font-size', 11)
    .style('pointer-events', 'none')
    .text((row) => fit(row.label, left - 12));
  root.append('g').selectAll('text').data(rows).join('text')
    .attr('x', (row) => x(Math.max(0, row.value)) + 6).attr('y', (_, index) => y(index) + y.bandwidth() / 2).attr('dy', '0.32em')
    .attr('fill', colors.dim).attr('font-size', 11)
    .style('pointer-events', 'none')
    .text((row) => amountOf(row.value, unit));
  return {};
}

// ---------------------------------------------------------------- shares

/** A doughnut of the positive balances, with the total of what is shown in the middle. */
function drawDoughnut(svg, model, colors, hooks, state) {
  const { d3, width, height, root } = frame(svg);
  const rows = model.rows.filter((row) => !state.hidden.has(row.label));
  if (rows.length === 0) {
    nothing(root, colors, model.rows.length ? 'Every slice is hidden. Click one in the legend.' : undefined);
    return {};
  }
  const unit = model.unit;
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  const radius = Math.max(40, Math.min(width, height) / 2 - 10);
  const centre = root.append('g').attr('transform', `translate(${width / 2},${height / 2})`);
  const arcs = d3.pie().sort(null).value((row) => row.value)(rows);
  const arc = d3.arc().innerRadius(radius * 0.58).outerRadius(radius).padAngle(rows.length > 1 ? 0.006 : 0);
  const slices = centre.selectAll('path').data(arcs).join('path')
    .attr('d', arc)
    .attr('fill', (slice) => slice.data.colour)
    .attr('stroke', colors.background)
    .attr('stroke-width', 1.5);
  interactive(slices, {
    d3, svg, hooks, colors,
    tip: (slice) => ({
      title: slice.data.label,
      rows: [{ label: amountOf(slice.data.value, unit), value: `${percent(slice.data.value, total)} of what is shown` }],
    }),
    account: (slice) => (model.drillable && !slice.data.other ? slice.data.label : null),
    label: (slice) => `${slice.data.label}, ${amountOf(slice.data.value, unit)}, ${percent(slice.data.value, total)}`,
  });
  centre.append('text').attr('text-anchor', 'middle').attr('dy', '-0.2em')
    .attr('fill', colors.foreground).attr('font-size', Math.max(13, Math.min(22, radius / 6)))
    .attr('font-weight', 600).style('pointer-events', 'none')
    .text(amountOf(total, unit));
  centre.append('text').attr('text-anchor', 'middle').attr('dy', '1.3em')
    .attr('fill', colors.dim).attr('font-size', 11).style('pointer-events', 'none')
    .text(`${rows.length} ${rows.length === 1 ? 'account' : 'accounts'}`);
  return {};
}

// ---------------------------------------------------------------- the tree

/** A treemap of the account tree, area proportional to the leaf balances. */
function drawTreemap(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);

  // The CSV has one row per node, parents included; the leaves are the rows with nothing
  // indented below them, and summing from the leaves is what stops a parent counting twice.
  const leaves = data.rows.map((row, index) => {
    const next = data.rows[index + 1];
    return !next || next.depth <= row.depth;
  });
  const tree = { name: '', children: [] };
  const parents = [tree];
  data.rows.forEach((row, index) => {
    const parent = parents[row.depth] || tree;
    let node = parent;
    for (const part of row.label.split(':').filter(Boolean)) {
      let child = node.children.find((entry) => entry.name === part);
      if (!child) {
        child = { name: part, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    if (leaves[index]) {
      delete node.children;
      node.value = Math.abs(row.amount.value);
    }
    parents[row.depth + 1] = node;
  });

  const hierarchy = d3
    .treemap()
    .size([width, Math.max(height - 8, 120)])
    .paddingInner(2)
    .round(true)(d3.hierarchy(tree).sum((node) => node.value || 0));

  // Colour by the branches under the root. A report asked for one account has a single child
  // at the top ("expenses"), so the colouring starts one level deeper: food, housing, reading.
  const groupDepth = (hierarchy.children || []).length === 1 ? 2 : 1;
  const groupOf = (node) => {
    const ancestors = node.ancestors();
    return ancestors.find((entry) => entry.depth === groupDepth) || ancestors[ancestors.length - 2] || node;
  };
  const groups = new Map();
  for (const leaf of hierarchy.leaves()) {
    if (leaf.value > 0 && !groups.has(groupOf(leaf))) groups.set(groupOf(leaf), groups.size);
  }
  const colours = palette(colors, Math.max(groups.size, 1));
  const total = hierarchy.value || 1;
  const path = (leaf) => leaf.ancestors().reverse().map((node) => node.data.name).filter(Boolean).join(':');
  const shown = hierarchy.leaves().filter((leaf) => leaf.value > 0);

  const cells = root.append('g').selectAll('rect').data(shown).join('rect')
    .attr('x', (leaf) => leaf.x0)
    .attr('y', (leaf) => leaf.y0)
    .attr('width', (leaf) => Math.max(0, leaf.x1 - leaf.x0))
    .attr('height', (leaf) => Math.max(0, leaf.y1 - leaf.y0))
    .attr('fill', (leaf) => colours[groups.get(groupOf(leaf)) % colours.length])
    .attr('stroke', colors.background)
    .attr('stroke-width', 1);
  interactive(cells, {
    d3, svg, hooks, colors,
    tip: (leaf) => ({ title: path(leaf), rows: [{ label: amountOf(leaf.value, data.unit), value: `${percent(leaf.value, total)} of the total` }] }),
    account: (leaf) => path(leaf),
    label: (leaf) => `${path(leaf)}, ${amountOf(leaf.value, data.unit)}, ${percent(leaf.value, total)}`,
  });
  root.append('g').style('pointer-events', 'none').selectAll('text')
    .data(shown.filter((leaf) => leaf.x1 - leaf.x0 > 62 && leaf.y1 - leaf.y0 > 20)).join('text')
    .attr('x', (leaf) => leaf.x0 + 4)
    .attr('y', (leaf) => leaf.y0 + 14)
    .attr('fill', colors.background)
    .attr('font-size', 11)
    .text((leaf) => fit(leaf.data.name, leaf.x1 - leaf.x0 - 8));
  return {};
}

// ---------------------------------------------------------------- days

/** A year of daily spending as a calendar, one square per day, darker for more. */
function drawCalendar(svg, data, colors, hooks) {
  const d3 = window.d3;
  if (!d3) throw new Error('the chart library did not load');
  const dates = data.days.map((day) => dateOf(day.date)).filter(Boolean);
  const firstDay = dates.length ? d3.min(dates) : null;
  const lastDay = dates.length ? d3.max(dates) : null;
  const weeks = firstDay ? d3.timeWeek.range(d3.timeWeek.floor(firstDay), d3.timeDay.offset(lastDay, 1)) : [];
  const left = 34;
  const top = 22;
  const cellFor = (width) => Math.max(6, Math.min(26, Math.floor((width - left - 12) / Math.max(weeks.length, 1)) - 2));
  const { width, root } = frame(svg, (width) => {
    const cell = cellFor(width);
    return top + 7 * (cell + Math.max(1, Math.round(cell / 7))) + 34;
  });
  if (data.days.length === 0) { nothing(root, colors); return {}; }

  const values = new Map(data.days.map((day) => [day.date, day.value]));
  const cell = cellFor(width);
  const gap = Math.max(1, Math.round(cell / 7));
  const step = cell + gap;
  const max = d3.max(data.days, (day) => day.value) || 1;
  const empty = mix(colors.background, colors.dim, 16);
  const colour = (value) => mix(colors.background, colors.accent, 18 + Math.round((82 * value) / max));
  const key = d3.timeFormat('%Y-%m-%d');
  const named = d3.timeFormat('%a %d %b %Y');

  const squares = [];
  weeks.forEach((week, index) => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = d3.timeDay.offset(week, weekday);
      // The grid starts on the week of the first day; the days before it belong to the
      // previous month and would put a month name on screen that no square stands for.
      if (day < firstDay || day > lastDay) continue;
      squares.push({ day, date: key(day), value: values.get(key(day)) || 0, x: left + index * step, y: top + weekday * step });
    }
  });
  const marks = root.append('g').selectAll('rect').data(squares).join('rect')
    .attr('x', (square) => square.x).attr('y', (square) => square.y)
    .attr('width', cell).attr('height', cell).attr('rx', 2)
    .attr('fill', (square) => (square.value ? colour(square.value) : empty));
  // Only the days with spending are worth a stop on the way through with Tab.
  interactive(marks.filter((square) => square.value > 0), {
    d3, svg, hooks, colors,
    tip: (square) => ({ title: named(square.day), rows: [{ label: 'spent', value: amountOf(square.value, data.unit) }] }),
    account: null,
    label: (square) => `${named(square.day)}, spent ${amountOf(square.value, data.unit)}`,
  });
  marks.filter((square) => !square.value)
    .on('pointerenter pointermove', (event, square) => {
      const [x, y] = d3.pointer(event, svg);
      hooks.tip.show({ title: named(square.day), rows: [{ label: 'nothing spent' }] }, x, y);
    })
    .on('pointerleave', () => hooks.tip.hide());

  // Month names over the week that holds each month's first day, and over the first column for
  // the month the range starts in. Naming a week after its own first day missed every month
  // whose 1st fell mid-week, which is most of them. Two names that would land within a word of
  // each other are not both drawn; the later one wins, since it is the month that has begun.
  const names = [];
  weeks.forEach((week, index) => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = d3.timeDay.offset(week, weekday);
      if (day < firstDay || day > lastDay) continue;
      if (index === 0 && names.length === 0) names.push({ index, day });
      else if (day.getDate() === 1) names.push({ index, day });
    }
  });
  names.forEach((name, position) => {
    const next = names[position + 1];
    if (next && (next.index - name.index) * step < 30) return;
    root.append('text').attr('x', left + name.index * step).attr('y', top - 6)
      .attr('fill', colors.dim).attr('font-size', 11)
      .text(d3.timeFormat(name.day.getMonth() === 0 || position === 0 ? '%b %Y' : '%b')(name.day));
  });
  for (const [weekday, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    root.append('text')
      .attr('x', left - 6).attr('y', top + weekday * step + cell - 2)
      .attr('text-anchor', 'end').attr('fill', colors.dim).attr('font-size', 10).text(name);
  }
  root.append('text')
    .attr('x', left).attr('y', top + 7 * step + 16)
    .attr('fill', colors.dim).attr('font-size', 11)
    .text(`spending per day, by the date in the journal; the darkest is ${amountOf(max, data.unit)}`);
  return {};
}

// ---------------------------------------------------------------- income to net

/** Income down to net, as a waterfall: each category a step down from what came in. */
function drawWaterfall(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  const steps = data.steps;
  if (steps.length === 0 || (data.income === 0 && data.spent === 0)) { nothing(root, colors); return {}; }
  const margin = { top: 20, right: 12, bottom: 34, left: 12 };

  let running = 0;
  const bars = steps.map((step) => {
    const start = step.kind === 'expense' ? running : 0;
    const end = step.kind === 'expense' ? running + step.value : step.value;
    running = step.kind === 'net' ? running : end;
    return { ...step, start, end };
  });
  const values = bars.flatMap((bar) => [bar.start, bar.end, 0]);
  const y = d3.scaleLinear().domain([Math.min(...values), Math.max(...values)]).nice(5)
    .range([height - margin.bottom, margin.top]);
  const ticksY = y.ticks(5);
  margin.left = 12 + Math.max(...ticksY.map((value) => tick(value, data.unit).length)) * 6.6;
  const x = d3.scaleBand().domain(steps.map((step) => step.label))
    .range([margin.left, width - margin.right]).padding(0.28);
  const colours = palette(colors, Math.max(steps.length - 2, 1));

  for (const value of ticksY) {
    root.append('line').attr('x1', margin.left).attr('x2', width - margin.right)
      .attr('y1', y(value)).attr('y2', y(value))
      .attr('stroke', colors.dim).attr('stroke-opacity', value === 0 ? 0.55 : 0.2);
    root.append('text').attr('x', margin.left - 8).attr('y', y(value)).attr('dy', '0.32em')
      .attr('text-anchor', 'end').attr('fill', colors.dim).attr('font-size', 11).text(tick(value, data.unit));
  }

  let expense = 0;
  const filled = bars.map((bar) => ({
    ...bar,
    colour: bar.kind === 'income' ? colors.accent : bar.kind === 'net' ? colors.foreground : colours[expense++ % colours.length],
  }));
  const rects = root.append('g').selectAll('rect').data(filled).join('rect')
    .attr('x', (bar) => x(bar.label))
    .attr('y', (bar) => y(Math.max(bar.start, bar.end)))
    .attr('width', x.bandwidth())
    .attr('height', (bar) => Math.max(1, Math.abs(y(bar.start) - y(bar.end))))
    .attr('rx', 2)
    .attr('fill', (bar) => bar.colour);
  interactive(rects, {
    d3, svg, hooks, colors,
    tip: (bar) => ({
      title: bar.kind === 'expense' ? `expenses:${bar.label}` : bar.label,
      rows: [
        { label: amountOf(bar.value, data.unit) },
        ...(bar.kind === 'expense' && data.income > 0 ? [{ label: `${percent(-bar.value, data.income)} of income` }] : []),
      ],
    }),
    account: (bar) => (bar.kind === 'income' ? 'income' : bar.kind === 'expense' ? `expenses:${bar.label}` : null),
    label: (bar) => `${bar.label}, ${amountOf(bar.value, data.unit)}`,
  });

  filled.forEach((bar, index) => {
    root.append('text')
      .attr('x', x(bar.label) + x.bandwidth() / 2).attr('y', y(Math.max(bar.start, bar.end)) - 5)
      .attr('text-anchor', 'middle').attr('fill', colors.foreground).attr('font-size', 11)
      .style('pointer-events', 'none').text(amountOf(bar.value, data.unit));
    root.append('text')
      .attr('x', x(bar.label) + x.bandwidth() / 2).attr('y', height - margin.bottom + 16)
      .attr('text-anchor', 'middle').attr('fill', colors.dim).attr('font-size', 11)
      .text(fit(bar.label, x.bandwidth() + 20));
    // A connector to the next bar, so the running total reads as one walk.
    const next = filled[index + 1];
    if (next && next.kind !== 'net') {
      root.append('line')
        .attr('x1', x(bar.label) + x.bandwidth()).attr('x2', x(next.label))
        .attr('y1', y(bar.end)).attr('y2', y(bar.end))
        .attr('stroke', colors.dim).attr('stroke-dasharray', '2 3');
    }
  });
  return {};
}

// ---------------------------------------------------------------- sparklines

/** One sparkline per account, largest first; hover a cell for its months. */
function drawMultiples(svg, data, colors, hooks) {
  const rows = data.rows;
  const columnsFor = (width) => (width > 720 ? 2 : 1);
  const { d3, width, root } = frame(svg, (width) => 16 + Math.ceil(Math.max(rows.length, 1) / columnsFor(width)) * 92);
  if (rows.length === 0) { nothing(root, colors); return {}; }
  const columns = columnsFor(width);
  const cellWidth = (width - 16) / columns;
  const cellHeight = 92;
  const colours = palette(colors, rows.length);

  const cells = rows.map((row, index) => ({ row, index, colour: colours[index % colours.length], x0: 8 + (index % columns) * cellWidth, y0: 8 + Math.floor(index / columns) * cellHeight }));
  for (const cell of cells) {
    const { row, x0, y0, colour } = cell;
    const plot = { left: x0 + 4, right: x0 + cellWidth - 14, top: y0 + 26, bottom: y0 + cellHeight - 12 };
    const values = row.amounts.map((amount) => amount.value);
    const low = Math.min(...values, 0);
    const high = Math.max(...values, 0);
    const x = d3.scalePoint().domain(values.map((_, at) => at)).range([plot.left, plot.right]);
    const y = d3.scaleLinear().domain([low, high === low ? high + 1 : high]).range([plot.bottom - 2, plot.top + 3]);
    const points = values.map((value, at) => [x(at), y(value)]);

    root.append('text').attr('x', x0 + 4).attr('y', y0 + 14)
      .attr('fill', colors.foreground).attr('font-size', 12)
      .text(fit(row.label, cellWidth - 110));
    root.append('text').attr('x', x0 + cellWidth - 14).attr('y', y0 + 14).attr('text-anchor', 'end')
      .attr('fill', colors.dim).attr('font-size', 11)
      .text(amountOf(row.total, data.unit));
    if (low < 0 && high > 0) {
      root.append('line').attr('x1', plot.left).attr('x2', plot.right).attr('y1', y(0)).attr('y2', y(0))
        .attr('stroke', colors.dim).attr('stroke-opacity', 0.35).attr('stroke-dasharray', '2 3');
    }
    root.append('path').attr('d', d3.line()(points))
      .attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 1.6);
    const last = points[points.length - 1];
    if (last) root.append('circle').attr('cx', last[0]).attr('cy', last[1]).attr('r', 2.4).attr('fill', colour);
  }
  const hits = root.append('g').selectAll('rect').data(cells).join('rect')
    .attr('x', (cell) => cell.x0).attr('y', (cell) => cell.y0)
    .attr('width', cellWidth - 6).attr('height', cellHeight - 4)
    .attr('rx', 4)
    .attr('fill', 'transparent');
  interactive(hits, {
    d3, svg, hooks, colors,
    tip: (cell) => ({
      title: cell.row.label,
      rows: data.periods.map((period, at) => ({ label: period, value: amountOf(cell.row.amounts[at]?.value || 0, data.unit) })).slice(-12),
    }),
    account: (cell) => (cell.row.label.startsWith('other (') ? null : cell.row.label),
    label: (cell) => `${cell.row.label}, ${amountOf(cell.row.total, data.unit)} over ${data.periods.length} periods`,
  });
  return {};
}

// ---------------------------------------------------------------- flows

/** Income flowing through one node into each kind of spending, and what was saved. */
function drawSankey(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  if (data.total <= 0) { nothing(root, colors, 'No income or spending to draw.'); return {}; }
  const unit = data.unit;
  const labelWidth = (nodes) => Math.min(width * 0.28, 18 + Math.max(...nodes.map((node) => Math.max(node.label.length, amountOf(node.value, unit).length))) * 6.6);
  const left = labelWidth(data.sources);
  const right = labelWidth(data.sinks);
  const layout = sankeyLayout(data, width, height, { left, right, top: 12, bottom: 12 });
  const sinks = layout.nodes.filter((node) => node.column === 2);
  const colours = palette(colors, Math.max(sinks.length, 1));
  const colourOf = new Map(sinks.map((node, index) => [node.label, node.kind === 'saved' ? colors.foreground : colours[index]]));
  const fillOf = (node) => (node.column === 0 ? (node.kind === 'drawn' ? colors.dim : colors.accent) : node.column === 1 ? colors.accent : colourOf.get(node.label));

  const links = root.append('g').selectAll('path').data(layout.links).join('path')
    .attr('d', (link) => link.path)
    .attr('fill', (link) => (colourOf.get(link.to) || colors.accent))
    .attr('fill-opacity', (link) => (colourOf.has(link.to) ? 0.42 : 0.3));
  const valueOf = (link) => (link.thickness / layout.scale);
  links
    .on('pointerenter pointermove', (event, link) => {
      const [x, y] = d3.pointer(event, svg);
      hooks.tip.show({ title: `${link.from} → ${link.to}`, rows: [{ label: amountOf(valueOf(link), unit) }] }, x, y);
      d3.select(event.currentTarget).attr('fill-opacity', 0.7);
    })
    .on('pointerleave', (event, link) => {
      hooks.tip.hide();
      d3.select(event.currentTarget).attr('fill-opacity', colourOf.has(link.to) ? 0.42 : 0.3);
    });

  const nodes = root.append('g').selectAll('rect').data(layout.nodes).join('rect')
    .attr('x', (node) => node.x).attr('y', (node) => node.y)
    .attr('width', (node) => node.w).attr('height', (node) => Math.max(1, node.h))
    .attr('rx', 2)
    .attr('fill', fillOf);
  interactive(nodes, {
    d3, svg, hooks, colors,
    tip: (node) => ({
      title: node.account || node.label,
      rows: [
        { label: amountOf(node.value, unit) },
        ...(node.kind === 'expense' || node.kind === 'saved' ? [{ label: `${percent(node.value, data.income || data.total)} of income` }] : []),
      ],
    }),
    account: (node) => (node.kind === 'hub' ? 'income' : node.account),
    label: (node) => `${node.account || node.label}, ${amountOf(node.value, unit)}`,
  });

  const labels = root.append('g').style('pointer-events', 'none');
  for (const node of layout.nodes) {
    const middle = node.y + node.h / 2;
    if (node.column === 1) {
      labels.append('text').attr('x', node.x + node.w / 2).attr('y', node.y - 4).attr('text-anchor', 'middle')
        .attr('fill', colors.dim).attr('font-size', 11).text(`income ${amountOf(data.income, unit)}`);
      continue;
    }
    const outside = node.column === 0 ? node.x - 8 : node.x + node.w + 8;
    const anchor = node.column === 0 ? 'end' : 'start';
    const room = node.column === 0 ? left - 12 : right - 12;
    labels.append('text').attr('x', outside).attr('y', middle).attr('dy', node.h > 26 ? '-0.2em' : '0.32em')
      .attr('text-anchor', anchor).attr('fill', colors.foreground).attr('font-size', 12)
      .text(fit(node.label, room));
    if (node.h > 26) {
      labels.append('text').attr('x', outside).attr('y', middle).attr('dy', '1.05em')
        .attr('text-anchor', anchor).attr('fill', colors.dim).attr('font-size', 11)
        .text(amountOf(node.value, unit));
    }
  }
  return {};
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}
