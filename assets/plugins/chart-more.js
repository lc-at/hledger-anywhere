/**
 * More charts: a heatmap of accounts by period, a bump chart of their ranks, a sunburst and a
 * circle pack of the account tree, a cash flow, a budget bullet chart, a beeswarm of purchases
 * and a histogram of their sizes.
 *
 * They draw from the same data the other charts do: the heatmap and the bump chart from the
 * balance model `modelFor` builds, the sunburst and the pack from the indented tree the treemap
 * reads, and the last four from what `viewMore` shapes out of hledger's report (balance,
 * balance --budget, register). The shaping is pure and checked in node; the drawing uses
 * chart-d3.js's frame, tooltip and keyboard conventions, so they behave like the rest: hover or
 * Tab to a mark for its numbers, click or Enter to chart that account over time.
 */

import { amountOf, fit, frame, groupsOf, interactive, nestTree, nothing, tick, valueScale } from './chart-d3.js';
import { counted, format, group, inOneCommodity, leftOutOf, palette, percent, seriesTotal, split } from './chart-data.js';
import { escape, mix } from './window-kit.js';

/** The kinds this module draws. */
export const MORE = ['heatmap', 'bump', 'sunburst', 'pack', 'cashflow', 'budget', 'swarm', 'histogram'];

/** The kinds whose numbers this module also shapes, from the report hledger returned. */
export const SHAPED = ['cashflow', 'budget', 'swarm', 'histogram'];

/** Draw a chart this module owns. */
export function renderMore(kind, svg, data, colors, hooks) {
  if (kind === 'heatmap') return drawHeatmap(svg, data, colors, hooks);
  if (kind === 'bump') return drawBump(svg, data, colors, hooks);
  if (kind === 'pack') return drawPack(svg, data, colors, hooks);
  if (kind === 'cashflow') return drawCashflow(svg, data, colors, hooks);
  if (kind === 'budget') return drawBudget(svg, data, colors, hooks);
  if (kind === 'swarm') return drawSwarm(svg, data, colors, hooks);
  if (kind === 'histogram') return drawHistogram(svg, data, colors, hooks);
  return drawSunburst(svg, data, colors, hooks);
}

// ---------------------------------------------------------------- reading and shaping

/** The second part of an account name, the category: Expenses:Food:Coffee is Food. */
export function categoryOf(account) {
  const parts = String(account).split(':');
  return parts.length > 1 ? parts[1] : parts[0];
}

/**
 * hledger's budget report: an actual and a budget column for each period, summed. Accounts
 * with no budget are left out, and so is "<unbudgeted>", since there is nothing to compare
 * them with; a journal with no budget at all is null, for the plugin to say how to set one.
 */
export function readBudget(text) {
  const rows = String(text == null ? '' : text).trim().split('\n').map(split);
  const start = rows.findIndex((cells) => (cells[0] || '').trim().toLowerCase() === 'account');
  if (start < 0) return null;
  const header = rows[start].map((cell) => cell.trim().toLowerCase());
  const pairs = [];
  header.forEach((name, index) => {
    if (index > 0 && name !== 'budget' && header[index + 1] === 'budget') pairs.push([index, index + 1, rows[start][index].trim()]);
  });
  const kept = [];
  for (const cells of rows.slice(start + 1)) {
    const label = (cells[0] || '').trim();
    if (!label || /^total:?$/i.test(label) || label.startsWith('<')) continue;
    kept.push({ label, cells: pairs.flatMap(([actual, budget]) => [cells[actual], cells[budget]]) });
  }
  if (!kept.length) return null;
  const { amounts, unit, others } = inOneCommodity(kept.flatMap((row) => row.cells));
  const width = pairs.length * 2;
  const entries = kept.map((row, index) => {
    const own = amounts.slice(index * width, (index + 1) * width);
    const actual = own.filter((_, at) => at % 2 === 0).reduce((sum, amount) => sum + amount.value, 0);
    const budget = own.filter((_, at) => at % 2 === 1).reduce((sum, amount) => sum + amount.value, 0);
    return { label: row.label, actual, budget, left: own.flatMap((amount) => amount.left || []) };
  }).filter((entry) => entry.budget > 0);
  if (!entries.length) return null;
  const periods = pairs.map(([, , name]) => name);
  return {
    rows: entries,
    unit,
    others: [...new Set(entries.flatMap((entry) => entry.left))].sort(),
    period: periods.length > 1 ? `${periods[0]} to ${periods[periods.length - 1]}` : periods[0],
    mixed: others,
  };
}

/**
 * The budget as the chart draws it: the top-level account, if the report has one, is the
 * total and is said rather than drawn; each other account's actual against its budget, the
 * furthest over first, or by name.
 */
export function budgetView(report, options = {}) {
  const depthOf = (label) => label.split(':').length;
  const top = Math.min(...report.rows.map((row) => depthOf(row.label)));
  const roots = report.rows.filter((row) => depthOf(row.label) === top);
  const total = roots.length === 1 && report.rows.length > 1 ? roots[0] : null;
  let rows = report.rows.filter((row) => row !== total).map((row) => ({ ...row, used: row.actual / row.budget }));
  rows.sort((left, right) => (options.sort === 'name' ? left.label.localeCompare(right.label) : right.used - left.used));
  if (options.top) rows = rows.slice(0, options.top);
  const actual = total ? total.actual : rows.reduce((sum, row) => sum + row.actual, 0);
  const budget = total ? total.budget : rows.reduce((sum, row) => sum + row.budget, 0);
  return { rows, unit: report.unit, actual, budget, period: report.period, over: rows.filter((row) => row.used > 1).length };
}

/**
 * Income against spending, period by period, from a balance report of both.
 *
 * Income is turned the right way up; each side keeps its largest accounts and folds the rest
 * into one "other", so a column has a handful of bands, not forty. `--cumulative` makes every
 * period the total so far, which turns the net into savings to date.
 */
export function cashflowOf(report, options = {}) {
  const income = [];
  const spending = [];
  for (const series of report.series) {
    const values = series.amounts.map((amount) => (amount ? amount.value : 0));
    if (/^(income|revenues?)(:|$)/i.test(series.label)) income.push({ label: series.label, values: values.map((value) => -value) });
    else if (/^expenses?(:|$)/i.test(series.label)) spending.push({ label: series.label, values });
  }
  const run = (values) => {
    let total = 0;
    return values.map((value) => (total += value));
  };
  if (options.cumulative) for (const entry of [...income, ...spending]) entry.values = run(entry.values);
  const keep = (list, count) => {
    const sorted = [...list].sort((left, right) => sum(right.values) - sum(left.values));
    if (sorted.length <= count + 1) return sorted;
    const rest = sorted.slice(count);
    return [...sorted.slice(0, count), { label: `other (${rest.length})`, values: report.periods.map((_, at) => sum(rest.map((entry) => entry.values[at]))), other: true }];
  };
  const kept = { income: keep(income, Math.min(options.top || 4, 4)), spending: keep(spending, options.top || 7) };
  const totalIn = report.periods.map((_, at) => sum(income.map((entry) => entry.values[at])));
  const totalOut = report.periods.map((_, at) => sum(spending.map((entry) => entry.values[at])));
  return {
    periods: report.periods,
    income: kept.income,
    spending: kept.spending,
    in: totalIn,
    out: totalOut,
    net: totalIn.map((value, at) => value - totalOut[at]),
    unit: report.unit,
    cumulative: Boolean(options.cumulative),
    others: leftOutOf(report.series.filter((series) => /^(income|revenues?|expenses?)(:|$)/i.test(series.label)).flatMap((series) => series.amounts)),
  };
}

function sum(values) {
  return values.reduce((total, value) => total + (value || 0), 0);
}

/**
 * The postings a swarm or a histogram draws: spending, one per posting, positive. A refund is
 * a negative posting and is left out, as it is from the calendar. The `limit` largest are kept,
 * and how many were left is said.
 */
export function transactionsOf(register, limit = Infinity) {
  const spending = register.postings.filter((posting) => /^expenses?(:|$)/i.test(posting.account));
  const chosen = (spending.length ? spending : register.postings)
    .filter((posting) => posting.amount.value > 0)
    .map((posting) => ({ date: posting.date, account: posting.account, description: posting.description, value: posting.amount.value }));
  const kept = [...chosen].sort((left, right) => right.value - left.value).slice(0, limit);
  return {
    points: kept.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : right.value - left.value)),
    total: sum(chosen.map((point) => point.value)),
    count: chosen.length,
    dropped: chosen.length - kept.length,
    unit: register.unit,
    others: leftOutOf((spending.length ? spending : register.postings).map((posting) => posting.amount)),
  };
}

/**
 * A beeswarm: each item has an `x` and a radius `r`, and is given the `y` nearest the centre
 * line where it touches nothing already placed. The largest are placed first, so they sit on
 * the line and the small ones settle around them. Pure, and deterministic.
 */
export function beeswarm(items, padding = 1) {
  const order = items.map((item, index) => index).sort((left, right) => items[right].r - items[left].r || items[left].x - items[right].x);
  const placed = [];
  const ys = new Array(items.length);
  for (const index of order) {
    const item = items[index];
    const near = placed.filter((other) => Math.abs(other.x - item.x) < other.r + item.r + padding);
    const reach = (other) => other.r + item.r + padding;
    const candidates = [0];
    for (const other of near) {
      const dx = other.x - item.x;
      const dy = Math.sqrt(Math.max(0, reach(other) ** 2 - dx * dx));
      candidates.push(other.y + dy, other.y - dy);
    }
    candidates.sort((left, right) => Math.abs(left) - Math.abs(right));
    const y = candidates.find((candidate) => near.every((other) => (other.x - item.x) ** 2 + (other.y - candidate) ** 2 >= reach(other) ** 2 - 1e-6));
    ys[index] = y;
    placed.push({ x: item.x, y, r: item.r });
  }
  return ys;
}

/**
 * Transaction sizes in bins four to a decade, 1 to 1.78 to 3.16 to 5.62 to 10: purchases span
 * orders of magnitude, so equal bins would put a coffee and a rent payment in the same one. Each
 * bin has its count and its total; with them, the share of the spending the largest few are.
 */
export function bins(values) {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (!positive.length) return { bins: [], count: 0, total: 0 };
  const step = (value) => Math.floor(Math.log10(value) * 4 + 1e-9);
  // The smallest one in a hundred share the first bin, "under" it, so a few rounding postings
  // of a fraction of a unit do not spread the axis across decades of nothing.
  const floor = positive.length >= 50 ? step(positive[Math.floor(positive.length / 100)]) : step(positive[0]);
  const first = Math.min(floor, step(positive[positive.length - 1]));
  const last = step(positive[positive.length - 1]);
  const out = [];
  for (let at = first; at <= last; at += 1) out.push({ lo: 10 ** (at / 4), hi: 10 ** ((at + 1) / 4), count: 0, total: 0 });
  if (step(positive[0]) < first) out[0].lo = 0;
  for (const value of positive) {
    const bin = out[Math.max(0, step(value) - first)];
    bin.count += 1;
    bin.total += value;
  }
  const total = sum(positive);
  const median = positive[Math.floor((positive.length - 1) / 2)];
  const tail = positive.slice(Math.floor(positive.length * 0.95));
  return { bins: out, count: positive.length, total, median, topShare: total ? sum(tail) / total : 0, topCount: tail.length };
}

/** A round amount for a bin edge: 17,782.79 is 18k, 1,000,000 is 1M. */
export function edge(value, unit) {
  return tick(Number(value.toPrecision(2)), unit);
}

// ---------------------------------------------------------------- the words for each

/**
 * What the window shows for a kind this module shapes: the data to draw, the subtitle, the
 * table, and how tall it wants to be. Called by the window and, for the subtitle, the plugin.
 */
export function viewMore(kind, report, options = {}) {
  if (kind === 'budget') {
    const data = budgetView(report, options);
    const used = data.budget ? data.actual / data.budget : 0;
    return {
      data,
      sub: `${data.period}: spent ${amountOf(data.actual, data.unit)} of ${amountOf(data.budget, data.unit)} budgeted (${Math.round(100 * used)}%); ${data.over} of ${counted(data.rows.length, 'account')} over`,
      table: table(['Account', 'Spent', 'Budget', 'Used'], data.rows.map((row) => [row.label, amountOf(row.actual, data.unit), amountOf(row.budget, data.unit), `${Math.round(100 * row.used)}%`])),
      height: Math.min(1100, 60 + data.rows.length * 34),
    };
  }
  if (kind === 'cashflow') {
    const data = cashflowOf(report, options);
    const totalIn = options.cumulative ? data.in[data.in.length - 1] : sum(data.in);
    const totalOut = options.cumulative ? data.out[data.out.length - 1] : sum(data.out);
    const net = totalIn - totalOut;
    const rate = totalIn > 0 ? `, ${percent(net, totalIn)} of income ${net >= 0 ? 'kept' : 'overspent'}` : '';
    return {
      data,
      sub: `${counted(data.periods.length, 'period')}: in ${amountOf(totalIn, data.unit)}, out ${amountOf(totalOut, data.unit)}, net ${amountOf(net, data.unit)}${rate}`,
      others: data.others,
      table: table(['Period', 'In', 'Out', 'Net'], data.periods.map((period, at) => [period, amountOf(data.in[at], data.unit), amountOf(data.out[at], data.unit), amountOf(data.net[at], data.unit)])),
      height: 440,
    };
  }
  if (kind === 'swarm') {
    const data = transactionsOf(report, options.top || 1500);
    const largest = [...data.points].sort((left, right) => right.value - left.value).slice(0, 25);
    const dropped = data.dropped ? `; the ${counted(data.points.length, 'largest')} drawn` : '';
    return {
      data,
      others: data.others,
      sub: `${counted(data.count, 'transaction')}, ${amountOf(data.total, data.unit)}${dropped}`,
      table: table(['Date', 'Description', 'Account', 'Amount'], largest.map((point) => [point.date, point.description, point.account, amountOf(point.value, data.unit)]), [3]),
      height: 420,
    };
  }
  const shaped = transactionsOf(report);
  const data = { ...bins(shaped.points.map((point) => point.value)), unit: shaped.unit };
  return {
    data,
    others: shaped.others,
    sub: data.count
      ? `${counted(data.count, 'transaction')}; half under ${amountOf(data.median, data.unit)}; the largest ${percent(data.topCount, data.count)} are ${percent(data.topShare, 1)} of the spending`
      : 'no transactions',
    table: table(['From', 'To', 'Transactions', 'Total'], data.bins.filter((bin) => bin.count).map((bin) => [edge(bin.lo, data.unit), edge(bin.hi, data.unit), group(bin.count, 0), amountOf(bin.total, data.unit)])),
    height: 380,
  };
}

/** A table; `numbers` are the columns aligned right, every one after the first by default. */
function table(head, rows, numbers = head.map((_, index) => index).slice(1)) {
  const right = (index) => (numbers.includes(index) ? ' class="n"' : '');
  const cell = (text, index) => `<td${right(index)}>${escape(text)}</td>`;
  return `<table><thead><tr>${head.map((name, index) => `<th${right(index)}>${escape(name)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- the pure parts

/**
 * How strongly a heatmap cell is coloured, 0 to 1, against the largest amount on the map.
 * With --log, by orders of magnitude instead, so a 20,000 coffee is not a blank square beside
 * a 14,000,000 rent.
 */
export function intensity(value, largest, log = false) {
  const size = Math.abs(value);
  if (!largest || !size) return 0;
  if (log) return Math.log10(1 + size) / Math.log10(1 + largest);
  return size / largest;
}

/**
 * Each series' rank in each period, 1 for the largest. A tie is broken by the order the
 * series came in, which is largest over the whole range first, so ranks never swap on a tie.
 */
export function ranks(series, periods) {
  const table = series.map(() => []);
  periods.forEach((_, at) => {
    const order = series
      .map((entry, index) => ({ index, value: entry.values[at] || 0 }))
      .sort((left, right) => right.value - left.value || left.index - right.index);
    order.forEach((entry, rank) => {
      table[entry.index][at] = rank + 1;
    });
  });
  return table;
}

// ---------------------------------------------------------------- heatmap

/** Accounts down, periods across, a square each, darker for more. */
function drawHeatmap(svg, model, colors, hooks) {
  const rows = model.series;
  const left = Math.min(260, 16 + Math.max(...rows.map((row) => row.label.length), 4) * 6.4);
  const cellHeight = 20;
  const top = 28;
  const { d3, width, root } = frame(svg, () => top + rows.length * cellHeight + 30);
  if (rows.length === 0 || !model.periods.length) { nothing(root, colors); return {}; }
  const count = model.periods.length;
  const cellWidth = Math.max(4, (width - left - 12) / count);
  const unit = model.unit;
  const largest = Math.max(...rows.flatMap((row) => row.values.map(Math.abs)), 0);
  const empty = mix(colors.background, colors.dim, 12);
  const colour = (value) => {
    if (!value) return empty;
    const strength = intensity(value, largest, model.log);
    // Below zero is the foreground's ramp, so a refund or an income reads as the other way.
    return mix(colors.background, value < 0 ? colors.foreground : colors.accent, 16 + Math.round(84 * strength));
  };

  // Period labels across the top, thinned to what fits.
  const widest = Math.max(...model.periods.map((period) => period.length)) * 6.6 + 10;
  const every = Math.max(1, Math.ceil(widest / cellWidth));
  model.periods.forEach((period, at) => {
    if (at % every) return;
    root.append('text').attr('x', left + at * cellWidth).attr('y', top - 10)
      .attr('fill', colors.dim).attr('font-size', 11).text(period);
  });
  rows.forEach((row, index) => {
    root.append('text').attr('x', left - 8).attr('y', top + index * cellHeight + cellHeight / 2).attr('dy', '0.32em')
      .attr('text-anchor', 'end').attr('fill', colors.foreground).attr('font-size', 11)
      .text(fit(row.label, left - 12));
  });

  const cells = rows.flatMap((row, index) => model.periods.map((period, at) => ({ row, index, at, period, value: row.values[at] || 0 })));
  const squares = root.append('g').selectAll('rect').data(cells).join('rect')
    .attr('x', (cell) => left + cell.at * cellWidth + 1)
    .attr('y', (cell) => top + cell.index * cellHeight + 1)
    .attr('width', Math.max(1, cellWidth - 2))
    .attr('height', cellHeight - 2)
    .attr('rx', 2)
    .attr('fill', (cell) => colour(cell.value));
  interactive(squares.filter((cell) => cell.value !== 0), {
    d3, svg, hooks, colors,
    tip: (cell) => ({ title: `${cell.row.label}, ${cell.period}`, rows: [{ label: amountOf(cell.value, unit) }] }),
    account: (cell) => (model.drillable && !cell.row.other ? cell.row.label : null),
    label: (cell) => `${cell.row.label}, ${cell.period}, ${amountOf(cell.value, unit)}`,
  });
  root.append('text').attr('x', left).attr('y', top + rows.length * cellHeight + 18)
    .attr('fill', colors.dim).attr('font-size', 11)
    .text(`darker for more; the darkest is ${amountOf(largest, unit)}${model.log ? ', on a log scale' : ''}`);
  return {};
}

// ---------------------------------------------------------------- bump

/** Each account's rank, period by period, joined into lines that cross where one overtakes. */
function drawBump(svg, model, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  const series = model.series.filter((entry) => !entry.other);
  if (series.length === 0 || model.periods.length < 2) { nothing(root, colors, 'A bump chart needs at least two periods.'); return {}; }
  const table = ranks(series, model.periods);
  const right = Math.min(240, 24 + Math.max(...series.map((entry) => entry.label.length)) * 6.4);
  const margin = { top: 16, bottom: 28, left: 40 };
  const x = d3.scalePoint().domain(d3.range(model.periods.length)).range([margin.left, width - right]);
  const y = d3.scalePoint().domain(d3.range(1, series.length + 1)).range([margin.top, height - margin.bottom]);
  const unit = model.unit;

  for (let rank = 1; rank <= series.length; rank += 1) {
    root.append('text').attr('x', margin.left - 14).attr('y', y(rank)).attr('dy', '0.32em')
      .attr('text-anchor', 'end').attr('fill', colors.dim).attr('font-size', 11).text(`#${rank}`);
  }
  const widest = Math.max(...model.periods.map((period) => period.length)) * 6.6 + 10;
  const every = Math.max(1, Math.ceil(widest / Math.max(1, x.step())));
  model.periods.forEach((period, at) => {
    if (at % every) return;
    root.append('text').attr('x', x(at)).attr('y', height - margin.bottom + 18).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(period);
  });

  const line = d3.line().curve(d3.curveBumpX);
  series.forEach((entry, index) => {
    const points = model.periods.map((_, at) => [x(at), y(table[index][at])]);
    root.append('path').attr('d', line(points)).attr('fill', 'none')
      .attr('stroke', entry.colour).attr('stroke-width', 2.5).attr('stroke-opacity', 0.9);
    const last = points[points.length - 1];
    root.append('text').attr('x', last[0] + 10).attr('y', last[1]).attr('dy', '0.32em')
      .attr('fill', entry.colour).attr('font-size', 11).text(fit(entry.label, right - 16));
  });
  const dots = series.flatMap((entry, index) => model.periods.map((period, at) => ({ entry, period, at, rank: table[index][at], value: entry.values[at] || 0 })));
  const marks = root.append('g').selectAll('circle').data(dots).join('circle')
    .attr('cx', (dot) => x(dot.at)).attr('cy', (dot) => y(dot.rank)).attr('r', 5)
    .attr('fill', (dot) => dot.entry.colour).attr('stroke', colors.background).attr('stroke-width', 1.5);
  interactive(marks, {
    d3, svg, hooks, colors,
    tip: (dot) => ({ title: dot.period, rows: [{ colour: dot.entry.colour, label: `#${dot.rank} ${dot.entry.label}`, value: amountOf(dot.value, unit) }] }),
    account: (dot) => (model.drillable ? dot.entry.label : null),
    label: (dot) => `${dot.entry.label}, ${dot.period}, rank ${dot.rank}, ${amountOf(dot.value, unit)}`,
  });
  return {};
}

// ---------------------------------------------------------------- sunburst

/**
 * The account tree in rings: the root in the middle, each level a ring further out, each
 * account's angle its share of its parent. In an animation `fill` shrinks the radius with the
 * period's total, as the treemap shrinks its area.
 */
function drawSunburst(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  const hierarchy = d3.hierarchy(nestTree(data.rows)).sum((node) => node.value || 0);
  if (!(hierarchy.value > 0)) { nothing(root, colors); return {}; }
  const fill = data.fill === undefined ? 1 : Math.max(0.02, Math.min(1, data.fill));
  const outer = (Math.min(width, height) / 2 - 8) * Math.sqrt(fill);
  const partitioned = d3.partition().size([2 * Math.PI, hierarchy.height + 1])(hierarchy);
  // A lone top-level account, such as Expenses in a query for it, would be a ring that is the
  // whole circle; it is the centre instead, which already says its total.
  const skip = (partitioned.children || []).length === 1 && hierarchy.height > 1 ? 1 : 0;
  const ring = outer / (hierarchy.height + 1 - skip);
  const { groupOf, order } = groupsOf(partitioned);
  const colours = palette(colors, Math.max(order.size, 1));
  const path = (node) => node.ancestors().reverse().map((entry) => entry.data.name).filter(Boolean).join(':');
  const total = partitioned.value;
  const arc = d3.arc()
    .startAngle((node) => node.x0).endAngle((node) => node.x1)
    .padAngle((node) => Math.min((node.x1 - node.x0) / 2, 0.004))
    .innerRadius((node) => (node.y0 - skip) * ring).outerRadius((node) => (node.y1 - skip) * ring - 1);
  const centre = root.append('g').attr('transform', `translate(${width / 2},${height / 2})`);
  const shown = partitioned.descendants().filter((node) => node.depth > skip && node.value > 0);
  // A ring is its branch's colour, found from its first leaf, so a parent and its children
  // match; a ring that holds every branch, as a lone top-level account does, is the dim colour.
  // Deeper rings are fainter rather than mixed, since the theme's palette is written in a
  // syntax colour interpolation does not read.
  const shade = (node) => {
    const group = order.get(groupOf(node.leaves()[0]));
    return group === undefined ? colors.dim : colours[group % colours.length];
  };
  const arcs = centre.selectAll('path').data(shown).join('path')
    .attr('d', arc).attr('fill', shade)
    .attr('fill-opacity', (node) => Math.max(0.45, 1 - 0.18 * (node.depth - 1 - skip)))
    .attr('stroke', colors.background).attr('stroke-width', 0.8);
  interactive(arcs, {
    d3, svg, hooks, colors,
    tip: (node) => ({ title: path(node), rows: [{ label: amountOf(node.value, data.unit), value: `${percent(node.value, total)} of the total` }] }),
    account: (node) => path(node),
    label: (node) => `${path(node)}, ${amountOf(node.value, data.unit)}, ${percent(node.value, total)}`,
  });
  // Names on the arcs wide and long enough to hold them, turned to read outwards.
  centre.append('g').style('pointer-events', 'none').selectAll('text')
    .data(shown.filter((node) => (node.x1 - node.x0) * ((node.y0 + node.y1) / 2 - skip) * ring > 14 && ring > 34)).join('text')
    .attr('transform', (node) => {
      const angle = ((node.x0 + node.x1) / 2) * (180 / Math.PI);
      const radius = ((node.y0 + node.y1) / 2 - skip) * ring;
      return `rotate(${angle - 90}) translate(${radius},0) rotate(${angle < 180 ? 0 : 180})`;
    })
    .attr('text-anchor', 'middle').attr('dy', '0.32em').attr('fill', colors.background).attr('font-size', 10)
    .text((node) => fit(node.data.name, ring - 6));
  centre.append('text').attr('text-anchor', 'middle').attr('dy', '0.32em')
    .attr('fill', colors.foreground).attr('font-size', Math.max(10, Math.min(16, ring / 5)))
    .style('pointer-events', 'none').text(amountOf(total, data.unit));
  return {};
}

// ---------------------------------------------------------------- shared drawing

/** Period labels under a band scale, as many as fit without touching. */
function periodAxis(root, x, periods, y, colors) {
  const widest = Math.max(...periods.map((period) => period.length)) * 6.6 + 10;
  const every = Math.max(1, Math.ceil(widest / Math.max(1, x.step())));
  periods.forEach((period, at) => {
    if (at % every) return;
    root.append('text').attr('x', x(at) + x.bandwidth() / 2).attr('y', y).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(period);
  });
}

/** A value axis down the left, with gridlines, from a scale and its ticks. */
function valueAxis(root, scale, ticks, left, right, unit, colors) {
  for (const value of ticks) {
    root.append('line').attr('x1', left).attr('x2', right).attr('y1', scale(value)).attr('y2', scale(value))
      .attr('stroke', colors.dim).attr('stroke-opacity', value === 0 ? 0.6 : 0.2);
    root.append('text').attr('x', left - 8).attr('y', scale(value)).attr('dy', '0.32em').attr('text-anchor', 'end')
      .attr('fill', colors.dim).attr('font-size', 11).text(tick(value, unit));
  }
}

// ---------------------------------------------------------------- cash flow

/**
 * Income above the line, spending below it, a column each per period, and the net as a line
 * with a dot per period: green-side when kept, the other side when overspent.
 */
function drawCashflow(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  if (!data.periods.length || (!data.income.length && !data.spending.length)) {
    nothing(root, colors, 'No income or expense accounts in this report.');
    return {};
  }
  const unit = data.unit;
  const high = Math.max(0, ...data.in, ...data.net);
  const low = Math.min(0, ...data.out.map((value) => -value), ...data.net);
  const margin = { top: 14, right: 14, bottom: 30, left: 12 };
  const count = Math.max(2, Math.floor((height - margin.top - margin.bottom) / 46));
  const { scale: y, ticks } = valueScale(d3, false, low, high, [height - margin.bottom, margin.top], count);
  margin.left = 14 + Math.max(...ticks.map((value) => tick(value, unit).length)) * 6.6;
  const x = d3.scaleBand().domain(d3.range(data.periods.length)).range([margin.left, width - margin.right]).paddingInner(0.25).paddingOuter(0.1);
  valueAxis(root, y, ticks, margin.left, width - margin.right, unit, colors);

  const inColours = data.income.map((_, index) => mix(colors.background, colors.accent, 100 - index * 18));
  const outColours = palette(colors, Math.max(data.spending.length, 1));
  const bands = [];
  data.periods.forEach((period, at) => {
    let up = 0;
    data.income.forEach((entry, index) => {
      const value = Math.max(0, entry.values[at] || 0);
      if (value) bands.push({ entry, period, at, value, from: up, to: up + value, colour: inColours[index], side: 'in' });
      up += value;
    });
    let down = 0;
    data.spending.forEach((entry, index) => {
      const value = Math.max(0, entry.values[at] || 0);
      if (value) bands.push({ entry, period, at, value, from: -down, to: -down - value, colour: entry.other ? colors.dim : outColours[index], side: 'out' });
      down += value;
    });
  });
  const rects = root.append('g').selectAll('rect').data(bands).join('rect')
    .attr('x', (band) => x(band.at)).attr('width', x.bandwidth())
    .attr('y', (band) => y(Math.max(band.from, band.to))).attr('height', (band) => Math.max(0.5, Math.abs(y(band.from) - y(band.to))))
    .attr('fill', (band) => band.colour).attr('stroke', colors.background).attr('stroke-width', 0.5);
  interactive(rects, {
    d3, svg, hooks, colors,
    tip: (band) => ({
      title: `${band.period}, ${band.side === 'in' ? 'in' : 'out'}`,
      rows: [
        { colour: band.colour, label: band.entry.label, value: amountOf(band.value, unit) },
        { label: 'net', value: amountOf(data.net[band.at], unit) },
      ],
    }),
    account: (band) => (band.entry.other ? null : band.entry.label),
    label: (band) => `${band.entry.label}, ${band.period}, ${amountOf(band.value, unit)}`,
  });

  const middle = (at) => x(at) + x.bandwidth() / 2;
  root.append('path').attr('d', d3.line().curve(d3.curveMonotoneX)(data.net.map((value, at) => [middle(at), y(value)])))
    .attr('fill', 'none').attr('stroke', colors.foreground).attr('stroke-width', 2).style('pointer-events', 'none');
  const dots = root.append('g').selectAll('circle').data(data.net.map((value, at) => ({ value, at }))).join('circle')
    .attr('cx', (dot) => middle(dot.at)).attr('cy', (dot) => y(dot.value)).attr('r', 4)
    .attr('fill', (dot) => (dot.value >= 0 ? colors.foreground : colors.background))
    .attr('stroke', colors.foreground).attr('stroke-width', 2);
  interactive(dots, {
    d3, svg, hooks, colors,
    tip: (dot) => ({
      title: `${data.periods[dot.at]}${data.cumulative ? ', so far' : ''}`,
      rows: [
        { label: 'in', value: amountOf(data.in[dot.at], unit) },
        { label: 'out', value: amountOf(data.out[dot.at], unit) },
        { label: 'net', value: amountOf(dot.value, unit) },
        ...(data.in[dot.at] > 0 ? [{ label: dot.value >= 0 ? 'kept' : 'overspent', value: percent(Math.abs(dot.value), data.in[dot.at]) }] : []),
      ],
    }),
    account: () => null,
    label: (dot) => `${data.periods[dot.at]}, net ${amountOf(dot.value, unit)}`,
  });
  periodAxis(root, x, data.periods, height - margin.bottom + 18, colors);
  root.append('text').attr('x', margin.left + 4).attr('y', margin.top + 10).attr('fill', colors.dim).attr('font-size', 11).text('in ↑');
  root.append('text').attr('x', margin.left + 4).attr('y', height - margin.bottom - 6).attr('fill', colors.dim).attr('font-size', 11).text('out ↓ · line: net');
  return {};
}

// ---------------------------------------------------------------- budget

/**
 * A bullet chart: for each account, the budget as a pale track to its full length, what was
 * spent as a bar over it, and a tick at the budget, so over-budget is a bar running past the
 * tick. Bars over budget are drawn in the foreground colour, the others in the accent.
 */
function drawBudget(svg, data, colors, hooks) {
  const rowHeight = 34;
  const { d3, width, root } = frame(svg, () => 30 + data.rows.length * rowHeight + 30);
  if (!data.rows.length) { nothing(root, colors, 'No budgeted accounts in this report.'); return {}; }
  const unit = data.unit;
  const left = Math.min(width * 0.35, 16 + Math.max(...data.rows.map((row) => row.label.length)) * 6.4);
  const right = 70;
  const largest = Math.max(...data.rows.map((row) => Math.max(row.actual, row.budget)));
  const x = d3.scaleLinear().domain([0, largest]).nice().range([left, width - right]);
  const top = 10;
  for (const value of x.ticks(Math.max(2, Math.floor((width - left - right) / 110)))) {
    root.append('line').attr('x1', x(value)).attr('x2', x(value)).attr('y1', top).attr('y2', top + data.rows.length * rowHeight)
      .attr('stroke', colors.dim).attr('stroke-opacity', 0.18);
    root.append('text').attr('x', x(value)).attr('y', top + data.rows.length * rowHeight + 16).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(tick(value, unit));
  }
  const track = mix(colors.background, colors.dim, 28);
  const rows = root.append('g').selectAll('g').data(data.rows).join('g')
    .attr('transform', (_, index) => `translate(0,${top + index * rowHeight})`);
  rows.append('rect').attr('x', left).attr('y', 6).attr('height', rowHeight - 12)
    .attr('width', (row) => Math.max(1, x(row.budget) - left)).attr('fill', track).attr('rx', 2);
  const bars = rows.append('rect').attr('x', left).attr('y', 11).attr('height', rowHeight - 22)
    .attr('width', (row) => Math.max(1, x(Math.max(0, row.actual)) - left)).attr('rx', 2)
    .attr('fill', (row) => (row.used > 1 ? colors.foreground : colors.accent));
  rows.append('line').attr('x1', (row) => x(row.budget)).attr('x2', (row) => x(row.budget)).attr('y1', 3).attr('y2', rowHeight - 3)
    .attr('stroke', colors.foreground).attr('stroke-width', 2);
  rows.append('text').attr('x', left - 8).attr('y', rowHeight / 2).attr('dy', '0.32em').attr('text-anchor', 'end')
    .attr('fill', colors.foreground).attr('font-size', 11).text((row) => fit(row.label, left - 12));
  rows.append('text').attr('x', width - right + 8).attr('y', rowHeight / 2).attr('dy', '0.32em')
    .attr('fill', (row) => (row.used > 1 ? colors.foreground : colors.dim)).attr('font-size', 11).attr('font-weight', (row) => (row.used > 1 ? 600 : null))
    .text((row) => `${Math.round(100 * row.used)}%`);
  interactive(bars, {
    d3, svg, hooks, colors,
    tip: (row) => ({
      title: row.label,
      rows: [
        { label: 'spent', value: amountOf(row.actual, unit) },
        { label: 'budget', value: amountOf(row.budget, unit) },
        { label: row.actual > row.budget ? 'over by' : 'left', value: amountOf(Math.abs(row.budget - row.actual), unit) },
      ],
    }),
    account: (row) => row.label,
    label: (row) => `${row.label}, spent ${amountOf(row.actual, unit)} of ${amountOf(row.budget, unit)}, ${Math.round(100 * row.used)}%`,
  });
  return {};
}

// ---------------------------------------------------------------- swarm

/**
 * Every transaction as a dot along time, its area its amount, settled into a beeswarm so none
 * hides another. Colour is the category. The eye goes to the big ones, which is the point: the
 * three purchases that were a third of a month's spending.
 */
function drawSwarm(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  if (!data.points.length) { nothing(root, colors, 'No transactions to draw.'); return {}; }
  const unit = data.unit;
  const margin = { top: 12, right: 16, bottom: 28, left: 16 };
  const dates = data.points.map((point) => new Date(`${point.date}T00:00:00`));
  const x = d3.scaleTime().domain(d3.extent(dates)).range([margin.left + 8, width - margin.right - 8]);
  if (dates[0].getTime() === dates[dates.length - 1].getTime()) x.domain([d3.timeDay.offset(dates[0], -1), d3.timeDay.offset(dates[0], 1)]);
  const largest = Math.max(...data.points.map((point) => point.value));
  const room = height - margin.top - margin.bottom;
  // The largest dot is a share of the room; a swarm that would not fit is drawn smaller.
  let rMax = Math.max(6, Math.min(28, room / 9));
  let ys = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const r = d3.scaleSqrt().domain([0, largest]).range([0, rMax]);
    const items = data.points.map((point, index) => ({ x: x(dates[index]), r: Math.max(1.5, r(point.value)) }));
    ys = beeswarm(items, 0.6);
    const reach = Math.max(...ys.map((y, index) => Math.abs(y) + items[index].r));
    if (reach <= room / 2) break;
    rMax *= Math.max(0.5, Math.sqrt((room / 2) / reach));
  }
  const r = d3.scaleSqrt().domain([0, largest]).range([0, rMax]);
  const categories = [...new Set([...data.points].sort((left, right) => right.value - left.value).map((point) => categoryOf(point.account)))];
  const colours = palette(colors, Math.max(categories.length, 1));
  const colourOf = (point) => colours[categories.indexOf(categoryOf(point.account)) % colours.length];
  const centre = margin.top + room / 2;
  root.append('line').attr('x1', margin.left).attr('x2', width - margin.right).attr('y1', centre).attr('y2', centre)
    .attr('stroke', colors.dim).attr('stroke-opacity', 0.25);
  for (const date of x.ticks(Math.max(2, Math.floor(width / 110)))) {
    root.append('text').attr('x', x(date)).attr('y', height - margin.bottom + 18).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(x.tickFormat()(date));
  }
  const dots = root.append('g').selectAll('circle').data(data.points).join('circle')
    .attr('cx', (_, index) => x(dates[index])).attr('cy', (_, index) => centre + ys[index])
    .attr('r', (point) => Math.max(1.5, r(point.value)))
    .attr('fill', colourOf).attr('fill-opacity', 0.85).attr('stroke', colors.background).attr('stroke-width', 0.6);
  interactive(dots, {
    d3, svg, hooks, colors,
    tip: (point) => ({ title: `${point.date} ${point.description}`, rows: [{ colour: colourOf(point), label: point.account, value: amountOf(point.value, unit) }] }),
    account: (point) => point.account,
    label: (point) => `${point.date}, ${point.description}, ${point.account}, ${amountOf(point.value, unit)}`,
  });
  return {};
}

// ---------------------------------------------------------------- histogram

/** How many transactions of each size, in log bins; the line is what each bin added up to. */
function drawHistogram(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  if (!data.bins.length) { nothing(root, colors, 'No transactions to count.'); return {}; }
  const unit = data.unit;
  const margin = { top: 14, right: 60, bottom: 30, left: 46 };
  const x = d3.scaleBand().domain(d3.range(data.bins.length)).range([margin.left, width - margin.right]).paddingInner(0.08);
  const y = d3.scaleLinear().domain([0, Math.max(...data.bins.map((bin) => bin.count))]).nice().range([height - margin.bottom, margin.top]);
  const money = d3.scaleLinear().domain([0, Math.max(...data.bins.map((bin) => bin.total))]).nice().range([height - margin.bottom, margin.top]);
  for (const value of y.ticks(5)) {
    root.append('line').attr('x1', margin.left).attr('x2', width - margin.right).attr('y1', y(value)).attr('y2', y(value))
      .attr('stroke', colors.dim).attr('stroke-opacity', value ? 0.2 : 0.6);
    root.append('text').attr('x', margin.left - 8).attr('y', y(value)).attr('dy', '0.32em').attr('text-anchor', 'end')
      .attr('fill', colors.dim).attr('font-size', 11).text(group(value, 0));
  }
  for (const value of money.ticks(5)) {
    root.append('text').attr('x', width - margin.right + 8).attr('y', money(value)).attr('dy', '0.32em')
      .attr('fill', colors.foreground).attr('fill-opacity', 0.7).attr('font-size', 11).text(tick(value, unit));
  }
  const bars = root.append('g').selectAll('rect').data(data.bins).join('rect')
    .attr('x', (_, at) => x(at)).attr('width', x.bandwidth())
    .attr('y', (bin) => y(bin.count)).attr('height', (bin) => y(0) - y(bin.count))
    .attr('fill', colors.accent).attr('rx', 1.5);
  interactive(bars.filter((bin) => bin.count > 0), {
    d3, svg, hooks, colors,
    tip: (bin) => ({
      title: `${edge(bin.lo, unit)} to ${edge(bin.hi, unit)}`,
      rows: [
        { label: 'transactions', value: `${group(bin.count, 0)} (${percent(bin.count, data.count)})` },
        { label: 'total', value: `${amountOf(bin.total, unit)} (${percent(bin.total, data.total)})` },
      ],
    }),
    account: () => null,
    label: (bin) => `${edge(bin.lo, unit)} to ${edge(bin.hi, unit)}: ${bin.count} transactions, ${amountOf(bin.total, unit)}`,
  });
  root.append('path').attr('d', d3.line().curve(d3.curveMonotoneX)(data.bins.map((bin, at) => [x(at) + x.bandwidth() / 2, money(bin.total)])))
    .attr('fill', 'none').attr('stroke', colors.foreground).attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3').style('pointer-events', 'none');
  // A label at each decade, which is where the bins start a new power of ten.
  data.bins.forEach((bin, at) => {
    // The first bin may start at nothing, "under" its top; it has no decade to name.
    if (!(bin.lo > 0)) return;
    const decade = Math.log10(bin.lo);
    if (Math.abs(decade - Math.round(decade)) > 1e-6) return;
    root.append('text').attr('x', x(at)).attr('y', height - margin.bottom + 18).attr('text-anchor', 'middle')
      .attr('fill', colors.dim).attr('font-size', 11).text(edge(bin.lo, unit));
  });
  root.append('text').attr('x', margin.left).attr('y', margin.top - 2).attr('fill', colors.dim).attr('font-size', 11).text('bars: how many');
  root.append('text').attr('x', width - margin.right).attr('y', margin.top - 2).attr('text-anchor', 'end').attr('fill', colors.dim).attr('font-size', 11).text('dashed: how much');
  return {};
}

// ---------------------------------------------------------------- pack

/** The account tree as circles inside circles, a leaf's area its balance. */
function drawPack(svg, data, colors, hooks) {
  const { d3, width, height, root } = frame(svg);
  const hierarchy = d3.hierarchy(nestTree(data.rows)).sum((node) => node.value || 0).sort((left, right) => right.value - left.value);
  if (!(hierarchy.value > 0)) { nothing(root, colors); return {}; }
  const fill = data.fill === undefined ? 1 : Math.max(0.02, Math.min(1, data.fill));
  const side = Math.min(width, height) * Math.sqrt(fill);
  const packed = d3.pack().size([side, side]).padding(3)(hierarchy);
  const { groupOf, order } = groupsOf(packed);
  const colours = palette(colors, Math.max(order.size, 1));
  const colourOf = (node) => {
    const group = order.get(groupOf(node.leaves()[0]));
    return group === undefined ? colors.dim : colours[group % colours.length];
  };
  const path = (node) => node.ancestors().reverse().map((entry) => entry.data.name).filter(Boolean).join(':');
  const total = packed.value;
  const shown = packed.descendants().filter((node) => node.depth > 0 && node.value > 0);
  const centre = root.append('g').attr('transform', `translate(${(width - side) / 2},${(height - side) / 2})`);
  const circles = centre.selectAll('circle').data(shown).join('circle')
    .attr('cx', (node) => node.x).attr('cy', (node) => node.y).attr('r', (node) => node.r)
    .attr('fill', (node) => (node.children ? 'none' : colourOf(node)))
    .attr('fill-opacity', 0.85)
    .attr('stroke', (node) => (node.children ? colourOf(node) : colors.background))
    .attr('stroke-opacity', (node) => (node.children ? 0.7 : 1))
    .attr('stroke-width', (node) => (node.children ? 1.5 : 0.8));
  interactive(circles, {
    d3, svg, hooks, colors,
    tip: (node) => ({ title: path(node), rows: [{ label: amountOf(node.value, data.unit), value: `${percent(node.value, total)} of the total` }] }),
    account: (node) => path(node),
    label: (node) => `${path(node)}, ${amountOf(node.value, data.unit)}, ${percent(node.value, total)}`,
  });
  centre.append('g').style('pointer-events', 'none').selectAll('text')
    .data(shown.filter((node) => !node.children && node.r > 20)).join('text')
    .attr('x', (node) => node.x).attr('y', (node) => node.y).attr('text-anchor', 'middle').attr('dy', '0.32em')
    .attr('fill', colors.background).attr('font-size', (node) => Math.min(13, Math.max(9, node.r / 4)))
    .text((node) => fit(node.data.name, node.r * 1.8));
  // A parent's name on the top of its ring, where its children leave room.
  centre.append('g').style('pointer-events', 'none').selectAll('text')
    .data(shown.filter((node) => node.children && node.r > 40)).join('text')
    .attr('x', (node) => node.x).attr('y', (node) => node.y - node.r + 13).attr('text-anchor', 'middle')
    .attr('fill', colors.foreground).attr('font-size', 11).text((node) => fit(node.data.name, node.r));
  return {};
}
