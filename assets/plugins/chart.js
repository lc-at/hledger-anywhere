/**
 * A balance chart, in a window of its own.
 *
 * This ships with the app as the worked example of the plugin API, so it is written the way
 * the docs tell an author to write one. Nothing here is part of the app's core: it runs in
 * the page, with the API it is handed.
 *
 *     host.name                  this plugin's word, "chart"
 *     host.hledger(command)      run hledger (read-only) and resolve with its stdout
 *     host.say(text)             print a line, the way the app prints its own
 *     host.window(title)         open a window now, and fill it in later
 *     host.colors()              the colours of the theme in use, so the window matches
 *     host.setting(key)          a setting this plugin remembered
 *     host.remember(key, value)  remember it for next time
 *
 * The window is opened before anything is awaited, because a pop-up opened after an await is
 * blocked. That is the whole reason `window()` returns a handle rather than taking content.
 *
 * Two shapes come out of the same command, chosen by what hledger answers with:
 *
 *   chart expenses            monthly expenses, a line over time
 *   chart expenses -p 2024    a year, so one column, so a ranking of where it went
 *
 * The rule is the data's: one column is a ranking, several are a series. Nothing is guessed
 * from the arguments except whether to ask for months, which is only done when the caller
 * has not asked for a period of their own.
 */

const DEFAULT_ACCOUNT = 'expenses';
const FALLBACK_COLORS = {
  background: '#000000',
  foreground: '#d8d8d8',
  cursor: '#ff9f1c',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

/** Flags that mean the caller has already chosen a period, so months are not added. */
const PERIOD_FLAGS = [
  '-D', '--daily', '-W', '--weekly', '-M', '--monthly',
  '-Q', '--quarterly', '-Y', '--yearly', '-p', '--period',
];

export default {
  async run(args, host) {
    const asked = String(args == null ? '' : args).trim();
    const account = asked || host.setting('account') || DEFAULT_ACCOUNT;
    const colors = typeof host.colors === 'function' ? host.colors() : FALLBACK_COLORS;

    // Opened first, filled when the numbers arrive.
    const view = host.window(`hledger: ${account}`);
    if (!view) {
      host.say(`${host.name}: the browser blocked the window for ${account}.`);
      return;
    }
    view.write(shell(colors, account, 'Reading hledger…'));

    const command = `balance ${account}${monthly(asked) ? ' -M' : ''} -O csv`;
    let csv;
    try {
      // -O csv is the only hledger output that keeps periods, accounts and amounts apart
      // without parsing a table whose columns move.
      csv = await host.hledger(command);
    } catch (error) {
      const why = error && error.message ? error.message : String(error);
      view.write(shell(colors, account, why));
      host.say(`${host.name}: ${why}`);
      return;
    }

    const report = read(csv);
    if (!report) {
      view.write(shell(colors, account, 'hledger returned nothing to chart.'));
      host.say(`${host.name}: ${account} has no amounts to chart.`);
      return;
    }

    host.remember('account', account);
    view.write(page(colors, account, report, command));
    host.say(`${host.name}: ${summary(account, report)}, in a new window.`);
  },
};

/** Whether to ask hledger for months: yes unless the caller named a period themselves. */
function monthly(args) {
  const words = args.split(/\s+/).filter(Boolean);
  return !words.some((word) => PERIOD_FLAGS.includes(word));
}

/**
 * Read hledger's balance CSV.
 *
 * The shape is one row per account and one column per period, with a Total row:
 *
 *   "account","2024-01","2024-02"
 *   "expenses:food:coffee","0","$12.50"
 *   "Total:","$1286.40","$47.49"
 *
 * The Total row is skipped: it is the sum of the rows, and adding it would count everything
 * twice. Returns null when there is nothing to draw.
 */
function read(csv) {
  const rows = String(csv).trim().split('\n').map(split);
  if (rows.length < 2) return null;

  const [header, ...body] = rows;
  const periods = header.slice(1).map((cell) => cell.trim());
  if (periods.length === 0) return null;

  const entries = [];
  for (const cells of body) {
    if (cells.length < periods.length + 1) continue;
    const label = (cells[0] || '').trim();
    if (!label || /^total:?$/i.test(label)) continue;
    entries.push({
      label,
      amounts: periods.map((_, index) => money(cells[index + 1])),
    });
  }
  if (entries.length === 0) return null;

  if (periods.length > 1) {
    // A series: one point per period, the sum of the accounts shown.
    const points = periods.map((label, index) => ({
      label,
      amount: total(entries.map((entry) => entry.amounts[index])),
    }));
    return {
      shape: 'series',
      labels: periods,
      points,
      entries,
      unit: unit(entries.flatMap((entry) => entry.amounts)),
    };
  }

  // A ranking: one column, so one value per account, largest first.
  const points = entries
    .map((entry) => ({ label: entry.label, amount: entry.amounts[0] }))
    .sort((left, right) => Math.abs(right.amount.value) - Math.abs(left.amount.value));
  return {
    shape: 'ranking',
    labels: [periods[0]],
    points,
    entries,
    unit: unit(points.map((point) => point.amount)),
  };
}

/** One CSV line, honouring quoted cells. */
function split(line) {
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
 * thing a journal can set.
 */
function money(text) {
  const raw = String(text == null ? '' : text).trim();
  const empty = { value: 0, prefix: '', suffix: '' };
  if (raw === '') return empty;

  const found = raw.match(/-?[\d.,]+/);
  if (!found) return empty;
  let digits = found[0];
  const comma = digits.lastIndexOf(',');
  const dot = digits.lastIndexOf('.');
  digits = comma > dot
    ? digits.replace(/\./g, '').replace(',', '.')   // 1.234,56
    : digits.replace(/,/g, '');                     // 1,234.56
  const value = Number(digits);
  if (!Number.isFinite(value)) return empty;

  return {
    value,
    prefix: raw.slice(0, found.index).replace(/-/g, '').trim(),
    suffix: raw.slice(found.index + found[0].length).trim(),
  };
}

/**
 * The commodity to label the axis with.
 *
 * Taken from the first amount that has one, not from the first amount: hledger writes `0`
 * for a period with nothing in it, and an axis labelled 500 instead of $500 is a chart that
 * forgot what it was counting.
 */
function unit(amounts) {
  return amounts.find((amount) => amount.prefix || amount.suffix)
    || amounts[0]
    || { value: 0, prefix: '', suffix: '' };
}

/** Amounts added up, keeping the first commodity seen. */
function total(amounts) {
  return {
    value: amounts.reduce((sum, amount) => sum + amount.value, 0),
    prefix: amounts[0] ? amounts[0].prefix : '',
    suffix: amounts[0] ? amounts[0].suffix : '',
  };
}

/** 1234567.891 -> "1,234,567.89", without asking the browser's locale. */
function group(number, decimals = 2) {
  const fixed = Math.abs(number).toFixed(decimals);
  const [whole, fraction] = fixed.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

/** An amount as a person writes it: -$1,286.40. */
function format(amount, decimals = 2) {
  const sign = amount.value < 0 ? '-' : '';
  return `${sign}${amount.prefix}${group(amount.value, decimals)}${amount.suffix}`;
}

/** A short form for axis labels: -$1.2k, $986, $0. */
function compact(amount) {
  const size = Math.abs(amount.value);
  const sign = amount.value < 0 ? '-' : '';
  if (size >= 1000) {
    return `${sign}${amount.prefix}${group(amount.value / 1000, 1)}k${amount.suffix}`;
  }
  return format(amount, size !== 0 && size < 10 ? 2 : 0);
}

/**
 * Round numbers for the axis: a step of 1, 2 or 5 times a power of ten, and the ticks that
 * come from it. An axis whose labels are 1,037.42 and 2,074.84 is not an axis.
 */
function ticks(low, high) {
  if (high === low) return [low];
  const raw = (high - low) / 4;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((multiple) => multiple * power).find((size) => size >= raw) || power;
  const start = Math.floor(low / step) * step;
  const ticks = [];
  for (let value = start; value <= high + step / 2; value += step) {
    ticks.push(Math.abs(value) < step / 1000 ? 0 : value);
  }
  return ticks;
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[character]));
}

/** The window before there is anything to show, and when something went wrong. */
function shell(colors, account, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(account)}</title></head>
<body style="margin:0;background:${colors.background};color:${colors.foreground};
  font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:960px;margin:0 auto;padding:24px">
  <h1 style="font-size:18px;font-weight:600;margin:0 0 4px">${escape(account)}</h1>
  <p style="color:${colors.dim};margin:0">${escape(message)}</p>
</main>
</body></html>`;
}

/**
 * The whole window: a heading, the numbers that matter, the chart, and the data in a table
 * for anyone who wants to read or copy it rather than look at it.
 */
function page(colors, account, report, command) {
  const drawing = report.shape === 'series'
    ? series(colors, report)
    : ranking(colors, report);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(account)}</title></head>
<body style="margin:0;background:${colors.background};color:${colors.foreground};
  font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:960px;margin:0 auto;padding:24px">
  <h1 style="font-size:18px;font-weight:600;margin:0 0 2px">${escape(account)}${report.shape === 'series' ? ', over time' : ''}</h1>
  <p style="color:${colors.dim};margin:0 0 16px">${escape(headline(report))}</p>
  ${drawing}
  <details style="margin-top:20px">
    <summary style="cursor:pointer;color:${colors.dim}">The numbers</summary>
    ${table(colors, report)}
  </details>
  <p style="color:${colors.dim};margin:20px 0 0;font-size:12px">
    from hledger's own numbers:
    <code style="color:${colors.foreground}">${escape(command)}</code>
  </p>
</main>
</body></html>`;
}

/** The line, the area under it, and a dot per period. */
function series(colors, report) {
  const width = 900;
  const height = 360;
  const padding = { top: 22, right: 24, bottom: 44, left: 84 };
  const plot = {
    left: padding.left,
    right: width - padding.right,
    top: padding.top,
    bottom: height - padding.bottom,
  };

  const values = report.points.map((point) => point.amount.value);
  const marks = ticks(Math.min(0, ...values), Math.max(0, ...values));
  const low = marks[0];
  const high = marks[marks.length - 1];
  const span = high - low || 1;
  const step = report.points.length > 1
    ? (plot.right - plot.left) / (report.points.length - 1)
    : 0;
  const x = (index) => plot.left + index * step;
  const y = (value) => plot.bottom - ((value - low) / span) * (plot.bottom - plot.top);
  const zero = y(0);

  const grid = marks.map((value) => `
    <line x1="${plot.left}" y1="${y(value)}" x2="${plot.right}" y2="${y(value)}"
      stroke="${colors.dim}" stroke-opacity="${value === 0 ? '0.8' : '0.25'}"
      stroke-dasharray="${value === 0 ? '' : '3 4'}"/>
    <text x="${plot.left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="11"
      fill="${colors.dim}">${escape(compact({ value, prefix: report.unit.prefix, suffix: report.unit.suffix }))}</text>`).join('');

  const line = report.points.map((point, index) => `${x(index)},${y(point.amount.value)}`).join(' ');
  const area = `${plot.left},${zero} ${line} ${x(report.points.length - 1)},${zero}`;
  const dots = report.points.map((point, index) => `
    <circle cx="${x(index)}" cy="${y(point.amount.value)}" r="4" fill="${colors.accent}"
      stroke="${colors.background}" stroke-width="1.5">
      <title>${escape(point.label)}: ${escape(format(point.amount))}</title>
    </circle>`).join('');

  // Every label when there is room, otherwise every few, so they never overlap.
  const every = Math.max(1, Math.ceil(report.points.length / 12));
  const labels = report.points.map((point, index) => (index % every === 0 || index === report.points.length - 1
    ? `<text x="${x(index)}" y="${height - 16}" text-anchor="middle" font-size="11"
        fill="${colors.dim}">${escape(point.label)}</text>`
    : '')).join('');

  return `<div style="overflow-x:auto">
<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:960px;display:block"
  role="img" aria-label="Balance over time">
  <title>${escape(headline(report))}</title>
  ${grid}
  <polygon points="${area}" fill="${colors.accent}" fill-opacity="0.14"/>
  <polyline points="${line}" fill="none" stroke="${colors.accent}" stroke-width="2"
    stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  ${labels}
</svg>
</div>`;
}

/** Horizontal bars, longest first: how "where did it go" is read. */
function ranking(colors, report) {
  const width = 900;
  const row = 26;
  const height = report.points.length * row + 24;
  const labelWidth = 240;
  const barWidth = width - labelWidth - 130;
  const largest = Math.max(...report.points.map((point) => Math.abs(point.amount.value)), 0) || 1;
  const negatives = report.points.some((point) => point.amount.value < 0);
  const zero = negatives ? labelWidth + barWidth / 2 : labelWidth;

  const bars = report.points.map((point, index) => {
    const top = index * row + 8;
    const length = (Math.abs(point.amount.value) / largest) * (negatives ? barWidth / 2 : barWidth);
    const x = point.amount.value < 0 ? zero - length : zero;
    const label = point.label.length > 34 ? `${point.label.slice(0, 33)}…` : point.label;
    return `
    <g>
      <title>${escape(point.label)}: ${escape(format(point.amount))}</title>
      <text x="${labelWidth - 12}" y="${top + 13}" text-anchor="end" font-size="12"
        fill="${colors.foreground}">${escape(label)}</text>
      <rect x="${x}" y="${top}" width="${Math.max(length, 1)}" height="14" rx="2"
        fill="${colors.accent}" fill-opacity="${point.amount.value < 0 ? '0.55' : '1'}"/>
      <text x="${zero + barWidth / 2 + 12}" y="${top + 13}" font-size="12"
        fill="${colors.dim}">${escape(format(point.amount))}</text>
    </g>`;
  }).join('');

  const axis = negatives
    ? `<line x1="${zero}" y1="4" x2="${zero}" y2="${height - 8}" stroke="${colors.dim}" stroke-opacity="0.5"/>`
    : '';

  return `<div style="overflow-x:auto">
<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:960px;display:block"
  role="img" aria-label="Balance by account">
  <title>${escape(headline(report))}</title>
  ${axis}
  ${bars}
</svg>
</div>`;
}

/** The data, for reading or copying: a chart is not a table, and sometimes a table is
 *  what is wanted. */
function table(colors, report) {
  const first = report.shape === 'series' ? 'Period' : 'Account';
  const rows = report.points.map((point) => `<tr>
      <td style="padding:2px 0">${escape(point.label)}</td>
      <td align="right" style="padding:2px 0;font-variant-numeric:tabular-nums">${escape(format(point.amount))}</td>
    </tr>`).join('');
  return `<table style="border-collapse:collapse;margin-top:8px;font-size:13px;width:100%">
    <thead><tr style="color:${colors.dim};text-align:left">
      <th style="font-weight:500;padding-bottom:4px">${first}</th>
      <th style="font-weight:500;padding-bottom:4px;text-align:right">Balance</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** The line under the heading: what this chart is of, in words. */
function headline(report) {
  if (report.shape === 'series') {
    const first = report.points[0];
    const last = report.points[report.points.length - 1];
    return `${report.points.length} periods, ${first.label} to ${last.label}`;
  }
  return `${report.points.length} accounts, ${report.labels[0]}`;
}

/** One line for the terminal, so the window is not the only place the answer lives. */
function summary(account, report) {
  if (report.shape === 'series') {
    const first = report.points[0].amount.value;
    const last = report.points[report.points.length - 1].amount;
    const change = last.value - first;
    return `${report.points.length} periods of ${account}, ${format(last)}, ${
      change >= 0 ? 'up' : 'down'} ${format({ ...last, value: Math.abs(change) })}`;
  }
  const biggest = report.points[0];
  return `${report.points.length} accounts, ${format(biggest.amount)} in ${biggest.label}`;
}
