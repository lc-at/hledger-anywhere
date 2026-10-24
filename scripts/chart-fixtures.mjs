// The fixtures both chart checks read: CSV copied from the shipped engine, not invented, and a
// theme. Shared so the node check and the browser check cannot drift apart on what hledger says.

export const MONTHLY_CSV = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses:food:coffee","0","$12.50","$0"',
  '"expenses:housing:rent","$1200.00","$1237.50","$1286.40"',
  '"expenses:reading:books","0","$0","$0"',
  '"Total:","$1200.00","$1250.00","$1286.40"',
  '',
].join('\n');

export const RANKING_CSV = [
  '"account","balance"',
  '"expenses:housing:rent","$1,200.00"',
  '"expenses:food:groceries","$86.40"',
  '"expenses:reading:books","$34.99"',
  '"Total:","$1,321.39"',
  '',
].join('\n');

/** A statement: a title above the header, and section rows with no amounts. */
export const STATEMENT_CSV = [
  '"Balance Sheet 2024-02-03",""',
  '"Account","2024-02-03"',
  '"Assets",""',
  '"assets:bank:checking","$4,278.61"',
  '"assets:cash","$107.50"',
  '"Liabilities",""',
  '"Total:","$4,386.11"',
  '',
].join('\n');

/** gruvbox light: the theme the node check measures against. */
export const COLORS = {
  background: '#fbf1c7',
  foreground: '#3c3836',
  cursor: '#af3a03',
  accent: '#b57614',
  dim: '#7c6f64',
};

/** register -O csv: one row per posting, so a transaction appears once per account. */
export const REGISTER_CSV = [
  '"txnidx","date","code","description","account","amount","total"',
  '"1","2024-01-05","","Landlord","expenses:housing:rent","$600.00","$600.00"',
  '"1","2024-01-05","","Landlord","assets:bank:checking","$-600.00","0"',
  '"2","2024-01-09","","Grocery Store","expenses:food:groceries","$86.40","$86.40"',
  '"2","2024-01-09","","Grocery Store","assets:bank:checking","$-86.40","0"',
  '"3","2024-01-14","salary:january","Employer","income:salary","$-2200.00","$-2200.00"',
  '"3","2024-01-14","salary:january","Employer","assets:bank:checking","$2200.00","0"',
  '"4","2024-02-02","","Coffee","expenses:food:coffee","$12.50","$12.50"',
  '"4","2024-02-02","","Coffee","assets:bank:checking","$-12.50","0"',
].join('\n');

// The indentation is two no-break spaces a level, U+00A0, exactly as the engine writes it.
// A terminal shows them as spaces, which is how an earlier fixture came to use spaces and pass
// against a shape hledger never produces, while the real tree drew its parent beside its own
// children. The amounts are smaller than the demo's, so the totals here are this fixture's own.
export const NBSP = '\u00a0';

export const TREE_CSV = [
  '"account","balance"',
  '"expenses","$698.90"',
  `"${NBSP.repeat(2)}food","$98.90"`,
  `"${NBSP.repeat(4)}coffee","$12.50"`,
  `"${NBSP.repeat(4)}groceries","$86.40"`,
  `"${NBSP.repeat(2)}housing:rent","$600.00"`,
  '"Total:","$698.90"',
].join('\n');

// hledger balance income expenses --depth 2 -O csv, on the demo journal.
export const FLOWS_CSV = [
  '"account","balance"',
  '"expenses:food","$98.90"',
  '"expenses:housing","$1200.00"',
  '"expenses:reading","$34.99"',
  '"income:salary","$-3200.00"',
  '"Total:","$-1866.11"',
].join('\n');

// hledger balance --tree -M expenses -O csv: the tree with a column per month.
export const TREE_MONTHS_CSV = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses","$1286.40","$47.49","$600.00"',
  `"${NBSP.repeat(2)}food","$86.40","$12.50","$100.00"`,
  `"${NBSP.repeat(4)}coffee","0","$12.50","$20.00"`,
  `"${NBSP.repeat(4)}groceries","$86.40","0","$80.00"`,
  `"${NBSP.repeat(2)}housing:rent","$1200.00","0","$500.00"`,
  `"${NBSP.repeat(2)}reading:books","0","$34.99","0"`,
  '"Total:","$1286.40","$47.49","$600.00"',
].join('\n');

// hledger balance -M --depth 2 -O csv: flows month by month.
export const FLOWS_MONTHS_CSV = [
  '"account","2024-01","2024-02","2024-03"',
  '"expenses:food","$86.40","$12.50","$100.00"',
  '"expenses:housing","$1200.00","0","$500.00"',
  '"expenses:reading","0","$34.99","$40.00"',
  '"income:salary","$-3200.00","0","$-3200.00"',
  '"Total:","$-1913.60","$47.49","$-2560.00"',
].join('\n');

/** The dark theme the app starts in, for the browser check's second pass. */
export const DARK = {
  background: '#000000',
  foreground: '#d8d8d8',
  cursor: '#ff9f1c',
  accent: '#ff9f1c',
  dim: '#8a8a8a',
};

/**
 * A balance report with many periods, in the engine's shape, for what only a long report
 * exercises: zoom, pan, and period labels that have to be thinned to fit.
 */
export function dailyCsv(days = 40) {
  const dates = Array.from({ length: days }, (_, index) => {
    const day = new Date(Date.UTC(2024, 0, 1 + index));
    return day.toISOString().slice(0, 10);
  });
  const row = (account, base) => `"${account}",${dates.map((_, index) => `"$${(base + ((index * 7) % 13)).toFixed(2)}"`).join(',')}`;
  return [
    `"account",${dates.map((date) => `"${date}"`).join(',')}`,
    row('expenses:food', 20),
    row('expenses:transport', 8),
    '',
  ].join('\n');
}
