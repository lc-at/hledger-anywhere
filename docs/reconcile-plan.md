# Plan: `reconcile <account>`

**Status: phases 1 and 2 built** (`assets/plugins/reconcile.js`, `reconcile-data.js`,
`reconcile-window.js`). Phase 3, statement import, waits for sample bank exports.

Two things changed while building it, both for correctness:

- **Finish needs every posting up to the statement date ticked.** A balance assertion counts
  every posting up to its date, cleared or not, so asserting a statement balance with a
  posting left out (a transfer the bank has not shown yet) would fail. The window says which,
  and that the fix is to tick it, move the statement date, or give it the bank's date.
- **Source paths are matched to loaded files.** The app mounts journals under `/data/`, a
  plain hledger run at `/`, and a journal may itself live in a `data/` folder, so hledger's
  `sourceName` is resolved against `host.files()` by its end, not by stripping a prefix.
- **Added after:** a running balance on every posting, a statement balance typed beside any of
  them with the difference there (the first mismatch marked and explained, a matching one
  written as an assertion on its posting), editing a posting in place, and adding a missing
  one. Editing an amount writes an inferred amount out explicitly and moves the other side of
  a two-posting transaction with it; anything more complex keeps its amount read-only.
- **Not built:** Enter opening a transaction in `edit` at its line, which `edit` cannot do yet.

A plugin that opens a window for checking one account against a bank or e-wallet statement:
tick off what the statement shows, watch the difference fall to zero, and write the result
into the journal so hledger checks it from then on.

## How reconciliation works in this journal today

Read from `personal-hledger`, because the plugin has to fit how it is already done rather
than a textbook:

- **The cleared mark means nothing here.** 10,484 of 10,503 transactions are `*` as they are
  entered, so hledger's `-C`/`-U` cannot tell checked from unchecked. A plugin built on
  "toggle `!` to `*`" would mark nothing new.
- **Balance assertions are the real record.** 41 of them, e.g.
  `Assets:BNI:Taplus8650  =251216.00 IDR` and `Assets:Jago:Pocket4641 =0 IDR`. Once
  written, hledger re-checks them on every run, which is the strongest reconciliation there
  is.
- **Progress is noted by hand,** in the journal owner's own format: `termux/add_note` appends
  `; partially-reconciled: <account>` and `; invalid-balance: <account>`. It is a personal
  reminder, not an hledger convention, so the plugin neither reads nor writes it, and should
  not invent a format of its own in its place either.
- Many postings have **no explicit amount**: the account's side is inferred
  (`Assets:Mandiri:Now5782` alone on its line). An assertion written onto such a posting
  would turn it into a balance *assignment* and change what it means. The plan never does
  that.

## What the user does

```
reconcile Assets:Mandiri:Now5782
reconcile mandiri -e 2026-10-01          statement up to 30 September
reconcile Assets:BCADigital --statement 2026-09-30 --balance 2530801.73
```

1. The window opens with the account's postings since its **last balance assertion** (the
   last point already proven), up to the statement date. The asserted balance is the
   starting balance; anything before it is settled and not shown.
2. The user types the **statement's closing balance** and date (or passes them as flags).
3. They tick each posting the statement shows. The header always says: opening balance,
   ticked total, expected closing balance, statement balance, and the **difference**, large,
   which turns the accent colour at zero.
4. Postings the statement does not show yet (a transfer still pending) stay unticked and
   carry over to the next reconciliation.
5. **Finish** is enabled at a difference of zero. It writes the result (below), runs hledger
   to confirm the new assertion passes, and says so in the terminal.
6. **Save progress** keeps the ticks without finishing.

### Help with the difference

The part of reconciling that takes time is finding why it does not balance. The window helps:

- **Candidates:** postings whose amount equals the difference, or half of it (a sign entered
  the wrong way round), are highlighted with a one-line reason.
- **Transposed digits:** a difference divisible by 9 is flagged as a likely swap
  (`18,000` entered as `81,000`), with the postings it could be.
- **Search and keys:** type an amount or a word to filter; `j`/`k` move, Space ticks, `a`
  ticks all shown, Enter opens the transaction in the `edit` plugin at its line.
- **Missing transactions:** "add a posting" opens `edit` at the end of the file with a
  transaction stub for the account, for the fee or interest the statement has and the
  journal does not.

## What it writes

Only standard hledger, nothing of the plugin's own invention, shown as a diff before
anything is saved:

1. **A balance assertion at the statement date**, as its own transaction so it never
   touches an existing posting's meaning:

   ```
   2026-09-30 * Reconciled with statement
       Assets:Mandiri:Now5782       0 IDR = 664092.01 IDR
   ```

   Appended to the end of the file the account's transactions live in. hledger checks
   assertions in date order, and for one date in file order, so a transaction appended on
   the statement date is checked after every posting of that day. The amount is written
   **without digit grouping**, with the commodity's decimal mark and precision from hledger's
   JSON `astyle`, the way the other 41 assertions are (`=251216.00 IDR`). Grouping is not
   safe: in a journal without a `commodity` directive hledger reads `970,000 IDR` as 970.000
   (a comma decimal mark) and the assertion fails, which a test against the engine showed.

2. **A cleared mark on each ticked posting**, the posting's own status, not the
   transaction's:

   ```
   2026-09-05 * Dkriuk Mayestik
       Expenses:Food:EatingOut                                    21000 IDR
     * Assets:Mandiri:Now5782
   ```

   Only the reconciled account's posting is marked, so reconciling Mandiri says nothing about
   the BCA side of a transfer between them. Unticking a posting saved earlier removes its mark.
   A posting already marked `!` (pending) is shown as pending and becomes `*` when ticked.

   hledger's JSON reports a posting's own status (`pstatus`) apart from its transaction's
   (`tstatus`), so the plugin reads its ticks from the posting marks even in this journal,
   where every transaction is already `*`. hledger's own reports (`-U`, `-C`) combine the two
   (an unmarked posting takes its transaction's status, a marked one keeps its own, checked
   against the engine), so they only show what is left to reconcile once new transactions are
   entered without `*`. The plugin does not need that habit, but it is what makes
   `bs -U`, the `unreconciled_bs` snippet, mean "not yet checked against a statement".

Nothing else in the file is touched. The edits are computed as line changes against the text
`host.read` returned, applied in one `host.save`, which refuses if the file changed on disk
since it was opened. After saving, `host.hledger('balance <account> -e <date+1>')` must
succeed (an assertion that fails is an error); if it does not, the original text is saved
back and the window says why.

## How it is built

The plugin API already has everything needed: `host.hledger`, `host.files`, `host.read`,
`host.save`, `host.window`, and the bridge pattern `edit` uses for a window to call back.

```
reconcile.js          run(): parse the line, read the data, open the window, own the bridge
reconcile-data.js     pure: postings from `print -O json`, the arithmetic, the hints,
                      and the edits as text changes (tested in node)
reconcile-window.js   the page: header of balances, the list, keys, the diff, save
```

**Reading:** `print <account> -e <statement+1> -O json` gives every transaction with
`tsourcepos` (file and first and last line), each posting's account, amount, status, comment
and balance assertion. The last posting of the account with a `pbalanceassertion` is the
starting point. Within a transaction's line range, the posting line is found by account name
and amount; a transaction with the account twice is matched in order.

**Writable or not:** `host.files()` says whether the file is writable (an `open`ed folder).
If not, the window still works for checking, and Finish becomes "copy the assertion" for
pasting by hand, saying why.

**Resuming:** saved progress is the posting marks themselves, written by "save progress", so it
lives in the journal and survives any other tool. Only in a read-only file are ticks kept with
`host.remember`, keyed by date, description and amount.

## Phases

1. **Read-only reconciler.** The window, ticking, the balances and the difference, the
   hints. Nothing written. Useful on its own, and proves the reading on the real journal.
2. **Writing.** The assertion and tags, the diff preview, the post-save check and rollback,
   save progress.
3. **Statement import.** Paste or drop the bank's CSV export: lines are matched to postings
   by amount and date within a few days and ticked; statement lines with no match are listed
   with "add a posting". Bank formats differ, so this phase needs real exports to design
   against.

Each phase keeps the existing gates green and adds node checks for `reconcile-data.js` and
browser checks for the window, and is verified on the personal journal before it ships.

## Verified against the engine

Checked on a small journal with the pinned hledger before writing this plan:

- An assertion-only transaction, `Assets:Bank  0 IDR = 970000 IDR`, appended at the end of the
  file and dated the statement day, passes when the balance is right and fails with
  "Balance assertion failed in Assets:Bank ... calculated balance is 970000 IDR" when not.
- It is checked after every earlier posting of that date, including ones dated the same day
  but written above it, out of date order, as this journal often has.
- A same-day posting appended *after* it in the file is not covered by it, so the assertion is
  always the last thing written.
- A posting's own mark overrides its transaction's, and an unmarked posting takes the
  transaction's: in a `*` transaction, `  ! Assets:Bank` is pending for `-P`; in an unmarked
  one, `  * Assets:Bank` is cleared for `-C`. JSON keeps the two apart as `pstatus` and
  `tstatus`.
- `print -O json` gives each transaction's `tsourcepos` (file and line range) and each
  posting's `pbalanceassertion`, so the starting point and the lines to edit are hledger's
  own, not guessed by parsing the journal text.

## Decided

- **Only standard hledger is written:** the balance assertion, and a posting-level `*` on each
  ticked posting. No tags or comment formats of the plugin's own. The marks are also the saved
  progress.
- **Entry habit (optional):** entering new transactions without `*` makes hledger's `-U` and
  `-C` reports reflect what has been reconciled. The plugin works either way.
- **Where:** the assertion transaction is appended to the end of the file the account's
  transactions are in, never inserted mid-file.
- **First build:** phases 1 and 2 (the window, and writing with a diff preview, a post-save
  check and rollback). Statement import waits for sample exports from the banks.
- **The Termux notes** (`; partially-reconciled:`, `; invalid-balance:`) are the owner's own
  format: the plugin ignores them and leaves them in the file as they are.
