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
    // A transaction of two postings in one commodity, with no costs, is one whose amounts and
    // other account can be edited and stay balanced: the other side is the same amount, negated.
    const simple = transaction.tpostings.length === 2
      && transaction.tpostings.every((entry) => (entry.pamount || []).length === 1 && entry.pamount[0].acommodity === commodity && !entry.pamount[0].acost)
      && !transaction.tpostings.some((entry) => (entry.ptags || []).some(([name]) => /generated-posting/.test(name)));
    const otherPosting = transaction.tpostings.find((entry) => entry !== posting);
    const row = {
      id: `${transaction.tindex}:${posting.paccount}:${occurrence}`,
      date: posting.pdate || transaction.tdate,
      description: transaction.tdescription,
      account: posting.paccount,
      against: transaction.tpostings.filter((other) => other !== posting).map((other) => other.paccount).join(', '),
      amount: amount ? toMinor(quantityOf(amount), style.precision) : 0,
      status: posting.pstatus || 'Unmarked',
      generated: (posting.ptags || []).some(([name]) => name === '_generated-posting' || name === 'generated-posting'),
      ownDate: Boolean(posting.pdate),
      simple,
      other: simple && otherPosting ? otherPosting.paccount : null,
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
 * The rows as hledger orders them, with their edits applied and new ones added: by date, then
 * in file order, with a new posting after the day's existing ones, since it is appended to the
 * end of the file. Each row gets `balance`, the account's balance after it, which is what a
 * statement prints beside each line and what a balance assertion on that posting would assert.
 */
export function ordered(data, { edits = {}, inserts = [] } = {}) {
  const rows = data.rows.map((row, at) => ({ ...row, ...pick(edits[row.id]), at, edited: Boolean(edits[row.id]) }));
  // A new posting goes after the posting it was added beside, if it is on that day, which is where
  // it is written; otherwise at the end of the file, after the day's others.
  inserts.forEach((insert, at) => {
    const beside = insert.after != null ? data.rows.findIndex((row) => row.id === insert.after && row.date === insert.date) : -1;
    rows.push({
      id: insert.id, date: insert.date, description: insert.description, account: data.account, against: insert.other,
      other: insert.other, amount: insert.amount, status: 'Unmarked', simple: true, inserted: true,
      at: beside >= 0 ? beside + 0.5 + at / 1000 : data.rows.length + at,
      where: { file: insert.file || null, first: 0, last: 0, occurrence: 0 },
    });
  });
  rows.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : left.at - right.at));
  let balance = data.start ? data.start.balance : 0;
  for (const row of rows) {
    balance += row.amount;
    row.balance = balance;
  }
  return rows;
}

/** The fields an edit may change, as a row has them. */
function pick(edit) {
  if (!edit) return {};
  const out = {};
  if (edit.date) out.date = edit.date;
  if (edit.description != null) out.description = edit.description;
  if (edit.amount != null) out.amount = edit.amount;
  if (edit.other) { out.other = edit.other; out.against = edit.other; }
  return out;
}

/**
 * Each row whose expected running total was typed, and the difference there: the statement's
 * balance after that line less the journal's. The first row where it is not zero is where the
 * journal and the statement part, which is where to look.
 */
export function checkpoints(rows, expected = {}) {
  const out = [];
  for (const row of rows) {
    if (expected[row.id] == null) continue;
    out.push({ id: row.id, expected: expected[row.id], balance: row.balance, difference: expected[row.id] - row.balance });
  }
  return { points: out, first: out.find((point) => point.difference !== 0) || null };
}

/**
 * Where a reconciliation stands. `ticked` is a set of row ids; rows after the statement date
 * are not on the statement and do not count. `outstanding` are the rows on or before the date
 * that are not ticked: a balance assertion counts every posting, so they must be ticked (or
 * re-dated) before the reconciliation can finish.
 */
export function summarize({ data, ticked, statementDate, statementBalance, edits = {}, inserts = [] }) {
  const opening = data.start ? data.start.balance : 0;
  const all = ordered(data, { edits, inserts });
  const inRange = all.filter((row) => !statementDate || row.date <= statementDate);
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
    later: all.length - inRange.length,
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

/**
 * A transaction's first line, in its parts: date, secondary date, status, code, description and
 * comment. Unchanged parts are written back exactly as they were.
 */
export function parseHeader(line) {
  const match = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(=\S+)?([ \t]+[*!])?([ \t]+\([^)]*\))?(.*)$/.exec(line);
  if (!match) return null;
  const rest = match[5];
  const comment = /\s+;/.exec(rest);
  const description = (comment ? rest.slice(0, comment.index) : rest).trim();
  return { date: match[1], date2: match[2] || '', status: match[3] || '', code: match[4] || '', description, comment: comment ? rest.slice(comment.index) : '' };
}

export function formatHeader(header) {
  return `${header.date}${header.date2}${header.status}${header.code}${header.description ? ` ${header.description}` : ''}${header.comment}`;
}

/**
 * A posting line, in its parts: indent, status mark, the account (and the brackets of a virtual
 * posting), the gap after it, the amount text (with any assertion), and a comment.
 */
export function parsePosting(line) {
  const match = /^([ \t]+)(?:([*!])([ \t]*))?([([]?)(\S(?:.*?\S)?)([)\]]?)(?:(\t| {2,})(.*))?$/.exec(line);
  if (!match || match[5].startsWith(';')) return null;
  const rest = match[8] || '';
  const at = rest.indexOf(';');
  return {
    indent: match[1], mark: match[2] || '', markGap: match[3] || '', open: match[4], account: match[5], close: match[6],
    gap: match[7] || '', amount: (at >= 0 ? rest.slice(0, at) : rest).trim(), comment: at >= 0 ? rest.slice(at).trimEnd() : '',
  };
}

/**
 * A posting line written from its parts. `end` is the column its amount should end at, so a
 * rewritten amount stays right-aligned with the transaction's others; the gap is at least two
 * spaces, which is what separates an account from an amount.
 */
export function formatPosting(parts, end = 0, was = parts) {
  // The lead is the original's, re-marked, so the account stays in its column.
  const lead = remark(`${was.indent}${was.mark ? `${was.mark}${was.markGap}` : ''}x`, parts.mark).slice(0, -1);
  const name = `${lead}${parts.open}${parts.account}${parts.close}`;
  if (!parts.amount) return `${name}${parts.comment ? `  ${parts.comment}` : ''}`;
  const gap = Math.max(2, end ? end - name.length - parts.amount.length : (parts.gap || '    ').replace(/\t/g, '    ').length);
  return `${name}${' '.repeat(gap)}${parts.amount}${parts.comment ? `  ${parts.comment}` : ''}`;
}

/** Where the amount on a posting line ends, or 0 if it has none. */
function amountEnd(line) {
  const parts = parsePosting(line);
  if (!parts || !parts.amount) return 0;
  return line.indexOf(parts.amount) + parts.amount.length;
}

/** A new transaction for the account, appended to the file: the account's side carries the amount. */
export function insertText(insert, account, style, ticked) {
  return `${insert.date} ${insert.description}\n  ${ticked ? '*' : ' '} ${account}    ${journalAmount(insert.amount, style)}\n    ${insert.other}\n`;
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
export function plan({ data, texts, ticked, finish = null, edits = {}, inserts = [], expected = {} }) {
  const files = new Map();
  const missing = [];
  const lines = (path) => {
    if (!files.has(path)) {
      if (texts[path] == null) return null;
      files.set(path, { path, before: texts[path], lines: texts[path].split('\n'), changes: [], appended: '', inserted: [] });
    }
    return files.get(path);
  };
  const rows = ordered(data, { edits, inserts });
  // Expected running totals that match are written as assertions on their postings; one that
  // does not match is the person's note to find out why, and hledger would refuse it.
  const asserting = new Map(checkpoints(rows, expected).points.filter((point) => point.difference === 0).map((point) => [point.id, point.balance]));
  const change = (file, at, after, id) => {
    const before = file.lines[at];
    if (after === before) return;
    const earlier = file.changes.find((entry) => entry.line === at + 1);
    if (earlier) earlier.after = after;
    else file.changes.push({ line: at + 1, before, after, id });
    file.lines[at] = after;
  };

  for (const row of rows.filter((entry) => !entry.inserted)) {
    const wanted = ticked.has(row.id) ? 'Cleared' : 'Unmarked';
    const remarkIt = !(row.status === wanted || (wanted === 'Unmarked' && row.status === 'Pending'));
    const edit = edits[row.id] || null;
    const assertTo = asserting.get(row.id);
    if (!remarkIt && !edit && assertTo == null) continue;
    if (row.generated) { missing.push({ id: row.id, why: 'generated by a rule, not written in the file' }); continue; }
    const file = lines(row.where.file);
    if (!file) { missing.push({ id: row.id, why: `${row.where.file} is not loaded` }); continue; }
    // The transaction's posting lines, in order, comment lines skipped.
    const header = row.where.first - 1;
    const end = Math.max(row.where.last - 1, row.where.first);
    const postings = [];
    for (let index = row.where.first; index < end && index < file.lines.length; index += 1) {
      const parts = parsePosting(file.lines[index]);
      if (parts && !file.lines[index].trim().startsWith(';')) postings.push({ at: index, parts });
    }
    let seen = 0;
    const own = postings.find((entry) => entry.parts.account === row.account && seen++ === row.where.occurrence);
    if (!own) { missing.push({ id: row.id, why: 'its line was not found where hledger said it was' }); continue; }
    const others = postings.filter((entry) => entry !== own);
    const column = Math.max(0, ...postings.map((entry) => amountEnd(file.lines[entry.at])));

    if (edit && (edit.date || edit.description != null)) {
      const parsed = parseHeader(file.lines[header]);
      if (!parsed) { missing.push({ id: row.id, why: 'its first line is not a transaction header' }); continue; }
      if (edit.date && row.ownDate) { missing.push({ id: row.id, why: 'the posting has a date of its own' }); continue; }
      change(file, header, formatHeader({ ...parsed, date: edit.date || parsed.date, description: edit.description != null ? edit.description : parsed.description }), row.id);
    }
    const parts = { ...own.parts };
    if (remarkIt) parts.mark = wanted === 'Cleared' ? '*' : '';
    const amountChanged = edit && edit.amount != null && edit.amount !== data.rows.find((entry) => entry.id === row.id).amount;
    if ((amountChanged || (edit && edit.other)) && !row.simple) {
      missing.push({ id: row.id, why: 'its amount and other account can only be changed in a transaction of two postings in one commodity' });
      continue;
    }
    if (amountChanged || assertTo != null) {
      // An amount hledger inferred is written out as it computed it; the transaction balances
      // exactly as before, and an assertion can then follow it.
      const amount = amountChanged || !parts.amount ? journalAmount(row.amount, data.style) : parts.amount.replace(/\s*=.*$/, '');
      parts.amount = assertTo != null ? `${amount} ${data.inclusive ? '=*' : '='} ${journalAmount(assertTo, data.style)}` : amount;
    }
    // Only the mark changing is the common case, and touches nothing but the mark.
    const onlyMark = parts.amount === own.parts.amount;
    change(file, own.at, onlyMark ? remark(file.lines[own.at], parts.mark) : formatPosting(parts, column, own.parts), row.id);
    if (row.simple && others.length === 1 && (amountChanged || (edit && edit.other))) {
      const other = { ...others[0].parts };
      if (edit.other) other.account = edit.other;
      // The other side follows: negated if it was written, left to hledger if it was not.
      if (amountChanged && other.amount) other.amount = journalAmount(-row.amount, data.style);
      change(file, others[0].at, formatPosting(other, column, others[0].parts), row.id);
    }
  }
  for (const file of files.values()) file.changes.sort((left, right) => left.line - right.line);

  // New postings and the final assertion go at the end of the file, new ones first, so the
  // assertion is checked after them.
  const lastFile = () => {
    const last = [...data.rows].reverse().find((row) => !row.generated && texts[row.where.file] != null);
    return last ? last.where.file : Object.keys(texts)[0];
  };
  for (const insert of inserts) {
    const beside = insert.after != null ? data.rows.find((row) => row.id === insert.after && row.date === insert.date && !row.generated) : null;
    const path = beside ? beside.where.file : insert.file || lastFile();
    const file = path ? lines(path) : null;
    if (!file) { missing.push({ id: insert.id, why: 'there is no file to add it to' }); continue; }
    let text = insertText(insert, data.account, data.style, ticked.has(insert.id));
    const assertTo = asserting.get(insert.id);
    if (assertTo != null) text = text.replace(/^(.*\n.*?)\n/, `$1 ${data.inclusive ? '=*' : '='} ${journalAmount(assertTo, data.style)}\n`);
    // Beside the transaction it explains, so hledger orders it where the statement has it.
    if (beside) file.inserted.push({ index: beside.where.last - 1, line: beside.where.last - 1, text });
    else file.appended += `${file.appended ? '\n' : ''}${text}`;
  }
  // The assertion, whether or not there is a file to append it to: a read-only journal still
  // gets it, to copy in by hand.
  const assertion = finish ? assertionText(finish.date, data.account, finish.balance, data.style, data.inclusive) : '';
  if (finish) {
    const path = finish.file || lastFile();
    const file = path ? lines(path) : null;
    if (file) file.appended += `${file.appended ? '\n' : ''}${assertion}`;
    else missing.push({ id: null, why: `${path || 'the journal'} cannot be read here, so the assertion has nowhere to go` });
  }
  const out = [];
  for (const file of files.values()) {
    if (!file.changes.length && !file.appended && !file.inserted.length) continue;
    // Insertions last, from the bottom up, so the line numbers of the changes still hold.
    const lines = [...file.lines];
    const order = file.inserted.map((entry, at) => ({ ...entry, at })).sort((left, right) => right.index - left.index || right.at - left.at);
    for (const entry of order) lines.splice(entry.index, 0, '', ...entry.text.trimEnd().split('\n'));
    let after = lines.join('\n');
    if (file.appended) after = `${after}${after.endsWith('\n') ? '' : '\n'}\n${file.appended}`;
    out.push({ path: file.path, before: file.before, after, changes: file.changes, appended: file.appended, inserted: file.inserted.map(({ line, text }) => ({ line, text })) });
  }
  return { files: out, missing, assertion, asserted: asserting.size };
}
