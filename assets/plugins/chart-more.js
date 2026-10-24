/**
 * Three more charts: a heatmap of accounts by period, a bump chart of their ranks, and a
 * sunburst of the account tree.
 *
 * They draw from the same data the other charts do: the heatmap and the bump chart from the
 * balance model `modelFor` builds (series per account, values per period), the sunburst from the
 * indented tree the treemap reads. They use chart-d3.js's frame, tooltip and keyboard
 * conventions, so they behave like the rest: hover or Tab to a mark for its numbers, click or
 * Enter to chart that account over time.
 */

import { amountOf, fit, frame, groupsOf, interactive, nestTree, nothing } from './chart-d3.js';
import { palette, percent } from './chart-data.js';
import { mix } from './window-kit.js';

/** The kinds this module draws. */
export const MORE = ['heatmap', 'bump', 'sunburst'];

/** Draw a chart this module owns. */
export function renderMore(kind, svg, data, colors, hooks) {
  if (kind === 'heatmap') return drawHeatmap(svg, data, colors, hooks);
  if (kind === 'bump') return drawBump(svg, data, colors, hooks);
  return drawSunburst(svg, data, colors, hooks);
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
