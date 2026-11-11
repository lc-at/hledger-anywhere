/**
 * Reconcile one account against a statement, in a window.
 *
 *     reconcile <account> [--statement YYYY-MM-DD] [--balance AMOUNT] [--commodity NAME]
 *
 * The window lists the account's postings since its last balance assertion, the point already
 * proven. On a journal from an opened folder, every change made in the window (a tick, an edit,
 * a new transaction, a date, the order of a day, a posting moved to this account) is written to
 * the file at once: the folder is read again first, so an edit made in another program is never
 * written over, the change is written, and hledger reads the file back, which both checks it
 * and is what the window then shows. If hledger refuses it, the file is put back. Finish, at a
 * difference of zero, previews and then writes an assertion-only transaction at the end of the
 * file. Only standard hledger is written.
 *
 * A journal that cannot be written (an upload) keeps its changes in the window and shows the
 * assertion to copy.
 *
 * The pure half is ./reconcile-data.js; the page is ./reconcile-window.js.
 */

import { page } from './reconcile-window.js';
import { carry, inferStyle, markConflicts, moveAccount, moveRefusal, neighbour, ordered, parseHeader, parsePosting, plan, readPrint, readTransaction, readable, styleOf, summarize, toMinor, quantityOf } from './reconcile-data.js';
import { quote, tokenize } from './chart-args.js';
import { beside, bridge, colorsOf, shell } from './window-kit.js';

/** A regular expression that matches `text` and nothing else. */
function literal(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Today in the browser's own time zone, as hledger writes a date. */
function today() {
  const now = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The line after `reconcile`: an account and the flags, or what is wrong with it. */
export function parseLine(args) {
  const words = tokenize(args);
  const out = { account: null, statement: null, balance: null, commodity: null };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const [flag, inline] = word.split('=');
    const value = () => (inline !== undefined ? inline : words[(index += 1)]);
    if (flag === '--statement' || flag === '--date') out.statement = value();
    else if (flag === '--balance') out.balance = value();
    else if (flag === '--commodity' || flag === '--cur') out.commodity = value();
    else if (word.startsWith('--')) return { error: `${word} is not something reconcile takes. It takes an account, --statement YYYY-MM-DD, --balance AMOUNT and --commodity NAME.` };
    else if (out.account) return { error: `one account at a time, so ${out.account} or ${word}? A name with a space in it needs quotes.` };
    else out.account = word;
  }
  if (!out.account) return { error: 'which account? For example: reconcile assets:bank:checking. Tab completes account names.' };
  if (out.statement && !/^\d{4}-\d{2}-\d{2}$/.test(out.statement)) return { error: `--statement takes a date as YYYY-MM-DD, not ${out.statement}.` };
  return out;
}

/**
 * The account a word names: itself if it is one, else the one account containing it, case
 * aside. Several is a question back, with them listed; none says so.
 */
export function resolveAccount(word, accounts) {
  const exact = accounts.find((name) => name === word) || accounts.find((name) => name.toLowerCase() === word.toLowerCase());
  if (exact) return { account: exact };
  const lower = word.toLowerCase();
  const matches = accounts.filter((name) => name.toLowerCase().includes(lower));
  // Of several, the ones that are not under another match are the real candidates:
  // `mandiri` matches Assets:Mandiri and Assets:Mandiri:Now5782, and means the first.
  const tops = matches.filter((name) => !matches.some((other) => other !== name && name.startsWith(`${other}:`)));
  if (tops.length === 1) return { account: tops[0] };
  if (!matches.length) return { error: `no account matches ${word}. Type accounts to list them.` };
  const shown = tops.slice(0, 8).join(', ');
  return { error: `${word} matches ${tops.length} accounts: ${shown}${tops.length > 8 ? ', ...' : ''}. Name one, or the whole path.` };
}

/**
 * The loaded file hledger means by a source path. The app mounts files under `/data/` and a
 * plain run of hledger at `/`, and a journal may itself be in a folder called data, so the path
 * is matched against the files the app has, by its end, the longest match winning.
 */
export function fileFor(source, paths) {
  const full = `/${String(source).replace(/^\/+/, '')}`;
  const matches = paths.filter((path) => full === `/${path}` || full.endsWith(`/${path}`));
  return matches.sort((left, right) => right.length - left.length)[0] || full.replace(/^\/+/, '');
}

/** The query that selects an account, with its subaccounts when it has any. */
function accountQuery(account, inclusive) {
  return inclusive ? `acct:^${literal(account)}(:|$)` : `acct:^${literal(account)}$`;
}

/** Each transaction's text, as written, from the files the app has. */
function textOf(host, file, first, last, cache) {
  if (!cache.has(file)) {
    // Not awaited, and it cannot be: the plan is worked out synchronously, so `read` has to
    // answer with the text itself. The app does; docs/plugins.md says so where the host API is
    // written down.
    const text = typeof host.read === 'function' ? host.read(file) : null;
    cache.set(file, text == null ? null : text.split('\n'));
  }
  const lines = cache.get(file);
  return lines ? lines.slice(first - 1, Math.max(last - 1, first)).join('\n').replace(/\s+$/, '') : null;
}

/**
 * Read the account's postings, as the window shows them. `inclusive` is worked out from the
 * account list once, when the window opens; after that every read is one run of hledger, which
 * matters on a large journal, where each run is seconds.
 */
async function readAccount(host, account, commodity, inclusive = null) {
  let subaccounts = inclusive;
  if (subaccounts == null) {
    const accounts = (await host.hledger('accounts')).split('\n').map((line) => line.trim()).filter(Boolean);
    subaccounts = accounts.some((name) => name.startsWith(`${account}:`));
  }
  const query = accountQuery(account, subaccounts);
  const json = await host.hledger(`print ${quote(query)} -O json`);
  const data = readPrint(JSON.parse(json || '[]'), account, { inclusive: subaccounts, wanted: commodity });
  const paths = (typeof host.files === 'function' ? host.files() : []).map((file) => file.path);
  if (data) {
    // Each row carries its transaction's text, as written, for the window's editor to start
    // from and for a change to find its transaction by.
    const cache = new Map();
    for (const row of data.rows) {
      row.where.file = fileFor(row.where.file, paths);
      row.text = textOf(host, row.where.file, row.where.first, row.where.last, cache);
    }
  }
  return { data, query };
}

/** Whether the files the rows are in can be written. */
function writableFiles(host, data, extra = []) {
  const files = typeof host.files === 'function' ? host.files() : [];
  const used = new Set([...data.rows.map((row) => row.where.file), ...extra]);
  const main = (files.find((file) => file.main) || files[0] || {}).path;
  if (!used.size && main) used.add(main);
  return [...used].map((path) => ({ path, writable: Boolean((files.find((file) => file.path === path) || {}).writable) }));
}

/** A short fingerprint of what the window was showing, to notice a journal that changed under it. */
export function fingerprint(data) {
  return data ? data.rows.map((row) => `${row.id}=${row.amount}${row.status[0]}`).join(';') : '';
}

/**
 * The row of `rows` that a window's snapshot of a row means, or null.
 *
 * A window can be behind the file: another program may have added a line above, which renames
 * every row after it. So a row is found by what it is, not its id: the same posting of a
 * transaction whose text is exactly what the window showed, nearest where it was. A transaction
 * whose text changed outside the window is not found, and a change to it is refused rather
 * than written onto lines the person never saw.
 */
export function resolveTarget(rows, target) {
  if (!target) return null;
  const text = (value) => String(value == null ? '' : value).replace(/\s+$/, '');
  const same = rows.filter((row) => row.where.file === target.file && row.account === target.account
    && row.where.occurrence === target.occurrence && text(row.text) === text(target.text));
  if (!same.length) return null;
  return same.reduce((best, row) => (Math.abs(row.where.first - target.first) < Math.abs(best.where.first - target.first) ? row : best));
}

/**
 * The hledger query for transactions of other accounts that may be the statement line this
 * account is missing: a posting of the amount, either sign, outside this account; and, with
 * words, a description matching them near the date.
 */
export function findQueries({ account, inclusive, amount, date, words, style }) {
  const out = [];
  const not = `not:${accountQuery(account, inclusive)}`;
  if (amount != null && amount !== 0) {
    const places = style.precision;
    const value = (Math.abs(amount) / 10 ** places).toFixed(places);
    out.push(`print ${quote(`amt:${value}`)} ${quote(not)}${date ? ` ${quote(`date:${shift(date, -60)}..${shift(date, 61)}`)}` : ''} -O json`);
  }
  const terms = String(words || '').trim().split(/\s+/).filter(Boolean);
  if (terms.length) {
    out.push(`print ${terms.map((word) => quote(`desc:${literal(word)}`)).join(' ')} ${quote(not)}${date ? ` ${quote(`date:${shift(date, -30)}..${shift(date, 31)}`)}` : ''} -O json`);
  }
  return out;
}

/** A date `days` away, as hledger writes one. */
function shift(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Candidates for a missing statement line, best first: each transaction of another account
 * that has a posting of the amount, or a description like the words, with the reasons it was
 * picked and its postings, each with the line it is on in the transaction's text.
 */
export function rankCandidates(transactions, { account, inclusive, amount, date, words, style, limit = 12 }) {
  const belongs = (name) => name === account || (inclusive && name.startsWith(`${account}:`));
  const terms = String(words || '').toLowerCase().split(/\s+/).filter(Boolean);
  const days = (left, right) => Math.round((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000);
  const seen = new Set();
  const out = [];
  for (const transaction of transactions) {
    const positions = transaction.tsourcepos || [];
    const file = String((positions[0] || {}).sourceName || '').replace(/^\/+/, '');
    const first = (positions[0] || {}).sourceLine || 0;
    const key = `${file}:${first}`;
    if (seen.has(key) || !first) continue;
    seen.add(key);
    if (transaction.tpostings.some((posting) => belongs(posting.paccount))) continue;
    const postings = transaction.tpostings.map((posting) => {
      const own = (posting.pamount || [])[0];
      const minor = own && own.acommodity === style.commodity ? toMinor(quantityOf(own), style.precision) : null;
      return {
        account: posting.paccount,
        amount: own ? readable(toMinor(quantityOf(own), styleOf(own).precision), styleOf(own)) : '',
        matches: amount != null && minor != null && Math.abs(minor) === Math.abs(amount),
        virtual: posting.ptype === 'VirtualPosting' || posting.ptype === 'BalancedVirtualPosting',
        generated: (posting.ptags || []).some(([name]) => /generated-posting/.test(name)),
      };
    });
    const reasons = [];
    let score = 0;
    if (postings.some((posting) => posting.matches)) { score += 4; reasons.push('the amount'); }
    const apart = date ? Math.abs(days(transaction.tdate, date)) : null;
    if (apart === 0) { score += 3; reasons.push('the date'); }
    else if (apart != null && apart <= 4) { score += 2; reasons.push(`${apart} day${apart === 1 ? '' : 's'} from the date`); }
    else if (apart != null && apart <= 14) score += 1;
    const description = String(transaction.tdescription || '').toLowerCase();
    const hits = terms.filter((word) => description.includes(word)).length;
    if (hits) { score += 2 + hits; reasons.push('the payee'); }
    if (!score) continue;
    out.push({ file, first, last: (positions[1] || positions[0] || {}).sourceLine || first, date: transaction.tdate, description: transaction.tdescription, postings, score, reasons, apart });
  }
  out.sort((left, right) => right.score - left.score || (left.apart ?? 0) - (right.apart ?? 0) || (left.date < right.date ? -1 : 1));
  return out.slice(0, limit);
}

/** A row's identity for a message: its date and description. */
const named = (row) => `${row.date} ${row.description}`.trim();

export default {
  async run(args, host) {
    const line = parseLine(args);
    if (line.error) {
      host.say(`${host.name}: ${line.error}`);
      return;
    }
    let accounts;
    try {
      accounts = (await host.hledger('accounts')).split('\n').map((name) => name.trim()).filter(Boolean);
    } catch (error) {
      host.say(`${host.name}: ${error && error.message ? error.message : error}`);
      return;
    }
    const resolved = resolveAccount(line.account, accounts);
    if (resolved.error) {
      host.say(`${host.name}: ${resolved.error}`);
      return;
    }
    const account = resolved.account;
    const colors = colorsOf(host);
    const view = host.window(`hledger: reconcile ${account}`);
    if (!view) {
      host.say(`${host.name}: the browser blocked the window for ${account}.`);
      return;
    }
    view.write(shell(colors, `reconcile ${account}`, 'Reading hledger…'));

    const inclusive = accounts.some((name) => name.startsWith(`${account}:`));
    let read;
    try {
      read = await readAccount(host, account, line.commodity, inclusive);
    } catch (error) {
      const why = error && error.message ? error.message : String(error);
      view.write(shell(colors, `reconcile ${account}`, why));
      host.say(`${host.name}: ${why}`);
      return;
    }
    if (!read.data) {
      view.write(shell(colors, `reconcile ${account}`, 'This account has no postings.'));
      host.say(`${host.name}: ${account} has no postings to reconcile.`);
      return;
    }
    let { data } = read;
    const remembered = typeof host.setting === 'function' ? host.setting('markStyle') : null;
    const markStyle = remembered === 'transaction' || remembered === 'posting' ? remembered : inferStyle(data.rows);
    const reread = async () => (await readAccount(host, account, data.commodity, data.inclusive)).data || { ...data, rows: [], start: data.start };

    // What was written, newest last, for Undo: each file as it was before and after.
    const history = [];
    // One thing at a time. Two writes running together would each plan against a file the
    // other is about to change, and a poll in the middle of a write would read half of it.
    let queue = Promise.resolve();
    const serial = (task) => {
      const next = queue.then(task, task);
      queue = next.catch(() => {});
      return next;
    };
    const why = (error) => String(error && error.message ? error.message : error).trim();

    /**
     * Take in what another program changed. Resolves with whether anything did, after the
     * account has been read again; rejects with hledger's words if the file as it now is cannot
     * be read, which is the outside edit's problem and not something to write on top of.
     */
    const sync = async () => {
      if (typeof host.refresh !== 'function') return { changed: false };
      const report = (await host.refresh()) || {};
      const changed = (report.changed || []).length > 0;
      if (changed) data = await reread();
      return { changed, missing: report.missing || [], error: report.error || null };
    };

    // A request from the window comes from another window's realm, so it is copied into plain
    // data here first.
    const plain = (value) => JSON.parse(JSON.stringify(value || {}));

    const work = (params) => {
      const texts = {};
      const extra = (params.replace || []).map((entry) => entry.file);
      for (const { path } of writableFiles(host, data, extra)) {
        const text = host.read(path);
        if (text != null) texts[path] = text;
      }
      return plan({ data, texts, ...params, style: params.style === 'transaction' ? 'transaction' : 'posting' });
    };

    const cleared = () => new Set(data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));

    /**
     * What a change from the window asks of the plan, worked out against the account as it is
     * now: `{ params, label }`, or `{ refused }` with the reason in words.
     */
    const build = (request) => {
      const style = request.style === 'transaction' ? 'transaction' : 'posting';
      const targets = request.targets || {};
      const find = (id) => (targets[id] ? resolveTarget(data.rows, targets[id]) : data.rows.find((row) => row.id === id) || null);
      const gone = (id) => {
        const target = targets[id];
        const said = target ? `${target.date || ''} ${target.description || ''}`.trim() : 'that line';
        return { refused: `${said} changed outside this window, so this change was not made. The window shows the file as it is now.` };
      };
      const floor = (date) => (date ? moveRefusal(data, date) : null);
      switch (request.kind) {
        case 'tick': {
          const ticked = cleared();
          const rows = [];
          for (const change of request.changes || []) {
            const row = find(change.id);
            if (!row) return gone(change.id);
            const group = style === 'transaction' ? data.rows.filter((entry) => entry.where.file === row.where.file && entry.where.first === row.where.first) : [row];
            for (const entry of group) if (change.on) ticked.add(entry.id); else ticked.delete(entry.id);
            rows.push({ row, on: change.on });
          }
          const label = rows.length === 1
            ? `${rows[0].on ? 'Ticked' : 'Unticked'} ${named(rows[0].row)}`
            : `${rows.filter((entry) => entry.on).length} ticked, ${rows.filter((entry) => !entry.on).length} unticked`.replace(/^0 ticked, |, 0 unticked$/g, '');
          return { params: { ticked, style }, label };
        }
        case 'edit': {
          const row = find(request.id);
          if (!row) return gone(request.id);
          const text = String(request.text || '').replace(/\s+$/, '');
          if (text) {
            const read = readTransaction(text, data.account, data.style, data.inclusive);
            if (!read.header) return { refused: 'The first line needs a date: 2026-09-05 Description.' };
            const refused = floor(read.date);
            if (refused) return { refused: `Not written: ${read.date} is ${refused}.` };
          }
          return { params: { ticked: cleared(), edits: { [row.id]: { text } }, style }, label: text ? `Rewrote ${named(row)}` : `Deleted ${named(row)}` };
        }
        case 'insert': {
          const text = String(request.text || '').replace(/\s+$/, '');
          const read = readTransaction(text, data.account, data.style, data.inclusive);
          if (!read.header) return { refused: 'A new transaction needs a first line with its date: 2026-09-05 Description.' };
          const refused = floor(read.date);
          if (refused) return { refused: `Not added: ${read.date} is ${refused}.` };
          // The row it was added after may have changed outside; then it goes by its date alone.
          const anchor = request.after ? find(request.after) : null;
          const ticked = cleared();
          ticked.add('new');
          return { params: { ticked, inserts: [{ id: 'new', text, after: anchor ? anchor.id : null }], style }, label: `Added ${read.date} ${read.description || ''}`.trim(), inserted: true };
        }
        case 'date': {
          const row = find(request.id);
          if (!row) return gone(request.id);
          const refused = floor(request.date);
          if (refused) return { refused: `Cannot move it to ${request.date}: it is ${refused}.` };
          return { params: { ticked: cleared(), moved: { [row.id]: request.date }, style }, label: `Moved ${row.description} to ${request.date}` };
        }
        case 'reorder': {
          const row = find(request.id);
          if (!row) return gone(request.id);
          const where = neighbour(ordered(data), row.id, request.direction);
          if (where.refused) return { refused: `${row.description} stays where it is: ${where.refused}.` };
          return { params: { ticked: cleared(), relocate: [{ id: row.id, to: where.to }], style }, label: `Moved ${row.description} ${request.direction === 'down' ? 'down' : 'up'} within ${row.date}` };
        }
        case 'account': {
          const candidate = request.candidate || {};
          const lines = String(candidate.text || '').split('\n');
          const parts = lines[request.at] != null ? parsePosting(lines[request.at]) : null;
          if (!parts) return { refused: 'That posting is not in the transaction any more.' };
          const after = moveAccount(candidate.text, request.at, data.account);
          return {
            params: { ticked: cleared(), replace: [{ file: candidate.file, first: candidate.first, last: candidate.last, before: candidate.text, after }], style },
            label: `Moved ${candidate.description}'s ${parts.account} posting to ${data.account}`,
            inserted: true,
          };
        }
        case 'finish': {
          const finish = request.finish || {};
          const now = summarize({ data, ticked: cleared(), statementDate: finish.date, statementBalance: finish.balance });
          if (now.tooEarly) return { refused: `The statement date is before ${data.start.date}, where this account's balance is already asserted.` };
          if (now.outstanding.length) return { refused: `${now.outstanding.length} line${now.outstanding.length === 1 ? '' : 's'} up to ${finish.date} ${now.outstanding.length === 1 ? 'is' : 'are'} not ticked in the file; an assertion counts every one.` };
          if (now.difference !== 0) return { refused: 'The file as it is now does not give the statement\'s balance, so nothing was asserted.' };
          // Typed running balances are the window's, keyed by the rows it showed.
          const expected = {};
          for (const [id, value] of Object.entries(request.expected || {})) {
            const row = find(id);
            if (row) expected[row.id] = value;
          }
          return { params: { ticked: cleared(), finish, expected, style }, label: `${account} reconciled to ${finish.date}`, finish: true };
        }
        default:
          return { refused: `${request.kind} is not a change this window makes.` };
      }
    };

    /**
     * Write a planned change, check it with hledger, and put everything back if hledger refuses.
     * `progress` is told 'writing' and then 'checking', so the window can say which.
     */
    const commit = async (result, label, progress, extra = {}) => {
      const tell = (stage) => { try { if (typeof progress === 'function') progress(stage); } catch { /* a closed window */ } };
      if (result.missing.length) return { error: `Not written: ${[...new Set(result.missing.map((entry) => entry.why))].join('; ')}.`, data };
      if (!result.files.length) return { ok: true, message: 'Nothing to change', data, undo: history.length };
      const files = typeof host.files === 'function' ? host.files() : [];
      const locked = result.files.filter((file) => !(files.find((entry) => entry.path === file.path) || {}).writable);
      if (locked.length) return { error: `${locked.map((file) => file.path).join(', ')} cannot be written: it did not come from an opened folder. Run open in the terminal, then reconcile again.`, data };
      tell('writing');
      const written = [];
      const putBack = async () => {
        const failed = [];
        for (const done of written.reverse()) {
          const answer = await host.save(done.path, done.before);
          if (answer && answer.error) failed.push(`${done.path} (${answer.error})`);
        }
        return failed;
      };
      for (const file of result.files) {
        const answer = await host.save(file.path, file.after);
        if (answer && answer.error) {
          const failed = await putBack();
          return { error: `${file.path} could not be saved: ${answer.error}${written.length ? (failed.length ? `. Could not put back ${failed.join(', ')}` : `. ${written.map((done) => done.path).join(', ')} put back as it was`) : ''}.`, data };
        }
        written.push(file);
      }
      tell('checking');
      const before = data;
      try {
        data = await reread();
      } catch (error) {
        const paths = written.map((file) => file.path);
        const failed = await putBack();
        return {
          error: `hledger refused it, so ${failed.length ? `the files could not all be put back: ${failed.join(', ')}` : `${paths.join(', ')} ${paths.length === 1 ? 'was' : 'were'} put back as ${paths.length === 1 ? 'it was' : 'they were'}`}. hledger said: ${why(error)}`,
          restored: paths,
          data,
        };
      }
      history.push({ label, files: result.files.map((file) => ({ path: file.path, before: file.before, after: file.after })) });
      const map = carry(before.rows, data.rows);
      const claimed = new Set(map.values());
      // A new row, or one moved here from another account, is where the person's eye goes next.
      const focus = extra.inserted ? (data.rows.find((row) => !claimed.has(row.id)) || {}).id || null : null;
      return { ok: true, message: label, data, undo: history.length, focus, ...extra.answer };
    };

    // The window asks the plugin to preview and apply, since only this side can reach the files.
    const token = bridge('__reconcileBridges', 'reconcile', {
      /**
       * What Finish would write, after reading the folder again. A request without a kind is
       * the window's own state, ticks and edits kept in it, which is how a journal that cannot
       * be written is previewed.
       */
      preview(request) {
        const plainRequest = plain(request);
        const answer = () => {
          let result;
          if (plainRequest.kind) {
            const built = build(plainRequest);
            if (built.refused) return { files: [], missing: [{ id: null, why: built.refused }], assertion: '', writable: writableFiles(host, data), conflicts: [], data };
            result = work(built.params);
          } else {
            const { ticked, finish, edits = {}, inserts = [], expected = {}, moved = {}, style, relocate = [], replace = [] } = plainRequest;
            result = work({ ticked: new Set(ticked), finish, edits, inserts, expected, moved, relocate, replace, style });
          }
          const until = plainRequest.finish && plainRequest.finish.date;
          return {
            files: result.files.map((file) => ({ path: file.path, changes: file.changes, appended: file.appended, inserted: file.inserted, replaced: file.replaced })),
            missing: result.missing,
            assertion: result.assertion,
            writable: writableFiles(host, data),
            conflicts: markConflicts(data.rows.filter((row) => !until || row.date <= until), plainRequest.style === 'transaction' ? 'transaction' : 'posting'),
          };
        };
        // A window that can write is behind a file another program may have changed, so it is
        // read again first; one that cannot is answered straight away, as it always was.
        if (!plainRequest.kind) return answer();
        return serial(async () => {
          let changed = false;
          try {
            ({ changed } = await sync());
          } catch (error) {
            return { files: [], missing: [{ id: null, why: `hledger reports a problem in the file as it is now: ${why(error)}` }], assertion: '', writable: writableFiles(host, data), conflicts: [] };
          }
          return { ...answer(), ...(changed ? { data } : {}) };
        });
      },
      setLines(on) {
        if (typeof host.remember === 'function') host.remember('lineByLine', on ? 'on' : 'off');
        return Boolean(on);
      },
      setStyle(style) {
        const wanted = style === 'transaction' ? 'transaction' : 'posting';
        if (typeof host.remember === 'function') host.remember('markStyle', wanted);
        return wanted;
      },
      /**
       * One change from the window, written at once: the folder read again, the change found by
       * its text, written, read back by hledger, and put back if hledger refuses it.
       */
      change(request, progress) {
        const ask = plain(request);
        return serial(async () => {
          let outside = false;
          try {
            ({ changed: outside } = await sync());
          } catch (error) {
            return { error: `hledger reports a problem in the file as it is now, so nothing was written: ${why(error)}`, data };
          }
          const built = build(ask);
          if (built.refused) return { error: built.refused, data, outside };
          const answer = await commit(work(built.params), built.label, progress, { inserted: built.inserted, answer: { outside } });
          if (built.finish && answer.ok) host.say(`${host.name}: ${built.label}.`);
          return { outside, ...answer };
        });
      },
      /** Undo the last change written from this window, unless the file has moved on since. */
      undo(progress) {
        return serial(async () => {
          const last = history[history.length - 1];
          if (!last) return { error: 'Nothing to undo: no change has been written from this window.', data };
          try {
            await sync();
          } catch (error) {
            return { error: `hledger reports a problem in the file as it is now, so nothing was undone: ${why(error)}`, data };
          }
          const moved = last.files.filter((file) => host.read(file.path) !== file.after);
          if (moved.length) {
            history.length = 0;
            return { error: `${moved.map((file) => file.path).join(', ')} changed since "${last.label}" was written, so it was not undone: that would write over the newer edit.`, data, undo: 0 };
          }
          history.pop();
          const answer = await commit({ files: last.files.map((file) => ({ path: file.path, before: file.after, after: file.before })), missing: [] }, `Undid: ${last.label}`, progress);
          // Undoing is not itself something to undo.
          if (answer.ok) history.pop();
          else history.push(last);
          return { ...answer, undo: history.length };
        });
      },
      /** Whether another program changed the folder, and the account as it is now if it did. */
      poll() {
        return serial(async () => {
          try {
            const { changed, missing } = await sync();
            return changed ? { changed, data, missing } : { changed: false, missing };
          } catch (error) {
            return { changed: true, error: `The file changed outside this window, and hledger cannot read it as it is now: ${why(error)}` };
          }
        });
      },
      /** A loaded file's text, for the window's view of the whole file. */
      source(path) {
        const text = typeof host.read === 'function' ? host.read(String(path)) : null;
        return text == null ? null : String(text);
      },
      /**
       * Transactions of other accounts that may be the line this account is missing, best
       * first, each with its text and where it is, for the window to show and move.
       */
      find(request) {
        const ask = plain(request);
        return serial(async () => {
          const style = data.style;
          const queries = findQueries({ account: data.account, inclusive: data.inclusive, amount: ask.amount, date: ask.date, words: ask.words, style });
          if (!queries.length) return { candidates: [], error: 'Give an amount, or some words from the description, to look for.' };
          const found = [];
          try {
            for (const command of queries) found.push(...JSON.parse((await host.hledger(command)) || '[]'));
          } catch (error) {
            return { candidates: [], error: why(error) };
          }
          const paths = (typeof host.files === 'function' ? host.files() : []).map((file) => file.path);
          const cache = new Map();
          const candidates = rankCandidates(found, { account: data.account, inclusive: data.inclusive, amount: ask.amount, date: ask.date, words: ask.words, style }).map((candidate) => {
            const file = fileFor(candidate.file, paths);
            const text = textOf(host, file, candidate.first, candidate.last, cache);
            // Each posting's line in the text, so "move this one" names a line, not a guess.
            const lines = String(text || '').split('\n');
            const at = [];
            lines.forEach((entry, index) => { if (index > 0 && /^[ \t]/.test(entry) && !entry.trim().startsWith(';') && parsePosting(entry)) at.push(index); });
            return { ...candidate, file, text, postings: candidate.postings.map((posting, index) => ({ ...posting, at: at[index] ?? null })) };
          }).filter((candidate) => candidate.text != null && parseHeader(candidate.text.split('\n')[0] || ''));
          return { candidates };
        });
      },
      /**
       * The window's whole state written in one go: what Save did before every change was written
       * as it was made. Kept for a request that carries ticks, edits and new lines together.
       */
      apply(request, progress) {
        const ask = plain(request);
        return serial(async () => {
          try {
            await sync();
          } catch (error) {
            return { error: `hledger already reports a problem, so nothing was written: ${why(error)}`, data, fingerprint: fingerprint(data) };
          }
          if (fingerprint(data) !== ask.fingerprint) {
            return { error: 'The journal changed since this window was drawn, so it has been read again. Check the ticks and try again.', data, fingerprint: fingerprint(data) };
          }
          const { ticked = [], finish = null, edits = {}, inserts = [], expected = {}, moved = {}, style, relocate = [], replace = [] } = ask;
          const result = work({ ticked: new Set(ticked), finish, edits, inserts, expected, moved, relocate, replace, style });
          const lines = result.files.reduce((sum, file) => sum + file.changes.length, 0);
          const rewritten = result.files.reduce((sum, file) => sum + file.replaced.filter((block) => block.after).length, 0);
          const deleted = result.files.reduce((sum, file) => sum + file.replaced.filter((block) => !block.after).length, 0);
          const added = inserts.length;
          const done = [
            lines && `${lines} line${lines === 1 ? '' : 's'} changed`,
            rewritten && `${rewritten} transaction${rewritten === 1 ? '' : 's'} rewritten`,
            deleted && `${deleted} deleted`,
            added && `${added} posting${added === 1 ? '' : 's'} added`,
            result.asserted && `${result.asserted} running balance${result.asserted === 1 ? '' : 's'} asserted`,
          ].filter(Boolean).join(', ');
          const what = finish
            ? `${account} reconciled to ${finish.date}: ${done ? `${done}, and ` : ''}the statement balance asserted`
            : `${account}: saved, ${done || 'nothing to change'}`;
          const answer = await commit(result, what, progress);
          if (answer.ok) host.say(`${host.name}: ${what}.`);
          return { ...answer, message: answer.ok ? what : answer.message, fingerprint: fingerprint(data) };
        });
      },
    });

    view.write(page({
      data,
      colors,
      token,
      files: writableFiles(host, data),
      accounts,
      statementDate: line.statement || today(),
      statementBalance: line.balance,
      fingerprint: fingerprint(data),
      style: markStyle,
      lines: (typeof host.setting === 'function' ? host.setting('lineByLine') : null) === 'on',
      module: beside('reconcile-window.js'),
    }));
    const from = data.start ? `since the balance asserted on ${data.start.date}` : 'with no balance asserted yet';
    host.say(`${host.name}: ${data.rows.length} postings of ${account} in ${data.commodity || 'its commodity'} ${from}, in a new window.`);
  },
};
