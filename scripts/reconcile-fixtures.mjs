// A journal for the reconcile checks, and what hledger prints for it. The print is generated
// when this module is loaded: the shipped engine runs the journal and the JSON is cut from its
// answer, so editing the journal cannot leave the print's line numbers behind.
//
// GENERIC_JOURNAL is separate and deliberately unlike a real person's book: it exists to carry
// every kind of posting the window has to handle, so nothing about it is specific to one journal.
//
// Its transactions are UNMARKED on purpose. A reconcile window is opened on postings that
// have not been reconciled yet, so that is the state these checks start from; a window that
// opened with everything already ticked could not exercise ticking, editing or the
// difference. The rule that a marked transaction clears its postings is checked separately,
// against its own small pieces of JSON, in check-example-plugin.mjs.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), 'hledger-wasm.mjs');

/** An amount as the plugin reads it: the commodity, the quantity and hledger's style for it. */
const AMOUNT = {
  acommodity: true,
  aquantity: { decimalMantissa: true, decimalPlaces: true },
  astyle: { ascommodityside: true, ascommodityspaced: true, asdecimalmark: true, asprecision: true },
};

/** A field kept only when hledger printed a value for it: a posting with no cost prints `"acost":null`. */
const whenPresent = (shape) => ({ kept: shape });

/**
 * hledger's print cut to `shape` and nothing else: the shape's keys are the fields kept, in the
 * order they are kept in; `true` keeps a value exactly as printed; an object or a one-entry
 * array cuts inside it; `{ kept: shape }` drops a field hledger printed as null.
 */
const cut = (value, shape) => {
  if (shape && typeof shape === 'object' && !Array.isArray(shape) && 'kept' in shape) {
    if (value == null) return undefined;
    shape = shape.kept;
  }
  if (value == null || shape === true) return value;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((entry) => cut(entry, shape[0])) : value;
  if (typeof shape !== 'object' || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const key of Object.keys(shape)) {
    if (!(key in value)) continue;
    const piece = cut(value[key], shape[key]);
    if (piece !== undefined) out[key] = piece;
  }
  return out;
};

// The one shape both prints are cut with: the fields the window reads, a posting's `ptype`,
// its cost where hledger printed one, and the whole balance assertion among them.
const CUT = {
  tindex: true, tdate: true, tdescription: true, tstatus: true,
  tsourcepos: [{ sourceName: true, sourceLine: true }],
  tpostings: [{
    paccount: true, ptype: true, pstatus: true, pdate: true, ptags: true,
    pamount: [{ ...AMOUNT, acost: whenPresent({ contents: { acommodity: true, aquantity: { decimalMantissa: true, decimalPlaces: true } } }) }],
    pbalanceassertion: true,
  }],
};

/**
 * What hledger prints for `journal`, cut to `shape`, run through the shipped engine: the journal
 * is written to a file of `name` (which is the name its `tsourcepos` then carries) with the
 * newline a file ends with, printed with `query`, and cut. If the engine is not there, the
 * failure says how to get it.
 */
const printed = async (journal, name, query, shape) => {
  const dir = mkdtempSync(join(tmpdir(), 'hla-fixture-'));
  try {
    writeFileSync(join(dir, name), journal.endsWith('\n') ? journal : `${journal}\n`);
    const { stdout } = await run(process.execPath, [ENGINE, join(dir, name), 'print', query, '-O', 'json'], { maxBuffer: 64 * 1024 * 1024 });
    return cut(JSON.parse(stdout), [shape]);
  } catch (error) {
    const said = String((error && error.stderr) || (error && error.message) || error);
    const missing = said.split('\n').find((line) => /cannot read the engine/.test(line));
    if (missing) throw new Error(`the reconcile fixtures cannot be printed: ${missing.trim()}. Fetch it with scripts/fetch-hledger-wasm.sh`);
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const RECONCILE_JOURNAL = "commodity 1,000.00 IDR\n\n2026-08-31 Opening balance\n    Assets:Bank:Checking    1000000.00 IDR = 1000000.00 IDR\n    Equity:Opening\n\n2026-09-01 Coffee\n    Expenses:Food    21000 IDR\n    Assets:Bank:Checking\n\n2026-09-02 Salary\n    Assets:Bank:Checking    5000000.00 IDR\n    Income:Salary\n\n2026-09-03 Pending transfer\n    Assets:Savings    300000 IDR\n  ! Assets:Bank:Checking\n\n2026-09-05 Split\n    Expenses:Food    9000 IDR  ; lunch\n    ; a comment line\n    Assets:Bank:Checking    -4000 IDR\n    Assets:Bank:Checking\n\n2026-10-02 After the statement\n    Expenses:Fees    2500 IDR\n    Assets:Bank:Checking\n";

export const RECONCILE_PRINT = await printed(RECONCILE_JOURNAL, 'fixture.journal', 'acct:^Assets:Bank:Checking$', CUT);

export const GENERIC_JOURNAL = `; A journal built to exercise everything the reconcile window has to handle.
; Invented data: accounts, payees and amounts are all made up.

commodity 1,000.00 IDR
commodity 1,000.00 USD

2026-01-01 * Opening balance  ; note: where this account starts
    assets:bank                                5,000.00 IDR = 5,000.00 IDR
    equity:opening

2026-01-05 Northwind Studio payroll
    income:salary                           -12,000.00 IDR
    expenses:fees                              200.00 IDR
    assets:bank                              11,700.00 IDR
    assets:bank                                100.00 IDR

2026-01-07 * Cash set aside in the pocket  ;tag:internal
    expenses:pocket                          2,000.00 IDR
    assets:cash                             -2,000.00 IDR
    (assets:bank)                             500.00 IDR

2026-01-09 Money set aside for the holiday
    [budget:holiday]                         3,000.00 IDR
    [assets:bank]                           -3,000.00 IDR

2026-01-11 * Acme Studio invoice, a description long enough to wrap in a narrow window and still read as one transaction
    assets:bank                               1,500.00 IDR
    income:consulting
    ; the account is credited, not debited

2026-01-13 Buying dollars for a trip  ;tag:travel
    assets:bank                              100 USD @ 1,100.00 IDR
    expenses:travel

2026-01-15 ! Selling dollars back, as a total
    assets:bank                               50.00 USD @@ 55,000.00 IDR
    income:refunds

2026-01-17 A cheque that has not cleared yet
    expenses:fees                                10.00 IDR
  * assets:bank

2026-01-19 Groceries, the amount left out for hledger to work out  ;tag:food
    expenses:groceries                         150.00 IDR
  ! assets:bank

2026-01-21 Paid in dollars
    expenses:software                           25.00 USD
    assets:bank`;

export const GENERIC_PRINT = await printed(GENERIC_JOURNAL, 'generic.journal', 'acct:^assets:bank$', CUT);
