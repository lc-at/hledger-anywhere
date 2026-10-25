/**
 * Reconciling one account against a statement: the pure half.
 *
 * Everything here is data in and data out, so all of it is checked in node:
 *
 *   readPrint(json, account)    the postings to reconcile, from `print -O json`
 *   summarize(state)            opening, ticked, expected, statement and the difference
 *   hints(postings, difference) where a difference is likely to come from
 *   plan(...)                   the exact text changes that record the result
 *
 * Only standard hledger is written: a posting's own status mark (`*` when ticked, none when
 * not), and an assertion-only transaction appended to the end of the file. Nothing invented,
 * no tags, no comment formats.
 *
 * Amounts are counted in whole minor units (integers) at the commodity's precision, so a
 * total of ten thousand postings is exact; floating point would drift by a rupiah.
 */

// ---------------------------------------------------------------- amounts

/** A JSON amount's quantity, exactly: mantissa and decimal places. */
export function quantityOf(amount) {
  const quantity = amount.aquantity || {};
  return { mantissa: Number(quantity.decimalMantissa || 0), places: Number(quantity.decimalPlaces || 0) };
}

/** A quantity in minor units at `precision` places, rounded half away from zero. */
export function toMinor({ mantissa, places }, precision) {
  if (places === precision) return mantissa;
  if (places < precision) return mantissa * 10 ** (precision - places);
  const scale = 10 ** (places - precision);
  return Math.sign(mantissa) * Math.round(Math.abs(mantissa) / scale);
}

/** How a commodity is written, from hledger's own style for it. */
export function styleOf(amount, fallbackPrecision = 2) {
  const style = amount && amount.astyle ? amount.astyle : {};
  return {
    commodity: amount ? amount.acommodity : '',
    side: style.ascommodityside === 'L' ? 'L' : 'R',
    spaced: style.ascommodityspaced !== false,
    decimal: style.asdecimalmark || '.',
    precision: Number.isInteger(style.asprecision) ? style.asprecision : fallbackPrecision,
  };
}

/** A commodity symbol as hledger reads it: bare when it can be, quoted when it cannot. */
function symbol(commodity) {
  if (!commodity) return '';
  return /^[^\s\d.,;:"'@*()[\]{}=+\-0-9]+$/u.test(commodity) ? commodity : `"${commodity}"`;
}

/**
 * An amount for the journal: no digit grouping, the commodity's decimal mark and precision.
 * Grouping is not safe to write: in a journal without a commodity directive hledger reads
 * `970,000 IDR` as 970.000, and an assertion written that way fails.
 */
export function journalAmount(minor, style) {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(style.precision + 1, '0');
  const whole = style.precision ? digits.slice(0, -style.precision) : digits;
  const fraction = style.precision ? `${style.decimal}${digits.slice(-style.precision)}` : '';
  const number = `${negative ? '-' : ''}${whole}${fraction}`;
  const name = symbol(style.commodity);
  if (!name) return number;
  const gap = style.spaced ? ' ' : '';
  return style.side === 'L' ? `${name}${gap}${number}` : `${number}${gap}${name}`;
}

/** An amount for reading: grouped, with its commodity, as the window shows it. */
export function readable(minor, style) {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(style.precision + 1, '0');
  const whole = (style.precision ? digits.slice(0, -style.precision) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, style.decimal === ',' ? '.' : ',');
  const fraction = style.precision ? `${style.decimal}${digits.slice(-style.precision)}` : '';
  const number = `${negative ? '-' : ''}${whole}${fraction}`;
  if (!style.commodity) return number;
  const gap = style.spaced ? ' ' : '';
  return style.side === 'L' ? `${style.commodity}${gap}${number}` : `${number}${gap}${style.commodity}`;
}

/**
 * What a person types as a statement balance, in minor units, or null. Grouping and a
 * commodity are allowed; which of `.` and `,` is the decimal mark is the commodity's, unless
 * the number makes it plain (`1.234.567,89`).
 */
export function parseInput(text, style) {
  let raw = String(text == null ? '' : text).replace(/[^\d.,\-−]/g, '').replace('−', '-');
  if (!/\d/.test(raw)) return null;
  const negative = raw.startsWith('-');
  raw = raw.replace(/-/g, '');
  let decimal = style.decimal;
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  const group = decimal === '.' ? ',' : '.';
  const parts = raw.split(group).join('').split(decimal);
  if (parts.length > 2) return null;
  const whole = parts[0] || '0';
  const fraction = (parts[1] || '').slice(0, style.precision).padEnd(style.precision, '0');
  const minor = Number(`${whole}${fraction}`);
  if (!Number.isFinite(minor)) return null;
  return negative ? -minor : minor;
}

// ---------------------------------------------------------------- reading the journal

/** A posting's account, and whether a posting line names it: virtual postings are in brackets. */
function accountOn(line) {
  const match = /^[ \t]+(?:([*!])[ \t]*)?([([]?)(.+?)([)\]]?)(?:\t| {2,}|$)/.exec(line);
  if (!match) return null;
  return { mark: match[1] || '', account: match[3].trim() };
}

/** Whether an account is the one asked for, or under it when `inclusive`. */
function belongs(name, account, inclusive) {
  return name === account || (inclusive && name.startsWith(`${account}:`));
}

/**
 * The postings to reconcile, from hledger's `print -O json` of the account.
 *
 * Of the account's commodity (the one most of its postings are in, or `wanted`), every posting
 * after the last balance assertion on it, which is the point already proven and the opening
 * balance. Each posting carries where it is written (file, the transaction's lines, and which
 * of the account's postings in it it is), its own status mark, and what it is against.
 */
export function readPrint(transactions, account, { inclusive = false, wanted = null } = {}) {
  const found = [];
  const counts = new Map();
  for (const transaction of transactions) {
    const seen = new Map();
    transaction.tpostings.forEach((posting) => {
      if (!belongs(posting.paccount, account, inclusive)) return;
      const occurrence = seen.get(posting.paccount) || 0;
      seen.set(posting.paccount, occurrence + 1);
      for (const amount of posting.pamount || []) {
        counts.set(amount.acommodity, (counts.get(amount.acommodity) || 0) + 1);
      }
      found.push({ transaction, posting, occurrence });
    });
  }
  if (!found.length) return null;
  let commodity = wanted;
  if (commodity == null) {
    let best = -1;
    for (const [name, count] of counts) if (count > best) { best = count; commodity = name; }
  }
  const sample = found.flatMap(({ posting }) => posting.pamount || []).find((amount) => amount.acommodity === commodity);
  const style = styleOf(sample || { acommodity: commodity });
  const others = [...counts.keys()].filter((name) => name !== commodity).sort();

  const rows = [];
  let start = null;
  for (const { transaction, posting, occurrence } of found) {
    const amount = (posting.pamount || []).find((entry) => entry.acommodity === commodity);
    const assertion = posting.pbalanceassertion;
    const asserts = assertion && assertion.baamount && assertion.baamount.acommodity === commodity;
    if (!amount && !asserts) continue;
    const positions = transaction.tsourcepos || [];
    const file = String((positions[0] || {}).sourceName || '').replace(/^\/+/, '');
    const row = {
      id: `${transaction.tindex}:${posting.paccount}:${occurrence}`,
      date: posting.pdate || transaction.tdate,
      description: transaction.tdescription,
      account: posting.paccount,
      against: transaction.tpostings.filter((other) => other !== posting).map((other) => other.paccount).join(', '),
      amount: amount ? toMinor(quantityOf(amount), style.precision) : 0,
      status: posting.pstatus || 'Unmarked',
      generated: (posting.ptags || []).some(([name]) => name === '_generated-posting' || name === 'generated-posting'),
      where: { file, first: (positions[0] || {}).sourceLine || 0, last: (positions[1] || positions[0] || {}).sourceLine || 0, occurrence },
    };
    if (asserts) {
      // The last assertion seen so far is the opening balance; everything before it is proven.
      start = { date: row.date, balance: toMinor(quantityOf(assertion.baamount), style.precision), description: row.description };
      rows.length = 0;
      continue;
    }
    rows.push(row);
  }
  return { account, inclusive, commodity, style, others, start, rows };
}

// ---------------------------------------------------------------- the arithmetic

/**
 * Where a reconciliation stands. `ticked` is a set of row ids; rows after the statement date
 * are not on the statement and do not count. `outstanding` are the rows on or before the date
 * that are not ticked: a balance assertion counts every posting, so they must be ticked (or
 * re-dated) before the reconciliation can finish.
 */
export function summarize({ data, ticked, statementDate, statementBalance }) {
  const opening = data.start ? data.start.balance : 0;
  const inRange = data.rows.filter((row) => !statementDate || row.date <= statementDate);
  const on = inRange.filter((row) => ticked.has(row.id));
  const tickedTotal = on.reduce((sum, row) => sum + row.amount, 0);
  const expected = opening + tickedTotal;
  const outstanding = inRange.filter((row) => !ticked.has(row.id));
  const difference = statementBalance == null ? null : statementBalance - expected;
  const tooEarly = Boolean(data.start && statementDate && statementDate < data.start.date);
  return {
    opening,
    tickedTotal,
    tickedCount: on.length,
    expected,
    difference,
    shown: inRange.length,
    later: data.rows.length - inRange.length,
    outstanding,
    tooEarly,
    canFinish: difference === 0 && outstanding.length === 0 && !tooEarly && Boolean(statementDate),
  };
}

/**
 * Where a difference probably comes from, best first: a posting whose amount is the whole
 * difference (ticked by mistake, or missing from the ticks), half of it (entered with the wrong
 * sign), and digits swapped in typing, which leave a difference divisible by nine.
 */
export function hints(rows, ticked, difference, style) {
  if (!difference) return [];
  const found = [];
  const say = (minor) => readable(minor, style);
  for (const row of rows) {
    const on = ticked.has(row.id);
    if (!on && row.amount === difference) found.push({ id: row.id, reason: `not ticked, and exactly the difference (${say(difference)})` });
    else if (on && row.amount === -difference) found.push({ id: row.id, reason: `ticked, and exactly the difference (${say(-difference)}): is it on the statement?` });
    else if (difference % 2 === 0 && on && row.amount === -difference / 2) found.push({ id: row.id, reason: `half the difference: entered with the wrong sign?` });
  }
  const units = Math.abs(difference) / 10 ** style.precision;
  if (Number.isInteger(units) ? units % 9 === 0 : Math.round(Math.abs(difference)) % 9 === 0) {
    found.push({ id: null, reason: `${say(difference)} divides by 9, which two swapped digits leave (18 typed as 81)` });
  }
  return found;
}

// ---------------------------------------------------------------- writing

/** A posting line with its status mark set to `mark` ('*' or ''), keeping its columns. */
export function remark(line, mark) {
  const match = /^([ \t]+)(?:([*!])([ \t]*))?(.*)$/.exec(line);
  if (!match) return line;
  const [, indent, , gap = '', rest] = match;
  const had = match[2] !== undefined;
  // The width before the account is kept, so amounts stay in their column.
  const width = indent.replace(/\t/g, '    ').length + (had ? 1 + gap.length : 0);
  if (!mark) return `${' '.repeat(Math.max(4, width))}${rest}`;
  const lead = Math.max(2, width - 2);
  return `${' '.repeat(lead)}${mark} ${rest}`;
}

/** The transaction that proves the statement balance: one posting of nothing, asserting. */
export function assertionText(date, account, minor, style, inclusive = false) {
  const zero = journalAmount(0, style);
  return `${date} * Reconciled with statement\n    ${account}    ${zero} ${inclusive ? '=*' : '='} ${journalAmount(minor, style)}\n`;
}

/**
 * The text changes that record a reconciliation, for each file touched.
 *
 * `texts` maps a file path to its contents as the app has it. Each row whose wanted state
 * differs from its posting's own mark has its line found inside its transaction's lines, by
 * account and occurrence, and re-marked. With `finish`, the assertion is appended to the file
 * the account's latest posting is in. A row that cannot be found (a generated posting, or a
 * file that changed) is reported in `missing` rather than guessed at.
 */
export function plan({ data, texts, ticked, finish = null }) {
  const files = new Map();
  const missing = [];
  const lines = (path) => {
    if (!files.has(path)) {
      if (texts[path] == null) return null;
      files.set(path, { path, before: texts[path], lines: texts[path].split('\n'), changes: [], appended: '' });
    }
    return files.get(path);
  };
  for (const row of data.rows) {
    const wanted = ticked.has(row.id) ? 'Cleared' : 'Unmarked';
    // A pending mark the person did not tick stays pending: it says something of its own.
    if (row.status === wanted || (wanted === 'Unmarked' && row.status === 'Pending')) continue;
    if (row.generated) { missing.push({ id: row.id, why: 'generated by a rule, not written in the file' }); continue; }
    const file = lines(row.where.file);
    if (!file) { missing.push({ id: row.id, why: `${row.where.file} is not loaded` }); continue; }
    let seen = 0;
    let at = -1;
    const end = Math.max(row.where.last - 1, row.where.first);
    for (let index = row.where.first; index < end && index < file.lines.length; index += 1) {
      const posting = accountOn(file.lines[index]);
      if (!posting || file.lines[index].trim().startsWith(';')) continue;
      if (posting.account !== row.account) continue;
      if (seen === row.where.occurrence) { at = index; break; }
      seen += 1;
    }
    if (at < 0) { missing.push({ id: row.id, why: 'its line was not found where hledger said it was' }); continue; }
    const before = file.lines[at];
    const after = remark(before, wanted === 'Cleared' ? '*' : '');
    if (after === before) continue;
    file.lines[at] = after;
    file.changes.push({ line: at + 1, before, after, id: row.id });
  }
  // The assertion, whether or not there is a file to append it to: a read-only journal still
  // gets it, to copy in by hand.
  const assertion = finish ? assertionText(finish.date, data.account, finish.balance, data.style, data.inclusive) : '';
  if (finish) {
    const last = [...data.rows].reverse().find((row) => !row.generated && texts[row.where.file] != null);
    const path = finish.file || (last ? last.where.file : Object.keys(texts)[0]);
    const file = path ? lines(path) : null;
    if (file) file.appended = assertion;
    else missing.push({ id: null, why: `${path || 'the journal'} cannot be read here, so the assertion has nowhere to go` });
  }
  const out = [];
  for (const file of files.values()) {
    if (!file.changes.length && !file.appended) continue;
    let after = file.lines.join('\n');
    if (file.appended) after = `${after}${after.endsWith('\n') ? '' : '\n'}\n${file.appended}`;
    out.push({ path: file.path, before: file.before, after, changes: file.changes, appended: file.appended });
  }
  return { files: out, missing, assertion };
}
