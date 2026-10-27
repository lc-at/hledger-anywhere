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
 * in file order, with a new posting after the posting it was added beside, or after the day's
 * others. Each row gets `balance`, the account's balance after it, which is what a statement
 * prints beside each line and what a balance assertion on that posting would assert.
 *
 * An edit is the transaction's whole text, written by hand. Its postings to the account are one
 * row, read from the text; an emptied text is a deleted transaction, and its rows go. When the
 * account's amount cannot be worked out from the text alone, it is null, and so is every balance
 * after it, until hledger has read it.
 */
export function ordered(data, { edits = {}, inserts = [] } = {}) {
  const rows = [];
  const editedTransactions = new Set();
  data.rows.forEach((row, at) => {
    const transaction = transactionOf(row);
    const edit = edits[row.id];
    if (edit && edit.text != null) {
      editedTransactions.add(transaction);
      if (!edit.text.trim()) return;
      const read = readTransaction(edit.text, data.account, data.style, data.inclusive);
      rows.push({ ...row, date: read.date || row.date, description: read.description != null ? read.description : row.description, against: read.against, amount: read.amount, at, edited: true, unknown: read.amount == null });
      return;
    }
    // A transaction edited through another of its rows is that row now.
    if (data.rows.some((other) => other !== row && transactionOf(other) === transaction && edits[other.id] && edits[other.id].text != null)) return;
    rows.push({ ...row, at, edited: false });
  });
  void editedTransactions;
  inserts.forEach((insert, at) => {
    const read = readTransaction(insert.text || '', data.account, data.style, data.inclusive);
    const date = read.date || insert.date;
    const beside = insert.after != null ? data.rows.findIndex((row) => row.id === insert.after && row.date === date) : -1;
    rows.push({
      id: insert.id, date, description: read.description || '', account: data.account, against: read.against,
      amount: read.amount, unknown: read.amount == null, status: 'Unmarked', inserted: true,
      at: beside >= 0 ? beside + 0.5 + at / 1000 : data.rows.length + at,
      where: { file: insert.file || null, first: 0, last: 0, occurrence: 0 },
    });
  });
  rows.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : left.at - right.at));
  let balance = data.start ? data.start.balance : 0;
  for (const row of rows) {
    balance = balance == null || row.amount == null ? null : balance + row.amount;
    row.balance = balance;
  }
  return rows;
}

/** Which transaction a row is in: its file and first line. */
function transactionOf(row) {
  return `${row.where.file}:${row.where.first}`;
}

/**
 * An amount as written in a journal, in the reconciled commodity's minor units, or null if it
 * is in another commodity or cannot be read. A cost (`@`) and an assertion (`=`) are not part of
 * the amount.
 */
export function readAmount(text, style) {
  const plain = String(text).split(/\s=|^=/)[0].split('@')[0].trim();
  if (!plain) return null;
  const match = /^(-?)\s*([^\d\s.,+-][^\d\s-]*?|"[^"]+")?\s*(-?)\s*([\d][\d.,]*)\s*([^\d\s.,][^\s]*|"[^"]+")?$/.exec(plain);
  if (!match) return null;
  const commodity = (match[2] || match[5] || '').replace(/^"|"$/g, '');
  if (commodity !== (style.commodity || '')) return null;
  const minor = parseInput(match[4], style);
  if (minor == null) return null;
  return match[1] === '-' || match[3] === '-' ? -minor : minor;
}

/**
 * What a transaction written by hand means for the account, without hledger: its date and
 * description, the other accounts, and the sum of its postings to the account. An amount left
 * out is worked out as hledger does, when it is the only one and the rest are in the account's
 * commodity; anything more (costs, several commodities, two amounts left out) is `null`, for
 * hledger to read on Save. `values` is each account posting's amount, written or worked out.
 */
export function readTransaction(text, account, style, inclusive = false) {
  const lines = String(text || '').split('\n');
  const headerAt = lines.findIndex((line) => line.trim() && !/^[;#*]/.test(line.trim()));
  const header = headerAt >= 0 ? parseHeader(lines[headerAt]) : null;
  const postings = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!/^[ \t]/.test(line) || line.trim().startsWith(';')) continue;
    const parts = parsePosting(line);
    if (!parts) continue;
    const virtual = parts.open === '(';
    postings.push({ account: parts.account, written: Boolean(parts.amount && !/^=/.test(parts.amount)), value: parts.amount && !/^=/.test(parts.amount) ? readAmount(parts.amount, style) : null, virtual, raw: parts.amount });
  }
  const ours = postings.filter((posting) => belongs(posting.account, account, inclusive));
  const against = postings.filter((posting) => !belongs(posting.account, account, inclusive)).map((posting) => posting.account).join(', ');
  const balancing = postings.filter((posting) => !posting.virtual);
  const blanks = balancing.filter((posting) => !posting.written);
  const readable = balancing.filter((posting) => posting.written).every((posting) => posting.value != null);
  const values = ours.map((posting) => {
    if (posting.written) return posting.value;
    if (blanks.length !== 1 || !readable) return null;
    return -balancing.filter((other) => other.written).reduce((sum, other) => sum + other.value, 0);
  });
  const amount = !header || values.some((value) => value == null) ? null : values.reduce((sum, value) => sum + value, 0);
  // With every amount written and readable, they must add up to nothing, or hledger refuses it.
  const off = !blanks.length && readable && balancing.length ? balancing.reduce((sum, posting) => sum + posting.value, 0) : 0;
  return { date: header ? header.date : null, description: header ? header.description : null, against, amount, values, touches: ours.length > 0, header: Boolean(header), off, postings: balancing.length };
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
    if (row.balance == null) continue;
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
  // An edit whose amount cannot be read yet leaves the totals unknown until it is saved.
  const unknown = inRange.filter((row) => row.amount == null).length;
  const tickedTotal = unknown ? null : on.reduce((sum, row) => sum + row.amount, 0);
  const expected = unknown ? null : opening + tickedTotal;
  const outstanding = inRange.filter((row) => !ticked.has(row.id));
  const difference = statementBalance == null || expected == null ? null : statementBalance - expected;
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
    unknown,
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
    if (row.amount == null) continue;
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
  const head = /^([ \t]+)(?:([*!])([ \t]*))?(.*)$/.exec(line);
  if (!head || !head[4] || head[4].startsWith(';')) return null;
  // An account name ends at a tab or two spaces, which is what separates it from the amount; a
  // single space is part of the name ("equity:opening balances").
  const separator = /\t| {2,}/.exec(head[4]);
  const name = (separator ? head[4].slice(0, separator.index) : head[4]).trimEnd();
  const rest = separator ? head[4].slice(separator.index + separator[0].length) : '';
  const bracket = /^([([])(.*)([)\]])$/.exec(name);
  const at = rest.indexOf(';');
  return {
    indent: head[1], mark: head[2] || '', markGap: head[3] || '',
    open: bracket ? bracket[1] : '', account: bracket ? bracket[2] : name, close: bracket ? bracket[3] : '',
    gap: separator ? separator[0] : '', amount: (at >= 0 ? rest.slice(0, at) : rest).trim(), comment: at >= 0 ? rest.slice(at).trimEnd() : '',
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

/** The text a new posting starts from: a date, a description to write, the account and an amount. */
export function template(date, account, minor, style) {
  return `${date} \n    ${account}    ${minor == null ? '' : journalAmount(minor, style)}\n    `;
}

/** The transaction that proves the statement balance: one posting of nothing, asserting. */
export function assertionText(date, account, minor, style, inclusive = false) {
  const zero = journalAmount(0, style);
  return `${date} * Reconciled with statement\n    ${account}    ${zero} ${inclusive ? '=*' : '='} ${journalAmount(minor, style)}\n`;
}

/**
 * The text changes that record a reconciliation, for each file touched.
 *
 * `texts` maps a file path to its contents as the app has it. A transaction is changed as a
 * block of lines, found where hledger said it is: replaced by an edit's text, re-marked where a
 * tick changed (the reconciled account's postings only), and given an assertion on its last
 * posting to the account when a typed running balance matches. A new transaction is written
 * after the one it was added beside, or at the end; with `finish`, the statement's assertion
 * goes last. Anything that cannot be done exactly is reported in `missing`, never guessed at.
 */
export function plan({ data, texts, ticked, finish = null, edits = {}, inserts = [], expected = {} }) {
  const files = new Map();
  const missing = [];
  const fileOf = (path) => {
    if (!files.has(path)) {
      if (texts[path] == null) return null;
      files.set(path, { path, before: texts[path], lines: texts[path].split('\n'), changes: [], blocks: [], appended: '', inserted: [] });
    }
    return files.get(path);
  };
  const rows = ordered(data, { edits, inserts });
  const asserting = new Map(checkpoints(rows, expected).points.filter((point) => point.difference === 0).map((point) => [point.id, point.balance]));
  const sign = data.inclusive ? '=*' : '=';

  /** The lines in a block that post to the account, in order. */
  const ourLines = (block, exact = null) => block
    .map((line, at) => ({ line, at, parts: /^[ \t]/.test(line) && !line.trim().startsWith(';') ? parsePosting(line) : null }))
    .filter((entry) => entry.parts && (exact ? entry.parts.account === exact : belongs(entry.parts.account, data.account, data.inclusive)));

  /** Put an assertion on a posting line, writing out an amount hledger would infer. */
  const assertOn = (block, at, value, balance) => {
    const parts = parsePosting(block[at]);
    const written = parts.amount && !/^=/.test(parts.amount) ? parts.amount.replace(/\s*=.*$/, '') : null;
    if (!written && value == null) return false;
    const column = Math.max(0, ...block.map((line) => amountEnd(line)));
    block[at] = formatPosting({ ...parts, amount: `${written || journalAmount(value, data.style)} ${sign} ${journalAmount(balance, data.style)}` }, column, parts);
    return true;
  };

  const groups = new Map();
  for (const row of data.rows) {
    if (!groups.has(transactionOf(row))) groups.set(transactionOf(row), []);
    groups.get(transactionOf(row)).push(row);
  }
  for (const group of groups.values()) {
    const editedRow = group.find((row) => edits[row.id] && edits[row.id].text != null);
    const marks = editedRow ? (ticked.has(editedRow.id) ? [editedRow] : []) : group.filter((row) => {
      const wanted = ticked.has(row.id) ? 'Cleared' : 'Unmarked';
      return !(row.status === wanted || (wanted === 'Unmarked' && row.status === 'Pending'));
    });
    const assertRow = group.find((row) => asserting.has(row.id));
    if (!editedRow && !marks.length && !assertRow) continue;
    const first = group[0];
    if (group.some((row) => row.generated)) { missing.push({ id: first.id, why: 'generated by a rule, not written in the file' }); continue; }
    const file = fileOf(first.where.file);
    if (!file) { missing.push({ id: first.id, why: `${first.where.file} is not loaded` }); continue; }
    const start = first.where.first - 1;
    const end = Math.max(first.where.last - 1, first.where.first);
    const block = file.lines.slice(start, end);
    if (!parseHeader(block[0] || '')) { missing.push({ id: first.id, why: 'its first line is not where hledger said it was' }); continue; }
    let next;
    if (editedRow) {
      const text = edits[editedRow.id].text;
      next = text.trim() ? text.replace(/\s+$/, '').split('\n') : [];
      if (next.length && ticked.has(editedRow.id)) for (const entry of ourLines(next)) next[entry.at] = remark(next[entry.at], '*');
      if (next.length && assertRow) {
        const ours = ourLines(next);
        const read = readTransaction(next.join('\n'), data.account, data.style, data.inclusive);
        const last = ours[ours.length - 1];
        if (!last || !assertOn(next, last.at, read.values[read.values.length - 1], asserting.get(assertRow.id))) {
          missing.push({ id: editedRow.id, why: 'the edited transaction\'s amount cannot be worked out here, so its running balance cannot be asserted; Save it first' });
          continue;
        }
      }
    } else {
      next = [...block];
      for (const row of group) {
        const own = ourLines(next, row.account)[row.where.occurrence];
        if (!own) { missing.push({ id: row.id, why: 'its line was not found where hledger said it was' }); next = null; break; }
        if (marks.includes(row)) next[own.at] = remark(next[own.at], ticked.has(row.id) ? '*' : '');
        if (asserting.has(row.id)) assertOn(next, own.at, row.amount, asserting.get(row.id));
      }
      if (!next) continue;
    }
    if (next.length === block.length) {
      next.forEach((line, at) => {
        if (line !== block[at]) file.changes.push({ line: start + at + 1, before: block[at], after: line, id: first.id });
      });
      for (let at = 0; at < next.length; at += 1) file.lines[start + at] = next[at];
    } else {
      file.blocks.push({ index: start, count: block.length, lines: next, line: start + 1, before: block.join('\n'), after: next.join('\n') });
    }
  }
  for (const file of files.values()) file.changes.sort((left, right) => left.line - right.line);

  const lastFile = () => {
    const last = [...data.rows].reverse().find((row) => !row.generated && texts[row.where.file] != null);
    return last ? last.where.file : Object.keys(texts)[0];
  };
  for (const insert of inserts) {
    const lines = String(insert.text || '').replace(/\s+$/, '').split('\n');
    const read = readTransaction(lines.join('\n'), data.account, data.style, data.inclusive);
    if (!read.header) { missing.push({ id: insert.id, why: 'a new transaction needs a first line with its date' }); continue; }
    if (ticked.has(insert.id)) for (const entry of ourLines(lines)) lines[entry.at] = remark(lines[entry.at], '*');
    if (asserting.has(insert.id)) {
      const ours = ourLines(lines);
      const last = ours[ours.length - 1];
      if (!last || !assertOn(lines, last.at, read.values[read.values.length - 1], asserting.get(insert.id))) {
        missing.push({ id: insert.id, why: 'the new transaction\'s amount cannot be worked out here, so its running balance cannot be asserted' });
        continue;
      }
    }
    const text = `${lines.join('\n')}\n`;
    const beside = insert.after != null ? data.rows.find((row) => row.id === insert.after && row.date === read.date && !row.generated) : null;
    const path = beside ? beside.where.file : insert.file || lastFile();
    const file = path ? fileOf(path) : null;
    if (!file) { missing.push({ id: insert.id, why: 'there is no file to add it to' }); continue; }
    // Beside the transaction it explains, so hledger orders it where the statement has it.
    if (beside) file.inserted.push({ index: beside.where.last - 1, line: beside.where.last - 1, text });
    else file.appended += `${file.appended ? '\n' : ''}${text}`;
  }
  // The assertion, whether or not there is a file to append it to: a read-only journal still
  // gets it, to copy in by hand.
  const assertion = finish ? assertionText(finish.date, data.account, finish.balance, data.style, data.inclusive) : '';
  if (finish) {
    const path = finish.file || lastFile();
    const file = path ? fileOf(path) : null;
    if (file) file.appended += `${file.appended ? '\n' : ''}${assertion}`;
    else missing.push({ id: null, why: `${path || 'the journal'} cannot be read here, so the assertion has nowhere to go` });
  }
  const out = [];
  for (const file of files.values()) {
    if (!file.changes.length && !file.appended && !file.inserted.length && !file.blocks.length) continue;
    // Replaced and inserted blocks last, from the bottom up, so every line number still holds.
    const lines = [...file.lines];
    const edits = [
      ...file.blocks.map((entry, at) => ({ index: entry.index, count: entry.count, lines: entry.lines, at })),
      ...file.inserted.map((entry, at) => ({ index: entry.index, count: 0, lines: ['', ...entry.text.trimEnd().split('\n')], at: 1000 + at })),
    ].sort((left, right) => right.index - left.index || right.at - left.at);
    for (const entry of edits) {
      let count = entry.count;
      // A deleted transaction takes one of the blank lines around it, so no double gap is left.
      if (!entry.lines.length && lines[entry.index + count] === '' && (entry.index === 0 || lines[entry.index - 1] === '')) count += 1;
      lines.splice(entry.index, count, ...entry.lines);
    }
    let after = lines.join('\n');
    if (file.appended) after = `${after}${after.endsWith('\n') ? '' : '\n'}\n${file.appended}`;
    out.push({
      path: file.path, before: file.before, after, changes: file.changes, appended: file.appended,
      inserted: file.inserted.map(({ line, text }) => ({ line, text })),
      replaced: file.blocks.map(({ line, before, after: written }) => ({ line, before, after: written })),
    });
  }
  return { files: out, missing, assertion, asserted: asserting.size };
}
