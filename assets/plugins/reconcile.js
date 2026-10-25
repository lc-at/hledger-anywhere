/**
 * Reconcile one account against a statement, in a window.
 *
 *     reconcile <account> [--statement YYYY-MM-DD] [--balance AMOUNT] [--commodity NAME]
 *
 * The window lists the account's postings since its last balance assertion, the point already
 * proven. Tick what the statement shows; at a difference of zero, Finish writes a posting-level
 * `*` on each ticked posting and an assertion-only transaction at the end of the file, and
 * hledger is run to confirm the assertion holds, the file put back if it does not. Save progress
 * writes the marks alone. Only standard hledger is written.
 *
 * The pure half is ./reconcile-data.js; the page is ./reconcile-window.js.
 */

import { page } from './reconcile-window.js';
import { plan, readPrint } from './reconcile-data.js';
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
    else if (out.account) return { error: `one account at a time: ${out.account} or ${word}?` };
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
  if (!matches.length) return { error: `no account matches ${word}.` };
  const shown = tops.slice(0, 8).join(', ');
  return { error: `${word} matches ${tops.length} accounts: ${shown}${tops.length > 8 ? ', ...' : ''}. Name one.` };
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

/** Read the account's postings, as the window shows them. */
async function readAccount(host, account, commodity) {
  const accounts = (await host.hledger('accounts')).split('\n').map((line) => line.trim()).filter(Boolean);
  const inclusive = accounts.some((name) => name.startsWith(`${account}:`));
  const query = inclusive ? `acct:^${literal(account)}(:|$)` : `acct:^${literal(account)}$`;
  const json = await host.hledger(`print ${quote(query)} -O json`);
  const data = readPrint(JSON.parse(json || '[]'), account, { inclusive, wanted: commodity });
  const paths = (typeof host.files === 'function' ? host.files() : []).map((file) => file.path);
  if (data) for (const row of data.rows) row.where.file = fileFor(row.where.file, paths);
  return { data, query };
}

/** Whether the files the rows are in can be written. */
function writableFiles(host, data) {
  const files = typeof host.files === 'function' ? host.files() : [];
  const used = new Set(data.rows.map((row) => row.where.file));
  const main = (files.find((file) => file.main) || files[0] || {}).path;
  if (!used.size && main) used.add(main);
  return [...used].map((path) => ({ path, writable: Boolean((files.find((file) => file.path === path) || {}).writable) }));
}

/** A short fingerprint of what the window was showing, to notice a journal that changed under it. */
export function fingerprint(data) {
  return data ? data.rows.map((row) => `${row.id}=${row.amount}${row.status[0]}`).join(';') : '';
}

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

    let read;
    try {
      read = await readAccount(host, account, line.commodity);
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
    const check = `balance ${quote(read.query)} -O csv`;

    const work = ({ ticked, finish }) => {
      const set = new Set(ticked);
      const texts = {};
      for (const { path } of writableFiles(host, data)) {
        const text = host.read(path);
        if (text != null) texts[path] = text;
      }
      return plan({ data, texts, ticked: set, finish });
    };

    // The window asks the plugin to preview and apply, since only this side can reach the files.
    const token = bridge('__reconcileBridges', 'reconcile', {
      preview(request) {
        const result = work(request);
        return {
          files: result.files.map((file) => ({ path: file.path, changes: file.changes, appended: file.appended })),
          missing: result.missing,
          assertion: result.assertion,
          writable: writableFiles(host, data),
        };
      },
      async apply(request) {
        // The journal may have changed since the window was drawn: re-read, and refuse to write
        // marks onto lines that are no longer the ones that were ticked.
        const fresh = (await readAccount(host, account, data.commodity)).data;
        if (fingerprint(fresh) !== request.fingerprint) {
          data = fresh;
          return { error: 'The journal changed since this window was drawn, so it has been read again. Check the ticks and try again.', data, fingerprint: fingerprint(data) };
        }
        const result = work(request);
        if (result.missing.length) return { error: `Not written: ${result.missing.map((entry) => entry.why).join('; ')}.` };
        const locked = result.files.filter((file) => !writableFiles(host, data).some((entry) => entry.path === file.path && entry.writable));
        if (locked.length) return { error: `${locked.map((file) => file.path).join(', ')} cannot be written: it did not come from an opened folder. Run open in the terminal, then reconcile again.` };
        // hledger must be happy before, so that a failure after is this write's and nothing else's.
        try {
          await host.hledger(check);
        } catch (error) {
          return { error: `hledger already reports a problem, so nothing was written: ${error && error.message ? error.message : error}` };
        }
        const written = [];
        for (const file of result.files) {
          const answer = await host.save(file.path, file.after);
          if (answer && answer.error) {
            for (const done of written) await host.save(done.path, done.before);
            return { error: `${file.path} could not be saved: ${answer.error}` };
          }
          written.push(file);
        }
        try {
          await host.hledger(check);
        } catch (error) {
          // The assertion did not hold, or the marks broke something: put every file back.
          for (const done of written) await host.save(done.path, done.before);
          return { error: `hledger refused the result, so the files were put back as they were: ${error && error.message ? error.message : error}` };
        }
        data = (await readAccount(host, account, data.commodity)).data || data;
        const changes = result.files.reduce((sum, file) => sum + file.changes.length, 0);
        const what = request.finish
          ? `${account} reconciled to ${request.finish.date}: ${changes} postings marked and the balance asserted`
          : `${account}: progress saved, ${changes} postings marked`;
        host.say(`${host.name}: ${what}.`);
        return { ok: true, message: what, data, fingerprint: fingerprint(data) };
      },
    });

    view.write(page({
      data,
      colors,
      token,
      files: writableFiles(host, data),
      statementDate: line.statement || today(),
      statementBalance: line.balance,
      fingerprint: fingerprint(data),
      module: beside('reconcile-window.js'),
    }));
    const from = data.start ? `since the balance asserted on ${data.start.date}` : 'with no balance asserted yet';
    host.say(`${host.name}: ${data.rows.length} postings of ${account} in ${data.commodity || 'its commodity'} ${from}, in a new window.`);
  },
};
