/**
 * An example plugin: a balance line chart, in a window of its own.
 *
 * It exists to show the API rather than to be the app's chart tool, which was removed.
 * Everything it needs is in `host`:
 *
 *   host.name                 this plugin's word, "chart"
 *   host.hledger(command)     run hledger (read-only) and resolve with its stdout
 *   host.say(text)            print a line, the way the app prints its own
 *   host.window(title)        open a window now, and fill it later
 *   host.setting(key)         a setting this plugin remembered
 *   host.remember(key, value) remember it for next time
 *
 * The window is opened before anything is awaited, because a pop-up opened after an
 * await is blocked by the browser. That is the whole reason `window()` returns a handle.
 */
const DEFAULT_ACCOUNT = 'expenses';

export default {
  async run(args, host) {
    const account = String(args || '').trim() || host.setting('account') || DEFAULT_ACCOUNT;

    // Opened first, filled when the numbers arrive.
    const view = host.window(`hledger: ${account} over time`);
    if (!view) {
      host.say(`${host.name}: the browser blocked the window for ${account}.`);
      return;
    }
    view.write('<p style="font:14px system-ui;padding:1rem">Loading…</p>');

    let csv;
    try {
      // Monthly balances for one account, as CSV: the only hledger output that keeps
      // periods and amounts apart without parsing a laid-out table.
      csv = await host.hledger(`balance ${account} -M -O csv`);
    } catch (error) {
      view.write(fail(String(error && error.message ? error.message : error)));
      host.say(`${host.name}: ${error && error.message ? error.message : error}`);
      return;
    }

    const points = parse(csv);
    if (points.length === 0) {
      view.write(fail('no amounts to chart'));
      host.say(`${host.name}: ${account} has no monthly amounts to chart.`);
      return;
    }

    host.remember('account', account);
    view.write(page(account, points));
    host.say(
      `${host.name}: ${points.length} months of ${account}, ` +
        `${format(points[points.length - 1].value)} last, in a new window.`
    );
  },
};

/** [period, amount] rows, ignoring the header and anything unparseable. */
function parse(csv) {
  const rows = String(csv).trim().split('\n').map((line) => split(line));
  if (rows.length < 2) return [];
  const [header, ...body] = rows;
  const period = header.indexOf('period');
  const amount = header.findIndex((cell) => cell === 'balance' || cell.startsWith('balance'));
  if (period < 0 || amount < 0) return [];
  return body
    .map((cells) => ({ label: cells[period], value: money(cells[amount]) }))
    .filter((point) => point.label && Number.isFinite(point.value));
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

/** hledger writes amounts as "1,234.56" or "-$12.00"; this wants a number. */
function money(text) {
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  return cleaned === '' || cleaned === '-' ? NaN : Number(cleaned);
}

function format(value) {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fail(message) {
  return `<p style="font:14px system-ui;padding:1rem;color:#b00">${escape(message)}</p>`;
}

function escape(text) {
  return String(text).replace(/[&<>]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;');
}

/** A line chart, as one SVG. Small enough that a charting library would be the wrong
 *  answer for an example: this is about the plugin API, not about drawing. */
function page(account, points) {
  const width = 760;
  const height = 320;
  const padding = 48;
  const values = points.map((point) => point.value);
  const high = Math.max(...values, 0);
  const low = Math.min(...values, 0);
  const span = high - low || 1;
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const x = (index) => padding + index * step;
  const y = (value) => height - padding - ((value - low) / span) * (height - padding * 2);

  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const area = `${padding},${y(0)} ${line} ${x(points.length - 1)},${y(0)}`;
  const dots = points
    .map((point, index) =>
      `<circle cx="${x(index)}" cy="${y(point.value)}" r="3" fill="#7aa2f7"/>`)
    .join('');
  const labels = points
    .map((point, index) =>
      index % Math.ceil(points.length / 8) === 0
        ? `<text x="${x(index)}" y="${height - padding + 18}" font-size="11" fill="#6b7280" text-anchor="middle">${escape(point.label)}</text>`
        : '')
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: ${escape(account)}</title></head>
<body style="margin:0;background:#0b1021;color:#c9d1d9;font:14px system-ui">
<h1 style="font-size:16px;font-weight:600;padding:16px 16px 0">${escape(account)}, monthly</h1>
<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:900px">
  <polygon points="${area}" fill="rgba(122,162,247,0.15)"/>
  <polyline points="${line}" fill="none" stroke="#7aa2f7" stroke-width="2"/>
  <line x1="${padding}" y1="${y(0)}" x2="${width - padding}" y2="${y(0)}" stroke="#6b7280" stroke-width="1"/>
  ${dots}
  ${labels}
  <text x="${padding}" y="${padding - 16}" font-size="11" fill="#6b7280">${escape(format(high))}</text>
  <text x="${padding}" y="${height - padding + 2}" font-size="11" fill="#6b7280">${escape(format(low))}</text>
</svg>
<p style="padding:0 16px 16px;color:#6b7280">from hledger's own numbers: balance ${escape(account)} -M -O csv</p>
</body></html>`;
}
