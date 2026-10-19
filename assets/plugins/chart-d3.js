/**
 * The charts D3 draws, and the parsing and arithmetic behind them.
 *
 * The window is a `blob:` document, so D3 arrives as the vendored UMD build in a classic
 * script and is read from `window.d3`. Everything that does not need the DOM — the register
 * and tree parsers, the aggregations, the table and the headline — is exported and tested in
 * node, the way the Chart.js chart's parser is.
 *
 * The charts are: a treemap of where the money went, a calendar of daily spending, a
 * waterfall from income to net, and small multiples of every account over time. They share
 * one palette, one tooltip convention (`<title>` on each mark, so there is nothing to
 * position) and one table, which is the accessible rendering of each.
 */

import { format, mix, money, palette, split, unitOf } from './chart-data.js';

/** The kinds this module draws. Everything else is Chart.js. */
export const KINDS = ['treemap', 'calendar', 'waterfall', 'multiples'];

export function isD3Kind(kind) {
  return KINDS.includes(kind);
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
 *   "  food","$98.90"
 *   "    coffee","$12.50"
 *
 * The hierarchy is the indentation, two spaces a level, and a label can carry several
 * segments at once: `housing:rent` is one row because hledger elides a chain with no siblings.
 * `depth`, `label` and the amount are all a caller needs to rebuild the tree.
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
    // Two spaces a level; a tab is treated as one level, which is what hledger writes.
    const indent = raw.length - raw.replace(/^[ \t]+/, '').length;
    const depth = raw.startsWith('\t') ? 1 : Math.floor(indent / 2);
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

// --------------------------------------------------------------------------- the words

/** The line under the heading. */
export function headlineFor(kind, data) {
  if (kind === 'treemap') {
    const leaves = data.rows.filter((row, index) => {
      const next = data.rows[index + 1];
      return !next || next.depth <= row.depth;
    }).length;
    return `${leaves} accounts, ${format({ value: data.total, ...data.unit })} at the leaves`;
  }
  if (kind === 'calendar') {
    if (data.days.length === 0) return 'no spending in the register';
    return `${data.days.length} days of spending, ${format({ value: data.total, ...data.unit })}`;
  }
  if (kind === 'waterfall') {
    return `income ${format({ value: data.income, ...data.unit })}, spent ${format({
      value: data.spent,
      ...data.unit,
    })}, net ${format({ value: data.net, ...data.unit })}`;
  }
  return `${data.rows.length} accounts, ${data.periods.length} periods`;
}

/** The same data as a table, which is what a screen reader gets. */
export function tableFor(kind, data) {
  if (kind === 'treemap') {
    const rows = data.rows
      .map(
        (row) =>
          `<tr><td>${'&nbsp;'.repeat(row.depth * 3)}${escape(row.label)}</td><td class="n">${escape(
            format(row.amount),
          )}</td></tr>`,
      )
      .join('');
    return `<table><thead><tr><th>Account</th><th class="n">Balance</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (kind === 'calendar') {
    const rows = data.days
      .map(
        (day) =>
          `<tr><td>${escape(day.date)}</td><td class="n">${escape(
            format({ value: day.value, ...data.unit }),
          )}</td></tr>`,
      )
      .join('');
    return `<table><thead><tr><th>Day</th><th class="n">Spent</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (kind === 'waterfall') {
    const rows = data.steps
      .map(
        (step) =>
          `<tr><td>${escape(step.label)}</td><td class="n">${escape(
            format({ value: step.value, ...data.unit }),
          )}</td></tr>`,
      )
      .join('');
    return `<table><thead><tr><th>Step</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const rows = data.rows
    .map(
      (row) =>
        `<tr><td>${escape(row.label)}</td><td class="n">${escape(
          format({ value: row.total, ...data.unit }),
        )}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Account</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// --------------------------------------------------------------------------- drawing

/** Set up the svg and hand back d3, its size, and a selection to draw into. */
function frame(svg) {
  const d3 = window.d3;
  if (!d3) throw new Error('the chart library did not load');
  const width = Math.max(320, Math.round(svg.clientWidth || svg.parentElement?.clientWidth || 900));
  const height = Math.max(240, Math.round(svg.clientHeight || svg.parentElement?.clientHeight || 420));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.replaceChildren();
  return { d3, width, height, root: d3.select(svg) };
}

/** A `<title>`, which is the tooltip: no element to position, and it works on touch. */
function tip(node, text) {
  node.append('title').text(text);
  return node;
}

/** Draw whichever chart the kind names. */
export function render(kind, svg, data, colors) {
  if (kind === 'treemap') return drawingTreemap(svg, data, colors);
  if (kind === 'calendar') return drawingCalendar(svg, data, colors);
  if (kind === 'waterfall') return drawingWaterfall(svg, data, colors);
  if (kind === 'multiples') return drawingMultiples(svg, data, colors);
  throw new Error(`no chart for ${kind}`);
}

/** A treemap of the account tree, area proportional to the leaf balances. */
function drawingTreemap(svg, data, colors) {
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
  // Without that a treemap of one account is one flat colour.
  const groupDepth = (hierarchy.children || []).length === 1 ? 2 : 1;
  const groupOf = (node) => {
    const ancestors = node.ancestors();
    return ancestors.find((entry) => entry.depth === groupDepth)
      || ancestors[ancestors.length - 2]
      || node;
  };
  const groups = new Map();
  for (const leaf of hierarchy.leaves()) {
    if (leaf.value > 0 && !groups.has(groupOf(leaf))) groups.set(groupOf(leaf), groups.size);
  }
  const colours = palette(colors, Math.max(groups.size, 1));

  const cells = root.append('g');
  for (const leaf of hierarchy.leaves()) {
    if (!(leaf.value > 0)) continue;
    const fill = colours[groups.get(groupOf(leaf)) % colours.length];
    const rect = cells
      .append('rect')
      .attr('x', leaf.x0)
      .attr('y', leaf.y0)
      .attr('width', Math.max(0, leaf.x1 - leaf.x0))
      .attr('height', Math.max(0, leaf.y1 - leaf.y0))
      .attr('fill', fill)
      .attr('stroke', colors.background)
      .attr('stroke-width', 1);
    tip(rect, `${leaf.ancestors().reverse().map((node) => node.data.name).filter(Boolean).join(':')}  ${format({ value: leaf.value, ...data.unit })}`);
    const box = { width: leaf.x1 - leaf.x0, height: leaf.y1 - leaf.y0 };
    if (box.width > 62 && box.height > 20) {
      const label = leaf.data.name.length > Math.floor(box.width / 7)
        ? `${leaf.data.name.slice(0, Math.max(2, Math.floor(box.width / 7) - 1))}…`
        : leaf.data.name;
      cells
        .append('text')
        .attr('x', leaf.x0 + 4)
        .attr('y', leaf.y0 + 14)
        .attr('fill', colors.background)
        .attr('font-size', 11)
        .text(label);
    }
  }
}

/** A year of daily spending as a calendar. */
function drawingCalendar(svg, data, colors) {
  const { d3, width, height, root } = frame(svg);
  if (data.days.length === 0) {
    root.append('text').attr('x', 8).attr('y', 24).attr('fill', colors.dim).text('Nothing to draw.');
    return;
  }
  const values = new Map(data.days.map((day) => [day.date, day.value]));
  const dates = data.days.map((day) => dateOf(day.date)).filter(Boolean);
  const firstDay = d3.min(dates);
  const lastDay = d3.max(dates);
  const first = d3.timeWeek.floor(firstDay);
  const last = d3.timeDay.offset(lastDay, 1);
  const weeks = d3.timeWeek.range(first, last);
  const left = 34;
  const top = 22;
  const cell = Math.max(6, Math.min(26, Math.floor((width - left - 12) / Math.max(weeks.length, 1)) - 2));
  const gap = Math.max(1, Math.round(cell / 7));
  const step = cell + gap;
  const max = d3.max(data.days, (day) => day.value) || 1;
  const empty = mix(colors.background, colors.dim, 16);
  const colour = (value) => mix(colors.background, colors.accent, 18 + Math.round((82 * value) / max));

  const grid = root.append('g');
  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = d3.timeDay.offset(week, weekday);
      // The grid starts on the Monday of the first day's week; the days before it belong to
      // the previous month and would put a month name on screen that no square stands for.
      if (day < firstDay || day > lastDay) continue;
      const key = d3.timeFormat('%Y-%m-%d')(day);
      const value = values.get(key);
      const rect = grid
        .append('rect')
        .attr('x', left + index * step)
        .attr('y', top + weekday * step)
        .attr('width', cell)
        .attr('height', cell)
        .attr('rx', 2)
        .attr('fill', value ? colour(value) : empty)
        .attr('stroke', colors.background)
        .attr('stroke-width', 1);
      tip(rect, `${key}${value ? `  ${format({ value, ...data.unit })}` : ''}`);
    }
  }

  // Month names where the month changes. A week is named after the month of its first day in
  // range: the first week usually starts in the previous month, and naming it after that month
  // would put a name on screen that none of its squares belongs to. Two names that would land
  // within a word of each other are not both drawn.
  const monthOfWeek = weeks.map((week) => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = d3.timeDay.offset(week, weekday);
      if (day >= firstDay && day <= lastDay) return day.getMonth();
    }
    return week.getMonth();
  });
  let month = -1;
  let lastLabel = -1000;
  weeks.forEach((week, index) => {
    const current = monthOfWeek[index];
    if (current === month) return;
    month = current;
    const at = left + index * step;
    if (at - lastLabel < 30) return;
    lastLabel = at;
    root
      .append('text')
      .attr('x', at)
      .attr('y', top - 6)
      .attr('fill', colors.dim)
      .attr('font-size', 11)
      .text(d3.timeFormat('%b')(new Date(week.getFullYear(), current, 1)));
  });
  for (const [weekday, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    root
      .append('text')
      .attr('x', left - 6)
      .attr('y', top + weekday * step + cell - 2)
      .attr('text-anchor', 'end')
      .attr('fill', colors.dim)
      .attr('font-size', 10)
      .text(name);
  }

  const scale = root
    .append('g')
    .attr('transform', `translate(${left}, ${top + 7 * step + 14})`);
  scale
    .append('text')
    .attr('fill', colors.dim)
    .attr('font-size', 11)
    .text(`spending per day, ${format({ value: max, ...data.unit })} is the darkest`);
}

/** Income down to net, as a waterfall. */
function drawingWaterfall(svg, data, colors) {
  const { d3, width, height, root } = frame(svg);
  const left = 56;
  const right = 12;
  const top = 16;
  const bottom = 34;
  const steps = data.steps;
  if (steps.length === 0) return;

  let running = 0;
  const bars = steps.map((step) => {
    const start = step.kind === 'expense' ? running : 0;
    const end = step.kind === 'expense' ? running - step.value : step.value;
    if (step.kind === 'expense') running = end;
    return { ...step, start, end };
  });
  const values = bars.flatMap((bar) => [bar.start, bar.end, 0]);
  const y = d3
    .scaleLinear()
    .domain([Math.min(...values), Math.max(...values)])
    .nice()
    .range([height - bottom, top]);
  const x = d3
    .scaleBand()
    .domain(steps.map((step) => step.label))
    .range([left, width - right])
    .padding(0.28);
  const colours = palette(colors, Math.max(steps.length - 2, 1));

  // Zero line, so a bar's direction is readable without an axis.
  root
    .append('line')
    .attr('x1', left)
    .attr('x2', width - right)
    .attr('y1', y(0))
    .attr('y2', y(0))
    .attr('stroke', `${colors.dim}66`);

  let expenseIndex = 0;
  bars.forEach((bar, index) => {
    const fill =
      bar.kind === 'income' ? colors.accent : bar.kind === 'net' ? colors.foreground : colours[expenseIndex++ % colours.length];
    const rect = root
      .append('rect')
      .attr('x', x(bar.label))
      .attr('y', y(Math.max(bar.start, bar.end)))
      .attr('width', x.bandwidth())
      .attr('height', Math.max(1, Math.abs(y(bar.start) - y(bar.end))))
      .attr('rx', 2)
      .attr('fill', fill);
    tip(rect, `${bar.label}  ${format({ value: bar.value, ...data.unit })}`);

    const value = format({ value: bar.value, ...data.unit });
    root
      .append('text')
      .attr('x', x(bar.label) + x.bandwidth() / 2)
      .attr('y', y(Math.max(bar.start, bar.end)) - 5)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.foreground)
      .attr('font-size', 11)
      .text(value);

    root
      .append('text')
      .attr('x', x(bar.label) + x.bandwidth() / 2)
      .attr('y', height - bottom + 16)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.dim)
      .attr('font-size', 11)
      .text(bar.label);

    // A connector to the next bar, so the running total reads as one walk.
    const next = bars[index + 1];
    if (next && bar.kind === 'expense' && next.kind === 'expense') {
      root
        .append('line')
        .attr('x1', x(bar.label) + x.bandwidth())
        .attr('x2', x(next.label))
        .attr('y1', y(bar.end))
        .attr('y2', y(bar.end))
        .attr('stroke', colors.dim)
        .attr('stroke-dasharray', '2 3');
    }
  });
}

/** One sparkline per account, largest first. */
function drawingMultiples(svg, data, colors) {
  const { d3, width, height, root } = frame(svg);
  const rows = data.rows;
  if (rows.length === 0) return;
  const columns = width > 720 ? 2 : 1;
  const cellWidth = (width - 16) / columns;
  const rowsOfCells = Math.ceil(rows.length / columns);
  const cellHeight = Math.max(64, (height - 24) / rowsOfCells);
  const colours = palette(colors, rows.length);

  rows.forEach((row, index) => {
    const column = index % columns;
    const line = Math.floor(index / columns);
    const x0 = 8 + column * cellWidth;
    const y0 = 8 + line * cellHeight;
    const plot = {
      left: x0 + 4,
      right: x0 + cellWidth - 12,
      top: y0 + 26,
      bottom: y0 + cellHeight - 10,
    };
    const values = row.amounts.map((amount) => amount.value);
    const low = Math.min(...values, 0);
    const high = Math.max(...values, 0);
    const x = d3.scalePoint().domain(values.map((_, at) => at)).range([plot.left, plot.right]);
    const y = d3
      .scaleLinear()
      .domain([low, high === low ? high + 1 : high])
      .range([plot.bottom - 2, plot.top + 3]);
    const points = values.map((value, at) => [x(at), y(value)]);

    root
      .append('text')
      .attr('x', x0 + 4)
      .attr('y', y0 + 14)
      .attr('fill', colors.foreground)
      .attr('font-size', 12)
      .text(row.label.length > 34 ? `${row.label.slice(0, 33)}…` : row.label);
    root
      .append('text')
      .attr('x', x0 + cellWidth - 12)
      .attr('y', y0 + 14)
      .attr('text-anchor', 'end')
      .attr('fill', colors.dim)
      .attr('font-size', 11)
      .text(format({ value: row.total, ...data.unit }));

    root
      .append('path')
      .attr('d', d3.line()(points))
      .attr('fill', 'none')
      .attr('stroke', colours[index % colours.length])
      .attr('stroke-width', 1.6);
    const last = points[points.length - 1];
    root
      .append('circle')
      .attr('cx', last[0])
      .attr('cy', last[1])
      .attr('r', 2.4)
      .attr('fill', colours[index % colours.length]);
  });
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}
