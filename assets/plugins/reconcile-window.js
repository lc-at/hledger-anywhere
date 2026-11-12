/**
 * The reconcile window: the statement, the account's postings, and the difference.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window; the window
 * imports `mount` to draw it. It reads and writes nothing itself: every change goes back through
 * the bridge to the plugin, which is the side that can reach the files.
 *
 * Each posting shows the account's balance after it, the way a statement prints one beside each
 * line, and takes the statement's figure for it: the difference shows there, and the first line
 * where it is not zero is where the statement and the journal part. A transaction is edited as
 * its journal text, anything in it, beside a view of the whole file, and a missing one is added
 * the same way, or found under another account and moved to this one.
 *
 * On a journal from an opened folder every change is written to the file as it is made, checked
 * by hledger and put back if hledger refuses it, and the window then shows the file as hledger
 * reads it. The window also reads the file again when another program changes it. Finish
 * previews the assertion before writing it. A journal that cannot be written keeps its changes
 * in the window.
 *
 * Keys: ↑ ↓ or j k move, Space ticks, e edits, n adds, i inserts after the line, d changes the
 * date, Shift+↑ ↓ moves a line within its day, Alt+↑ ↓ moves it to the next day, f finds a
 * transaction under another account, u undoes, a ticks every posting shown, / searches,
 * Ctrl+Enter keeps an edit, Escape clears the search or closes an editor.
 */

import { carry, checkpoints, hints, markConflicts, moveRefusal, neighbour, ordered, parseInput, placement, readTransaction, readable, snapshot, summarize, template, visibleRows } from './reconcile-data.js';
import { escape, isLight, mix } from './window-kit.js';


/** The whole document, with the data in a JSON block and the page to be mounted. */
export function page({ data, colors, token, files, accounts = [], statementDate, statementBalance, fingerprint, module, style = 'posting', lines = false }) {
  const payload = JSON.stringify({ data, colors, token, files, accounts, statementDate, statementBalance, fingerprint, style, lines }).replace(/</g, '\\u003c');
  const writable = files.some((file) => file.writable);
  const locked = files.filter((file) => !file.writable).map((file) => file.path).join(', ');
  const soft = mix(colors.background, colors.dim, 14);
  const softer = mix(colors.background, colors.dim, 7);
  // What a cleared line is tinted with. At the same strength as the other tints it measured
  // 1.13 against the page in dark and 1.18 in light, which is a difference you have to look
  // for: two hundred cleared rows read as an unmarked list. At this strength it is 1.50 and
  // 1.48, clearly a different row, while text on it still measures 12 to 1.
  const cleared = mix(colors.background, colors.dim, 32);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: reconcile ${escape(data.account)}</title>
<style>
  :root { color-scheme: ${isLight(colors.background) ? 'light' : 'dark'}; }
  body { margin:0; background:${colors.background}; color:${colors.foreground}; font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:20px 24px 40px; }
  h1 { font-size:18px; font-weight:600; margin:0; }
  .sub { color:${colors.dim}; margin:2px 0 14px; font-size:13px; }
  /* The bar stays put while the list scrolls: the next step, the difference and the actions
     are what the window is for, so they are never out of reach. Two lines, wrapping at 620px. */
  .bar { position:sticky; top:0; z-index:5; background:${colors.background}; border-bottom:1px solid ${colors.dim}55; padding:8px 0 10px; margin:0 0 12px; }
  /* One row of fields: the statement's date, its closing balance, and the difference they make.
     The figures take a row of their own underneath rather than competing with the inputs. */
  .fields { display:flex; flex-wrap:wrap; gap:10px 16px; align-items:end; }
  .figures { width:100%; font-size:11px; color:${colors.dim}; }
  /* On a narrow window the figures would take a row of their own and push the bar past a quarter
     of the screen, so they go to the difference's tooltip, which carries them anyway. */
  @media (max-width:760px) { .figures { display:none; } }
  .figures b { color:${colors.foreground}; font-variant-numeric:tabular-nums; font-weight:600; }
  .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; width:100%; }
  .actions input[type=search] { flex:1 1 150px; min-width:150px; }
  /* Narrow, the search takes a line to itself and the buttons share the next one, rather than
     the search shrinking until its placeholder is cut off in the middle of a word. */
  @media (max-width:760px) { .actions input[type=search] { flex:1 1 100%; } }
  label { display:flex; flex-direction:column; gap:3px; font-size:12px; color:${colors.dim}; }
  select { font:inherit; font-size:12px; color:${colors.foreground}; background:${softer}; border:1px solid ${colors.dim}66; border-radius:4px; padding:4px 6px; }
  input { font:inherit; color:${colors.foreground}; background:${softer}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 8px; }
  input:disabled { opacity:.5; }
  input:focus-visible, button:focus-visible, tr:focus-visible { outline:2px solid ${colors.accent}; outline-offset:1px; }
  /* The difference is the number the whole window is for, so it is the loud one. */
  .difference { text-align:right; }
  .difference b { font-size:20px; font-variant-numeric:tabular-nums; font-weight:600; }
  .difference .word { font-size:11px; color:${colors.dim}; text-transform:uppercase; letter-spacing:.04em; }
  .difference.zero b { color:${colors.accent}; }
  .difference.zero .word { font-size:13px; text-transform:none; letter-spacing:0; }
  /* Everything worth knowing that is not the next step, one line each, in one place. */
  .issues { margin:0 0 10px; }
  .issues:not(:has(p)) { display:none; }
  .note, .hints p { font-size:13px; margin:2px 0; padding-left:8px; border-left:2px solid ${colors.dim}66; }
  .hints p { border-left-color:${colors.accent}; cursor:default; }
  .hints button { margin-left:8px; padding:1px 8px; font-size:12px; }
  /* Said once, where it cannot be missed, with the one thing that fixes it. */
  .banner { font-size:13px; margin:0 0 12px; padding:6px 10px; border:1px solid ${colors.dim}66; border-radius:4px; }
  .options { display:flex; flex-wrap:wrap; gap:18px; align-items:center; margin:-4px 0 12px; font-size:12px; color:${colors.dim}; }
  .options label { flex-direction:row; align-items:center; gap:6px; }
  /* Off, the columns for checking line by line are not drawn at all; their cells stay, so a
     column is the same column either way. */
  table:not(.lines) .line { display:none; }
  .tools { display:flex; gap:10px; align-items:center; margin:12px 0 6px; flex-wrap:wrap; }
  .tools input[type=search] { flex:1; min-width:180px; }
  .count { font-weight:400; opacity:.75; }
  button { font:inherit; color:${colors.foreground}; background:${soft}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 12px; cursor:pointer; }
  button.primary { background:${colors.accent}; color:${colors.background}; border-color:${colors.accent}; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  /* The edit control sits beside the description rather than in a column of its own. A whole
     column for one small control cost width on every row, and on a narrow window that width is
     what pushed the difference off the screen. It is a word, quiet until it is wanted. */
  button.edit { background:none; border:none; padding:0; margin-left:4px; color:${colors.dim};
    cursor:pointer; font-size:11px; vertical-align:1px; }
  button.edit:hover, button.edit:focus-visible { color:${colors.foreground}; text-decoration:underline; }
  /* The restore link beside a deleted posting keeps the word, since it is not an icon. */
  button.icon { background:none; border:none; padding:0 2px; color:${colors.dim}; font-size:11px; white-space:nowrap; }
  button.icon:hover { color:${colors.foreground}; text-decoration:underline; }
  /* Narrow, the table is wider than the window: let it scroll rather than cutting the
     last columns off, which is where the edit button and the difference live. */
  .table { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:${colors.dim}; font-weight:400; border-bottom:1px solid ${colors.dim}55; padding:4px 6px; position:sticky; top:0; background:${colors.background}; z-index:1; }
  td { padding:4px 6px; border-bottom:1px solid ${colors.dim}22; vertical-align:top; }
  /* Where the day changes, a heavier rule than the hairline between postings. Drawn on the cells
     rather than the row, since a table row's own border does not paint in border-collapse mode. */
  tr.day td { border-top:2px solid ${colors.dim}88; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  /* Values stay on one line whatever happens. A header wraps only where there is no room for
     it on one, because there naming the commodity in it costs a line rather than a column and
     a wrapped header over a wide window just reads worse. */
  td.n { white-space:nowrap; }
  th.n { white-space:nowrap; }
  @media (max-width:760px) { th.n { white-space:normal; } }
  td.tick { width:24px; text-align:center; }
  /* A date on two lines costs a row twice the height and reads worse. */
  td.date, th.date { white-space:nowrap; width:1%; }
  /* An optional column of boxes should not outshine the postings themselves, but an empty
     box with no background and no border leaves a column of nothing, which reads as broken
     rather than as quiet. It is a visible field that stays out of the way, and the row under
     the pointer or the cursor sharpens it. */
  td.expect input { width:110px; text-align:right; padding:2px 6px; font-variant-numeric:tabular-nums;
    background:${softer}; border-color:${colors.dim}55; }
  tr:hover td.expect input, td.expect input:hover, td.expect input:focus { background:${softer}; border-color:${colors.dim}aa; }
  td.delta.off { color:${colors.accent}; font-weight:600; }
  td.delta.ok { color:${colors.dim}; }
  tr { cursor:pointer; }
  /* Cleared is the tint rather than a word: with two hundred and eighty-nine of them in view,
     a word on every row is the noisy half, and the tint plus the lines being hidden until asked
     for already say which are done. The state is still on the row for a screen reader. */
  tr.on td { background:${cleared}; }
  /* The state of the line, in a word. Small and dim so a long list of cleared lines stays
     calm; the word itself, not the colour, is what says which is which. */
  .state { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:${colors.dim}; margin-right:6px; }
  .state.pending { color:${colors.accent}; }
  .state.foreign { border-bottom:1px dotted ${colors.dim}; }
  td.foreign { color:${colors.dim}; }
  /* Named for what it is rather than for the cell it sits in: the cell has the date name too,
     and a rule for the button was taking the cell's own borders with it. */
  .date-btn, .insert { background:none; border:none; padding:0; color:inherit; font:inherit; cursor:pointer; }
  .date-btn { text-decoration:underline dotted ${colors.dim}; text-underline-offset:3px; }
  .date-btn:hover, .insert:hover { color:${colors.accent}; }
  .insert { color:${colors.dim}; margin-left:6px; font-weight:600; opacity:0; }
  tr:hover .insert, tr:focus-within .insert, .insert:focus-visible { opacity:1; }
  /* Nothing hovers on a touch screen, so a control that only appears on hover is a control
     that does not exist there. */
  @media (hover: none) { .insert { opacity:1; } }
  /* An explicit width and colour: a date input sized by the browser can collapse to nothing
     in some engines, and a date field you cannot see is worse than no editor at all. */
  .date-input { font:inherit; padding:1px 4px; width:10em; box-sizing:border-box; color:${colors.foreground}; }
  tr.hinted td { box-shadow:inset 0 0 0 9999px ${mix(colors.background, colors.accent, 14)}; }
  /* Where the statement and the journal part: one bar at the start of the row, not one per cell. */
  tr.first td:first-child { box-shadow:inset 3px 0 0 ${colors.accent}; }
  tr.later td { opacity:.45; }
  tr.editor td { background:${softer}; cursor:default; }
  .editing textarea { display:block; width:100%; box-sizing:border-box; font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;
    color:${colors.foreground}; background:${colors.background}; border:1px solid ${colors.dim}66; border-radius:4px; padding:6px 8px; resize:vertical; tab-size:4; }
  .editing .buttons { display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap; }
  .editing .reading { color:${colors.foreground}; font-size:12px; margin:6px 0 0; }
  .against { color:${colors.dim}; }
  /* That the row is new or has been edited, set apart from the edit control. */
  .badge { color:${colors.accent}; font-size:10px; margin-left:6px; text-transform:uppercase; letter-spacing:.04em; }
  .muted { color:${colors.dim}; font-size:11px; }
  .preview { margin:14px 0; padding:10px 12px; border:1px solid ${colors.dim}66; border-radius:6px; }
  .preview pre { margin:6px 0; font:12px/1.5 ui-monospace,Menlo,Consolas,monospace; white-space:pre-wrap; }
  .preview .del { color:${colors.dim}; text-decoration:line-through; }
  .preview .add { color:${colors.accent}; }
  #status { font-size:13px; margin:8px 0; min-height:1.5em; }
  #status.error { color:${colors.accent}; }
  .keys { color:${colors.dim}; font-size:12px; margin-top:16px; }
  /* The one line that says what to do next. It changes as the work moves on. */
  #next { font-size:13px; margin:0 0 12px; padding:8px 10px; border-left:2px solid ${colors.accent}; background:${softer}; }
  #next b { font-weight:600; }
  /* What is hidden, and the way to see it. Quiet, but always there when something is hidden. */
  .hidden-note { color:${colors.dim}; font-size:12px; margin:0 0 6px; min-height:0; }
  .hidden-note:empty { display:none; }
  .hidden-note button { background:none; border:none; padding:0; margin-left:6px; color:${colors.foreground};
    font:inherit; text-decoration:underline; cursor:pointer; }
  /* While a change is being written, its row says so, quietly. */
  tr.writing td { opacity:.6; }
  tr.writing td.date::after { content:' writing'; font-size:10px; color:${colors.accent}; }
  #status button { margin-left:8px; padding:1px 8px; font-size:12px; }
  #status.busy::before { content:''; display:inline-block; width:8px; height:8px; margin-right:6px; border-radius:50%;
    background:${colors.accent}; animation:pulse 1s ease-in-out infinite; vertical-align:1px; }
  @keyframes pulse { 50% { opacity:.25; } }
  /* Up and down within a day: two small arrows beside the date, there when the row is. */
  .order { background:none; border:none; padding:0 1px; color:${colors.dim}; font:inherit; font-size:11px; cursor:pointer; opacity:0; }
  tr:hover .order, tr:focus-within .order, .order:focus-visible { opacity:1; }
  .order:hover { color:${colors.accent}; }
  @media (hover: none) { .order { opacity:1; } }
  /* The editor beside the whole file it is in, so the lines around it are in view. */
  .split { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1.2fr); gap:12px; align-items:start; }
  @media (max-width:760px) { .split { grid-template-columns:minmax(0, 1fr); } }
  .file-view { border:1px solid ${colors.dim}55; border-radius:4px; background:${colors.background}; }
  .file-view .where { font-size:11px; color:${colors.dim}; padding:3px 8px; border-bottom:1px solid ${colors.dim}33; }
  .file-view .scroll { height:300px; overflow:auto; position:relative; font:12px/18px ui-monospace,Menlo,Consolas,monospace; }
  .file-view .lines { position:absolute; left:0; right:0; white-space:pre; }
  .file-view .ln { display:inline-block; min-width:5ch; padding-right:10px; text-align:right; color:${colors.dim}; user-select:none; }
  .file-view .hl { background:${mix(colors.background, colors.accent, 22)}; }
  .file-view .here { box-shadow:inset 0 2px 0 ${colors.accent}; }
  /* Finding a transaction booked to another account. */
  .find { margin:0 0 12px; padding:10px 12px; border:1px solid ${colors.dim}66; border-radius:6px; }
  .find .fields { margin-bottom:8px; }
  .find .found { list-style:none; margin:0; padding:0; max-height:420px; overflow:auto; }
  .find .found li { padding:6px 4px; border-bottom:1px solid ${colors.dim}22; cursor:pointer; }
  .find .found li.chosen { background:${softer}; }
  .find .found .why { color:${colors.dim}; font-size:11px; margin-left:6px; }
  .find .found .posting { font-size:12px; margin:2px 0 0 12px; display:flex; gap:8px; align-items:baseline; }
  .find .found .posting button { padding:1px 8px; font-size:11px; }
  .find .found .posting .amount { color:${colors.dim}; font-variant-numeric:tabular-nums; }
  .preview .conflicts p { border-left:2px solid ${colors.accent}; padding-left:8px; margin:2px 0; font-size:13px; }
</style></head>
<body><main>
  <h1>reconcile ${escape(data.account)}</h1>
  <p class="sub" id="sub"></p>
  ${writable ? '' : `<p class="banner" id="readonly">Read-only: ${escape(locked)} did not come from an opened folder, so nothing here can be saved. Run <b>open</b> in the terminal to edit it.</p>`}
  <div class="options">
    <label title="where the cleared mark is written in the journal">Mark as cleared<select id="style">
      <option value="posting"${style === 'posting' ? ' selected' : ''}>this account's line</option>
      <option value="transaction"${style === 'transaction' ? ' selected' : ''}>the whole transaction</option>
    </select></label>
    <label title="type the statement's balance after each line to find where they part; matching lines are asserted when you finish"><input type="checkbox" id="lines"${lines ? ' checked' : ''}>Check line by line</label>
  </div>
  <div class="bar" id="bar">
    <p id="next"></p>
    <div class="fields">
      <label>Statement date<input type="date" id="date" value="${escape(statementDate || '')}"></label>
      <label>Closing balance<input type="text" id="balance" inputmode="decimal" placeholder="as the statement says it" value="${escape(statementBalance || '')}" autocomplete="off"></label>
      <span class="difference" id="difference"></span>
      <span class="figures" id="figures"></span>
      <span class="actions">
        <input type="search" id="search" placeholder="search (/)" aria-label="search descriptions, accounts and amounts">
        <button id="add" title="add a transaction this account is in, placed by its date (n); i inserts after the line with the cursor">Add a transaction</button>
        <button id="all" title="tick every line shown, up to the statement date (a)">Tick all</button>
        <button id="find-open" title="look for a transaction booked to another account, by amount, date or payee (f)">Find a transaction</button>
        <button id="finish" class="primary" disabled>${writable ? 'Finish: assert balance' : 'Show the assertion'}</button>
      </span>
    </div>
  </div>
  <div class="issues"><div id="notes"></div><div class="hints" id="hints"></div></div>
  <div id="status" role="status" aria-live="polite"></div>
  <section class="find" id="find" hidden aria-label="find a transaction booked to another account">
    <div class="fields">
      <label>Amount<input type="text" id="find-amount" inputmode="decimal" autocomplete="off" placeholder="as the statement says it"></label>
      <label>Near the date<input type="date" id="find-date"></label>
      <label>Payee or description<input type="text" id="find-words" autocomplete="off" placeholder="words from it"></label>
      <span class="actions" style="width:auto"><button id="find-go" class="primary">Search</button><button id="find-close">Close</button></span>
    </div>
    <div class="split"><div><p class="muted" id="find-said">Transactions under other accounts with this amount (either sign), near this date, or with these words. Moving a posting changes its account in place: nothing is copied.</p><ul class="found" id="found"></ul></div><div class="file-view" id="find-file" hidden></div></div>
  </section>
  <div id="preview" class="preview" hidden></div>
  <datalist id="accounts">${accounts.map((name) => `<option value="${escape(name)}">`).join('')}</datalist>
  <p class="hidden-note" id="hidden"></p>
  <div class="table"><table id="table" class="${lines ? 'lines' : ''}"><thead><tr><th class="date">Date</th><th>Description</th><th class="n">Amount${data.commodity ? ` (${escape(data.commodity)})` : ''}</th><th class="n">Running balance${data.commodity ? ` (${escape(data.commodity)})` : ''}</th><th class="n line" title="the balance your statement shows after this line">Statement balance</th><th class="n line">Difference</th></tr></thead><tbody id="rows"></tbody></table></div>
  <p class="keys">Space tick · e edit · n new · i insert · d change date · Shift+↑↓ order in the day · Alt+↑↓ next day · f find · ${writable ? 'u undo · ' : ''}a tick all · / search</p>
</main>
<script type="application/json" id="reconcile-data">${payload}</script>
<script type="module">import { mount } from ${JSON.stringify(module)}; mount();</script>
</body></html>`;
}

/** The rows a search shows: by description, account, date or amount, case aside. */
export function matching(rows, search, style) {
  const words = String(search || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const text = `${row.date} ${row.description} ${row.against} ${readable(row.amount, style)} ${row.amount}`.toLowerCase();
    return words.every((word) => text.includes(word) || text.replace(/[,.]/g, '').includes(word.replace(/[,.]/g, '')));
  });
}

/**
 * What a checkpoint's difference suggests, among the rows since the last one that matched: a
 * posting in the journal the statement does not have, of exactly the difference, or an amount
 * the statement has that the journal does not, which is a posting to add.
 */
export function partHint(rows, points, style) {
  const first = points.first;
  if (!first) return null;
  const at = rows.findIndex((row) => row.id === first.id);
  const before = points.points.filter((point) => point.difference === 0 && rows.findIndex((row) => row.id === point.id) < at);
  const from = before.length ? rows.findIndex((row) => row.id === before[before.length - 1].id) + 1 : 0;
  const between = rows.slice(from, at + 1);
  const extra = between.find((row) => row.amount === -first.difference);
  const row = rows[at];
  const say = (minor) => readable(minor, style);
  if (extra) return { id: extra.id, text: `The statement and the journal part at ${row.date} ${row.description}, by ${say(first.difference)}: ${extra.date} ${extra.description} (${say(extra.amount)}) is exactly that. Is it on the statement?` };
  return { id: null, from: first.id, amount: first.difference, date: row.date, text: `The statement and the journal part at ${row.date} ${row.description}, by ${say(first.difference)}, since the last line that matched. If the statement has a line the journal does not, add it, or find it under another account.` };
}

/**
 * Which lines of a file to draw in a view `height` pixels tall scrolled to `top`, with a few
 * either side so a quick scroll does not show blank space. A journal can be forty thousand lines,
 * and a node per line of it would take seconds to draw each time the view opens.
 */
export function visibleLines(count, top, height, lineHeight = 18, spare = 20) {
  const from = Math.max(0, Math.floor(top / lineHeight) - spare);
  const to = Math.min(count, Math.ceil((top + height) / lineHeight) + spare);
  return { from, to };
}

/**
 * Ticks waiting to be written, as one change: each row once, its last state winning. Clicking
 * down a list while a write is under way sends the clicks together when it is done.
 */
export function mergeTicks(changes) {
  const last = new Map();
  for (const change of changes) for (const entry of change.changes || []) last.set(entry.id, entry.on);
  return { kind: 'tick', changes: [...last].map(([id, on]) => ({ id, on })) };
}

/** Draw the window and wire it to the plugin. */
export function mount(root = document) {
  const state = JSON.parse(root.getElementById('reconcile-data').textContent);
  const $ = (id) => root.getElementById(id);
  /** Whether the files behind this window can be written at all. */
  const readOnly = () => !state.files.some((file) => file.writable);
  const writable = !readOnly();
  // What is ticked. Writing at once, this is the file's word, as hledger read it back, plus the
  // ticks on their way to the file; read-only, it is the window's own.
  let ticked = new Set(state.data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
  // Read-only, changes stay in the window: edits, new postings and dates. Writing at once, they
  // are empty, because every change is the file's by the time it is drawn.
  let edits = {};
  let inserts = [];
  let moved = {};
  let expected = {};
  // Where the cleared marks are written. The journal's own habit, or the last choice, comes in
  // from the plugin; changing it here is remembered there so it survives the window.
  let markStyle = state.style === 'transaction' ? 'transaction' : 'posting';
  // Checking line by line is opt-in. Off, its columns are not drawn and the figures typed into
  // them are kept but never written, so turning it off and on again loses nothing and writes
  // nothing the person did not see.
  let lineByLine = Boolean(state.lines);
  let hideCleared = true;
  // Rows already cleared when the window opened are hidden by default, so the window opens on the
  // work still to do. A row the person ticks or edits from here stays in view, so nothing vanishes
  // from under the hand that just changed it.
  let clearedAtOpen = new Set(state.data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
  let touched = new Set();
  let editing = null;
  // What has been typed into an open editor, so a redraw (the file changed outside) keeps it.
  const drafts = {};
  // Whose date is being edited in place, if anyone's: the date is a button that becomes an
  // input, because changing a date is a deliberate act rather than something a click can
  // drift into.
  let dateBeingEdited = null;
  // A posting added to explain a typed balance takes that balance over: the statement's line
  // it stood for is the new posting's.
  let from = null;
  // A new posting's text before it is kept, when it was started with an amount.
  let drafting = null;
  let made = 0;
  let focus = 0;
  let shown = [];
  let pending = null;
  // Changes waiting their turn, the one being written, and ticks not yet in the file.
  const queue = [];
  let busy = false;
  let writingIds = new Set();
  let undoable = 0;
  const style = () => state.data.style;
  const money = (minor) => readable(minor, style());
  /**
   * A number in this commodity without naming it: the column header names the commodity once,
   * which keeps the rows narrow enough for a phone, where a repeated suffix is what pushes the
   * running balance off the edge of the window.
   */
  const bare = (minor) => (minor == null ? '?' : readable(minor, { ...style(), commodity: '' }));
  /**
   * What a line's amount says. A line that is not counted cannot be added to this balance, so it
   * shows what the journal wrote for it, commodity included, because the commodity is the whole
   * point of it; a line with nothing to show shows a question mark rather than a guess.
   */
  const amountOf = (row) => (row.counted
    ? (row.amount == null ? '?' : bare(row.amount))
    : (row.stated ? readable(row.stated.minor, row.stated.style) : '?'));

  const bridge = () => {
    const bridges = window.opener && window.opener.__reconcileBridges;
    return bridges && bridges[state.token];
  };
  const statement = () => ({ date: $('date').value || null, balance: parseInput($('balance').value, style()) });
  const rows = () => ordered(state.data, { edits, inserts, moved });
  const sums = () => summarize({ data: state.data, ticked, statementDate: statement().date, statementBalance: statement().balance, edits, inserts, moved });

  function say(message, error = false, { busy: working = false, undo = false } = {}) {
    $('status').textContent = message || '';
    $('status').className = `${error ? 'error' : ''}${working ? ' busy' : ''}`.trim();
    if (undo && undoable && writable) {
      const button = root.createElement('button');
      button.id = 'undo';
      button.textContent = 'Undo';
      button.title = 'take this change back out of the file (u)';
      $('status').append(button);
    }
  }

  function drawSums() {
    const now = sums();
    const { balance, date } = statement();
    // Two figures in small text, so the line stays slim: where the account started, and where
    // the ticked lines take it by the statement date. The closing balance is the input beside
    // them and the difference is the number all three are in service of.
    $('figures').innerHTML = `opening <b>${escape(money(now.opening))}</b> · cleared to ${escape(date || 'the statement date')} <b>${escape(money(now.expected))}</b>`;
    const zero = now.difference === 0;
    $('difference').className = `difference${zero ? ' zero' : ''}`;
    // Nothing typed yet says nothing here at all: a dash in the place where the number will be
    // reads as a broken field rather than as one that is waiting.
    $('difference').innerHTML = now.difference == null
      ? ''
      : zero
        ? `<b>${escape(money(now.difference))}</b> <span class="word">matches</span>`
        : `<span class="word">difference</span> <b>${escape(money(now.difference))}</b>`;
    $('difference').title = `opening ${money(now.opening)}, plus the ${now.tickedCount} ticked line${now.tickedCount === 1 ? '' : 's'} to ${date || 'the statement date'}, gives ${money(now.expected)}; the statement says ${balance == null ? 'nothing yet' : money(balance)}`;

    // One line each. The next step is not repeated here, and nothing here is said twice.
    const notes = [];
    if (now.tooEarly) notes.push(`The statement date is before ${state.data.start.date}, where this account's balance is already asserted.`);
    if (now.difference === 0 && now.outstanding.length) {
      const n = now.outstanding.length;
      notes.push(`${n} line${n === 1 ? '' : 's'} up to the statement date ${n === 1 ? 'is' : 'are'} not ticked; an assertion counts every one, so tick ${n === 1 ? 'it' : 'them'} or move ${n === 1 ? 'it' : 'them'} to the bank's date.`);
    }
    if (now.later) notes.push(`${now.later} line${now.later === 1 ? '' : 's'} after the statement date ${now.later === 1 ? 'is' : 'are'} greyed out and not counted.`);
    if (now.unknown) notes.push(`${now.unknown} transaction${now.unknown === 1 ? '' : 's'} cannot be read here, so the balances after ${now.unknown === 1 ? 'it' : 'them'} show ?.`);
    // Which commodity this window counts, and how to count another one: a statement with lines
    // in more than one currency is otherwise quietly unreadable.
    if (state.data.others.length) {
      const others = state.data.others;
      notes.push(others.length === 1
        ? `Counting ${state.data.commodity}. Lines in ${others[0]} are shown but not counted: reconcile ${state.data.account} --commodity ${others[0]} to count ${others[0]}.`
        : `Counting ${state.data.commodity}. Lines in ${others.join(', ')} are shown but not counted.`);
    }
    const restores = Object.entries(edits).filter(([, edit]) => !edit.text.trim()).map(([id]) => {
      const row = state.data.rows.find((entry) => entry.id === id);
      return `<p class="note">Deleted: ${escape(row.date)} ${escape(row.description)} ${escape(money(row.amount))} <button class="icon" data-restore="${escape(id)}">restore</button></p>`;
    });
    $('notes').innerHTML = notes.map((text) => `<p class="note">${escape(text)}</p>`).join('') + restores.join('');

    // Hints: where the difference probably comes from, and with line-by-line checking on, where
    // the statement and the journal part.
    const all = rows();
    const found = now.difference ? hints(all.filter((row) => !date || row.date <= date), ticked, now.difference, style()) : [];
    const points = checkpoints(all, lineByLine ? expected : {});
    const part = partHint(all, points, style());
    const lines = found.slice(0, 5).map((hint) => {
      const row = hint.id && all.find((entry) => entry.id === hint.id);
      return `<p${hint.id ? ` data-id="${escape(hint.id)}"` : ''}>${row ? `${escape(row.date)} ${escape(row.description)} ${escape(money(row.amount))}: ` : ''}${escape(hint.reason)}</p>`;
    });
    if (part) {
      lines.unshift(`<p${part.id ? ` data-id="${escape(part.id)}"` : ''}>${escape(part.text)}${part.id ? '' : `<button data-add="${part.amount}" data-date="${escape(part.date)}" data-from="${escape(part.from)}">Add ${escape(money(part.amount))}</button><button data-find="${part.amount}" data-date="${escape(part.date)}">Find it</button>`}</p>`);
    }
    $('hints').innerHTML = lines.join('');
    const lit = new Set([...found.map((hint) => hint.id), part && part.id].filter(Boolean));
    for (const tr of $('rows').children) {
      tr.classList.toggle('hinted', lit.has(tr.dataset.id));
      tr.classList.toggle('first', Boolean(points.first && points.first.id === tr.dataset.id));
    }

    $('finish').disabled = !now.canFinish || (busy && writable);
    $('finish').title = !now.canFinish
      ? 'needs a difference of zero, with every line up to the statement date ticked'
      : writable
        ? `previews a balance assertion for ${date}, then writes it`
        : 'shows the assertion to copy into the journal yourself';
    $('next').innerHTML = nextStep(now, balance, date, writable);
  }

  /**
   * The one line that says what to do now, written from the state the window is in. It never
   * repeats the read-only banner: that is said once, at the top.
   */
  function nextStep(now, balance, date, canWrite) {
    if (now.tooEarly) return 'Set the statement date after the balance already asserted.';
    // Nothing up to the statement date is left to tick, which is common when the journal is kept
    // marked as it goes: then the only thing to do is compare totals, and saying "tick the lines"
    // sends the person looking for work that does not exist.
    const nothingLeft = now.shown > 0 && now.outstanding.length === 0;
    if (balance == null) {
      return nothingLeft
        ? `Everything up to ${escape(date || 'the statement date')} is cleared. Type the statement's closing balance; at a difference of zero, Finish asserts it.`
        : "Type the statement's closing balance, then tick the lines the statement shows.";
    }
    if (now.difference == null) return 'Tick the lines the statement shows.';
    if (now.difference !== 0) {
      return nothingLeft
        ? `Everything up to ${escape(date || 'the statement date')} is ticked, but <b>${escape(money(now.difference))}</b> is unaccounted for: a line the journal is missing (perhaps booked to another account: <b>Find a transaction</b>), or one with the wrong amount or date.`
        : `Tick the lines the statement shows. <b>${escape(money(now.difference))}</b> still to account for.`;
    }
    if (now.outstanding.length) return 'The totals match, but some lines up to the statement date are not ticked.';
    return canWrite
      ? 'The totals match. <b>Finish</b> shows the balance assertion, then writes it.'
      : 'The totals match. <b>Show the assertion</b> gives the line to copy into the journal yourself.';
  }

  /** The line under the title: short, and about the account, not the files behind it. */
  function drawSub() {
    const data = state.data;
    const since = data.start ? `since the balance asserted on ${data.start.date}` : 'from the first posting, no balance asserted yet';
    $('sub').textContent = `${data.rows.length} postings in ${data.commodity || 'its commodity'}, ${since}${writable ? '. Changes are written to the file as you make them.' : ''}`;
  }

  /** What is hidden, where it is from, and the control that shows it. */
  function drawHidden(view) {
    if (!hideCleared) {
      const cleared = clearedAtOpen.size;
      $('hidden').innerHTML = cleared
        ? `Showing the ${cleared} posting${cleared === 1 ? '' : 's'} that were already cleared<button data-toggle-hidden="1">hide them</button>`
        : '';
      return;
    }
    if (!view.hidden.length) { $('hidden').innerHTML = ''; return; }
    const count = view.hidden.length;
    const when = view.hiddenFrom === view.hiddenTo ? view.hiddenFrom : `${view.hiddenFrom} to ${view.hiddenTo}`;
    $('hidden').innerHTML = `${count} cleared posting${count === 1 ? '' : 's'} hidden, ${escape(when)}<button data-toggle-hidden="1">show them</button>`;
  }

  function rowHtml(row, later, newDay = false, all = []) {
    const point = expected[row.id] != null && row.balance != null ? expected[row.id] - row.balance : null;
    const delta = point == null ? '' : point === 0 ? '✓' : money(point);
    const on = ticked.has(row.id);
    const badge = row.inserted ? '<span class="badge">new</span>' : row.edited ? '<span class="badge">edited</span>' : '';
    // What is said out loud, which is more than what is drawn: a cleared line has no word on
    // it, so the label is where it is still stated rather than left to the tint.
    const spoken = on ? 'cleared' : row.status === 'Pending' ? 'pending' : 'not cleared';
    const word = row.status === 'Pending' && !on ? 'pending' : '';
    // A line in another commodity is shown but adds nothing to this balance, and that has to be
    // said on the row: a number in the right column with a running total that never moves looks
    // like a mistake otherwise.
    const foreign = !row.counted;
    const value = expected[row.id] != null ? money(expected[row.id]).replace(` ${style().commodity}`, '').replace(style().commodity, '') : '';
    let date;
    // A new transaction's date is written in its text, so this is not a control: it says so
    // rather than looking like a button that does not answer.
    if (row.inserted) date = `<span class="date-plain" title="this date is part of the transaction's text; e edits it">${escape(row.date)}</span>`;
    else if (dateBeingEdited === row.id) {
      date = `<input type="date" class="date-input" data-date-input="${escape(row.id)}" value="${escape(row.date)}" title="${escape(row.date)}" aria-label="date of this transaction">`;
    } else {
      // Up and down within the day, only where there is a neighbour to pass.
      const up = !neighbour(all, row.id, 'up').refused;
      const down = !neighbour(all, row.id, 'down').refused;
      date = `<button class="date-btn" data-date="${escape(row.id)}" title="change the date (d)">${escape(row.date)}</button>`
        + `<button class="insert" data-insert="${escape(row.id)}" title="insert a transaction here (i)">+</button>`
        + (up ? `<button class="order" data-up="${escape(row.id)}" title="earlier in the day (Shift+↑)" aria-label="move up within ${escape(row.date)}">▲</button>` : '')
        + (down ? `<button class="order" data-down="${escape(row.id)}" title="later in the day (Shift+↓)" aria-label="move down within ${escape(row.date)}">▼</button>` : '');
    }
    const classes = [on ? 'on' : '', later ? 'later' : '', newDay ? 'day' : '', writingIds.has(row.id) ? 'writing' : ''].filter(Boolean).join(' ');
    return `<tr data-id="${escape(row.id)}" tabindex="-1" role="checkbox" aria-checked="${on}"${writingIds.has(row.id) ? ' aria-busy="true"' : ''} aria-label="${escape(`${row.date} ${row.description}, ${amountOf(row)}, ${spoken}${foreign ? ', not counted' : ''}`)}" class="${classes}">
<td class="date">${date}</td>
<td>${word ? `<span class="state ${word}">${word}</span>` : ''}${foreign ? '<span class="state foreign">not counted</span>' : ''}${escape(row.description)}${badge}&nbsp;<button class="edit" data-edit="${escape(row.id)}" title="edit (e)" aria-label="edit">edit</button><br><span class="against">${escape(row.against || '')}</span></td>
<td class="n${foreign ? ' foreign' : ''}">${escape(amountOf(row))}</td><td class="n">${row.balance == null ? '?' : escape(bare(row.balance))}</td>
<td class="n expect line"><input data-expect="${escape(row.id)}" inputmode="decimal" aria-label="statement balance after this line" value="${escape(value)}"></td>
<td class="n delta line ${point == null ? '' : point === 0 ? 'ok' : 'off'}">${escape(delta)}</td></tr>`;
  }

  /** What a transaction's text means for the account, said under the editor as it is typed. */
  function reading(text) {
    if (!text.trim()) return 'Empty: the transaction will be deleted.';
    const read = readTransaction(text, state.data.account, style(), state.data.inclusive);
    if (!read.header) return 'The first line needs a date: 2026-09-05 Description.';
    if (!read.touches) return `It does not post to ${state.data.account}, so it will leave this list.`;
    if (read.postings < 2) return 'It needs another posting: the account the money came from or went to.';
    if (read.off) return `It does not balance: its amounts add up to ${money(read.off)}. Leave one amount out and hledger works it out.`;
    if (read.amount == null) return `The amount for ${state.data.account} cannot be worked out here (a cost, another commodity, or more than one amount left out); hledger works it out when it is written.`;
    return `${read.date}: ${money(read.amount)} to ${state.data.account}${read.against ? `, against ${read.against}` : ''}.`;
  }

  /** The text an editor starts from: what was typed, the edit so far, the transaction, or a template. */
  function textOf(row) {
    if (drafts[row.id] != null) return drafts[row.id];
    if (edits[row.id]) return edits[row.id].text;
    const insert = inserts.find((entry) => entry.id === row.id);
    if (insert) return insert.text;
    return row.text;
  }

  /** An editor in place of a row: the transaction's journal text, all of it, beside its file. */
  function editorHtml(row) {
    const text = textOf(row);
    const readable = text != null;
    const height = Math.min(16, Math.max(4, (text || '').split('\n').length + 1));
    const keepsWhat = writable
      ? `Ctrl+Enter writes it to the file, and hledger checks it. ${row.inserted ? '' : 'Empty it to delete the transaction.'}`
      : `Ctrl+Enter keeps it in this window. The file cannot be written from here. ${row.inserted ? '' : 'Empty it to delete the transaction.'}`;
    return `<tr class="editor" data-editor="${escape(row.id)}"><td></td><td colspan="6"><div class="editing split">
<div><textarea name="text" rows="${height}" spellcheck="false" aria-label="the transaction, as journal text"${readable ? '' : ' disabled'}>${escape(text || '')}</textarea>
<p class="reading" id="reading">${escape(readable ? reading(text) : 'Its file cannot be read here, so it cannot be edited; use edit in the terminal.')}</p>
<div class="buttons"><button class="primary" data-keep="${escape(row.id)}"${readable ? '' : ' disabled'}>${writable ? 'Write it' : 'Keep'}</button>
${row.inserted && inserts.some((entry) => entry.id === row.id) ? `<button data-drop="${escape(row.id)}">Remove</button>` : (edits[row.id] ? `<button data-undo="${escape(row.id)}">Undo the edit</button>` : '')}
<button data-close="1">Cancel</button>
<span class="muted">${escape(keepsWhat.trim())}</span></div></div>
<div class="file-view" data-view="${escape(row.id)}"></div>
</div></td></tr>`;
  }

  // ---------------------------------------------------------------- the whole file, beside

  const sources = new Map();
  /** A file's text, as the app has it now. Read through the bridge, once per version of the data. */
  function sourceOf(path) {
    if (!sources.has(path)) {
      const link = bridge();
      let text = null;
      try { text = link && typeof link.source === 'function' ? link.source(path) : null; } catch { text = null; }
      sources.set(path, text == null ? null : String(text).split('\n'));
    }
    return sources.get(path);
  }

  /**
   * Draw a file into `box`, scrolled to and lighting lines `first` to `last` (from one, the end
   * not included), or a mark before line `at` where something new will go. Only the lines in
   * view are drawn.
   */
  function showFile(box, { path, first = 0, last = 0, at = 0, caption = '' }) {
    const lines = path ? sourceOf(path) : null;
    box.hidden = false;
    if (!lines) {
      box.innerHTML = `<p class="where">${escape(path || 'the journal')} cannot be shown here.</p>`;
      return;
    }
    const height = 18;
    box.innerHTML = `<p class="where">${escape(caption || `${path}, line${last - first > 1 ? 's' : ''} ${first}${last - first > 1 ? ` to ${last - 1}` : ''}`)}</p><div class="scroll" tabindex="0" aria-label="${escape(path)}, the whole file"><div style="height:${lines.length * height}px"></div><div class="lines"></div></div>`;
    const scroll = box.querySelector('.scroll');
    const holder = box.querySelector('.lines');
    const draw = () => {
      const { from: start, to } = visibleLines(lines.length, scroll.scrollTop, scroll.clientHeight || 300, height);
      holder.style.top = `${start * height}px`;
      holder.innerHTML = lines.slice(start, to).map((text, index) => {
        const number = start + index + 1;
        const lit = number >= first && number < last;
        return `<div class="${lit ? 'hl' : ''}${number === at ? ' here' : ''}"><span class="ln">${number}</span>${escape(text) || ' '}</div>`;
      }).join('');
    };
    scroll.addEventListener('scroll', draw);
    const target = first || at || 1;
    scroll.scrollTop = Math.max(0, (target - 1) * height - 120);
    draw();
  }

  /** The editor's view of its file: the transaction lit, or where a new one will go. */
  function drawEditorView() {
    const box = $('rows').querySelector('.file-view[data-view]');
    if (!box) return;
    const id = box.dataset.view;
    const row = state.data.rows.find((entry) => entry.id === id);
    if (row && row.where && row.where.first) {
      showFile(box, { path: row.where.file, first: row.where.first, last: Math.max(row.where.last, row.where.first + 1) });
      return;
    }
    // A new one: where it will land, by the rule the plugin writes it with.
    const text = $('rows').querySelector('tr.editor textarea');
    const read = readTransaction(text ? text.value : '', state.data.account, style(), state.data.inclusive);
    const anchorId = from && from.id === id ? from.row : null;
    const place = read.date ? placement(rows().filter((entry) => !entry.inserted), { anchor: anchorId, date: read.date }) : null;
    const beside = place && state.data.rows.find((entry) => entry.id === place.id);
    const main = (state.files.find((file) => file.writable) || state.files[0] || {}).path;
    if (!beside) { showFile(box, { path: main, at: (sourceOf(main) || []).length, caption: `${main || 'the journal'}: it goes at the end` }); return; }
    const at = place.side === 'after' ? beside.where.last : beside.where.first;
    showFile(box, { path: beside.where.file, at, caption: `${beside.where.file}: it goes ${place.side === 'after' ? `after line ${at - 1}` : `before line ${at}`}, ${place.side} ${beside.date} ${beside.description}` });
  }

  function drawRows() {
    const date = $('date').value;
    const all = rows();
    const searching = $('search').value.trim() !== '';
    // A row is kept in view if the person has done anything to it, so a tick or a typed balance
    // never disappears from the window it was entered in.
    const used = new Set(all.filter((row) => touched.has(row.id) || edits[row.id] != null || expected[row.id] != null || moved[row.id] != null).map((row) => row.id));
    const view = visibleRows(matching(all, $('search').value, style()), {
      hide: hideCleared,
      cleared: clearedAtOpen,
      touched: used,
      searching,
    });
    shown = view.shown;
    drawHidden(view);
    const html = [];
    if (editing && editing.startsWith('new:') && !inserts.some((insert) => insert.id === editing)) {
      html.push(editorHtml({ id: editing, inserted: true, text: drafting || template(statement().date || state.statementDate, state.data.account, null, style()) }));
    }
    // A day boundary gets a heavier rule than the hairline between postings, so the eye can
    // find where one day's postings end.
    let previous = null;
    for (const row of shown) {
      html.push(rowHtml(row, date && row.date > date, previous !== null && row.date !== previous, all));
      previous = row.date;
      if (editing === row.id) html.push(editorHtml(row));
    }
    // The rows are replaced wholesale, which takes the focus with them, so focus goes back to
    // the line that had it, and to nothing else, so typing in the bar or in a field is never
    // disturbed.
    const active = root.activeElement;
    const hadRowFocus = Boolean(active && active.closest && active.closest('#rows tr[data-id]'));
    const focusedId = hadRowFocus ? active.closest('tr[data-id]').getAttribute('data-id') : null;
    $('rows').innerHTML = html.join('');
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    if (hadRowFocus) {
      const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
      const at = trs.findIndex((tr) => tr.dataset.id === focusedId);
      if (at >= 0) focus = at;
      if (trs[Math.min(focus, trs.length - 1)]) trs[Math.min(focus, trs.length - 1)].focus({ preventScroll: true });
    }
    drawSums();
    const field = $('rows').querySelector('tr.editor textarea:not([disabled])');
    if (field && editing) {
      if (root.activeElement !== field) field.focus({ preventScroll: true });
      // A new posting's cursor goes where its description is to be written.
      if (editing.startsWith('new:') && drafts[editing] == null && !inserts.some((insert) => insert.id === editing)) field.setSelectionRange(11, 11);
      drawEditorView();
    }
  }

  /**
   * Redraw after the data changed under the window (a write came back, or another program
   * changed the file), keeping the person's place: the row they were on stays where it was on
   * the screen, and everything keyed by a row follows it to its new id.
   */
  function adopt(data, { focusId = null } = {}) {
    const map = carry(state.data.rows, data.rows);
    const follow = (id) => (map.has(id) ? map.get(id) : null);
    const keyed = (object) => Object.fromEntries(Object.entries(object).map(([id, value]) => [follow(id), value]).filter(([id]) => id));
    const anchor = placeOf();
    touched = new Set([...touched].map(follow).filter(Boolean));
    // Rows that are new to the window (another program added them, or they came from another
    // account) are not hidden as "already cleared": they were not cleared when it opened.
    clearedAtOpen = new Set([...clearedAtOpen].map(follow).filter(Boolean));
    expected = keyed(expected);
    for (const id of Object.keys(drafts)) {
      if (id.startsWith('new:')) continue;
      const next = follow(id);
      if (next && next !== id) { drafts[next] = drafts[id]; delete drafts[id]; }
      else if (!next) delete drafts[id];
    }
    if (editing && !editing.startsWith('new:')) editing = follow(editing);
    if (dateBeingEdited) dateBeingEdited = follow(dateBeingEdited);
    for (const entry of queue) entry.ids = entry.ids.map(follow).filter(Boolean);
    for (const entry of queue) if (entry.change.kind === 'tick') entry.change.changes = entry.change.changes.map((change) => ({ ...change, id: follow(change.id) })).filter((change) => change.id);
    state.data = data;
    sources.clear();
    ticked = new Set(data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
    // Ticks still waiting their turn are shown as the person left them.
    for (const entry of queue) if (entry.change.kind === 'tick') for (const change of entry.change.changes) { if (change.on) ticked.add(change.id); else ticked.delete(change.id); }
    if (focusId) touched.add(focusId);
    drawSub();
    const was = anchor && { id: follow(anchor.id), top: anchor.top };
    drawRows();
    const target = focusId || (was && was.id);
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    const tr = target ? trs.find((element) => element.dataset.id === target) : null;
    if (tr && was && !focusId) window.scrollBy(0, tr.getBoundingClientRect().top - was.top);
    if (tr && focusId) {
      focus = trs.indexOf(tr);
      if (!editing && !/^(INPUT|TEXTAREA)$/.test((root.activeElement || {}).tagName || '')) tr.focus({ preventScroll: true });
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'nearest' });
    }
  }

  /** The row the person is on, and where it is on the screen: the focused one, or the first in view. */
  function placeOf() {
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    const active = root.activeElement && root.activeElement.closest && root.activeElement.closest('tr[data-id]');
    const top = $('bar').getBoundingClientRect().bottom;
    const tr = active || trs.find((element) => element.getBoundingClientRect().bottom > top);
    return tr ? { id: tr.dataset.id, top: tr.getBoundingClientRect().top } : null;
  }

  // ---------------------------------------------------------------- writing as changes are made

  /** The window's own record of each row a change is about, for the plugin to find it by. */
  function targetsOf(ids) {
    const out = {};
    for (const id of ids) {
      const row = state.data.rows.find((entry) => entry.id === id);
      if (row) out[id] = snapshot(row);
    }
    return out;
  }

  const stageWords = { writing: 'Writing to the file…', checking: 'Checking with hledger…' };

  /**
   * Send a change to be written. Changes go one at a time, in order; ticks made while one is
   * being written go together in the next. `ids` are the rows it is about, drawn as being
   * written until it is back.
   */
  function send(change, ids = [], then = null) {
    queue.push({ change, ids, then });
    run();
  }

  async function run() {
    if (busy || !queue.length) return;
    const link = bridge();
    if (!link || typeof link.change !== 'function') {
      queue.length = 0;
      say('This window has lost touch with the app. Run reconcile again.', true);
      return;
    }
    busy = true;
    // Ticks queued one after another go as one write.
    let entry = queue.shift();
    if (entry.change.kind === 'tick') {
      const ticks = [entry];
      while (queue.length && queue[0].change.kind === 'tick') ticks.push(queue.shift());
      entry = { change: mergeTicks(ticks.map((item) => item.change)), ids: ticks.flatMap((item) => item.ids), then: null };
    }
    writingIds = new Set(entry.ids);
    for (const tr of $('rows').children) if (writingIds.has(tr.dataset.id)) { tr.classList.add('writing'); tr.setAttribute('aria-busy', 'true'); }
    drawSums();
    const change = entry.change;
    const ids = [change.id, change.after, ...(change.changes || []).map((item) => item.id)].filter(Boolean);
    const request = { ...change, style: markStyle, targets: { ...(change.targets || {}), ...targetsOf(ids) } };
    const progress = (stage) => {
      say(stageWords[stage] || stageWords.writing, false, { busy: true });
      if (entry.progress) entry.progress(stage);
    };
    progress('writing');
    let answer;
    try {
      answer = change.kind === 'undo' ? await link.undo(progress) : await link.change(request, progress);
    } catch (error) {
      answer = { error: `The app did not answer: ${error && error.message ? error.message : error}` };
    }
    busy = false;
    writingIds = new Set();
    if (answer && typeof answer.undo === 'number') undoable = answer.undo;
    if (answer && answer.data) adopt(answer.data, { focusId: answer.focus || null });
    else drawRows();
    if (answer && answer.ok) {
      say(`${answer.message}.${answer.outside ? ' The file had changed outside this window, and was read again first.' : ''}`, false, { undo: change.kind !== 'finish' });
    } else {
      say((answer && answer.error) || 'Nothing was written.', true, { undo: true });
    }
    if (entry.then) entry.then(answer || {});
    run();
  }

  /** Tick or untick a row, and the rest of its transaction when marking whole transactions. */
  function toggle(id) {
    const row = rows().find((entry) => entry.id === id);
    const date = $('date').value;
    if (!row || (date && row.date > date)) return;
    // In transaction mode the mark covers the whole transaction, so every row of it ticks
    // together: ticking one posting of a two-posting transaction and not the other would be a
    // state hledger cannot write.
    const group = markStyle === 'transaction'
      ? rows().filter((entry) => entry.where && row.where && entry.where.file === row.where.file && entry.where.first === row.where.first && !entry.inserted)
      : [row];
    const turningOn = !ticked.has(id);
    for (const entry of group) {
      touched.add(entry.id);
      if (turningOn) ticked.add(entry.id); else ticked.delete(entry.id);
    }
    if (writable && !row.inserted) send({ kind: 'tick', changes: [{ id, on: turningOn }] }, group.map((entry) => entry.id));
    if (group.length > 1) { hidePreview(); drawRows(); return; }
    const tr = [...$('rows').children].find((element) => element.dataset.id === id);
    if (tr) {
      // The row is redrawn in place rather than by rebuilding the list, and only its state
      // changes: the tint, and what a screen reader is told.
      tr.classList.toggle('on', ticked.has(id));
      tr.setAttribute('aria-checked', String(ticked.has(id)));
      if (writable) { tr.classList.add('writing'); tr.setAttribute('aria-busy', 'true'); }
    }
    hidePreview();
    drawSums();
  }

  /** Keep what an editor says, as an edit or a new posting, after checking it. */
  function keep(id) {
    const form = $('rows').querySelector(`tr.editor[data-editor="${CSS.escape(id)}"]`);
    const text = form.querySelector('textarea').value.replace(/\s+$/, '');
    const read = readTransaction(text, state.data.account, style(), state.data.inclusive);
    const isNew = id.startsWith('new:');
    const refuse = (message) => { say(message, true); $('reading').textContent = message; };
    if (text.trim() && !read.header) { refuse('The first line needs a date: 2026-09-05 Description.'); return; }
    if (isNew && !text.trim()) { refuse('There is nothing to add. Cancel it instead.'); return; }
    if (isNew && !read.touches) { refuse(`It does not post to ${state.data.account}, so it does not belong here.`); return; }
    if (text.trim() && read.postings < 2) { refuse('It needs another posting: the account the money came from or went to.'); return; }
    if (text.trim() && read.off) { refuse(`It does not balance: its amounts add up to ${money(read.off)}.`); return; }
    const floor = read.date ? moveRefusal(state.data, read.date) : null;
    if (floor) { refuse(`Not ${isNew ? 'added' : 'written'}: ${read.date} is ${floor}.`); return; }
    if (writable) {
      const anchor = isNew && from && from.id === id ? from.row : null;
      const typed = isNew && from && from.id === id && expected[from.row] != null ? from.row : null;
      const button = form.querySelector('[data-keep]');
      button.disabled = true;
      button.textContent = 'Writing…';
      const done = (answer) => {
        if (!answer.ok) {
          // The editor stays open with everything typed, and says what went wrong.
          const field = $('rows').querySelector('tr.editor [data-keep]');
          if (field) { field.disabled = false; field.textContent = 'Write it'; }
          const reading = $('reading');
          if (reading) reading.textContent = answer.error || 'Nothing was written.';
          return;
        }
        delete drafts[id];
        if (editing === id) editing = null;
        drafting = null;
        // A typed running balance the new line was added to explain is now that line's.
        if (typed && answer.focus && expected[typed] != null) { expected[answer.focus] = expected[typed]; delete expected[typed]; }
        if (from && from.id === id) from = null;
        drawRows();
      };
      if (isNew) send({ kind: 'insert', text, after: anchor }, anchor ? [anchor] : [], done);
      else send({ kind: 'edit', id, text }, [id], done);
      return;
    }
    if (isNew) {
      const fresh = { id, text };
      // Added to explain where the statement and journal part, it goes beside that posting.
      if (from && from.id === id && rows().some((row) => row.id === from.row)) fresh.after = from.row;
      const insert = inserts.find((entry) => entry.id === id);
      if (insert) Object.assign(insert, fresh); else inserts.push(fresh);
      ticked.add(id);
      if (from && from.id === id && expected[from.row] != null) {
        expected[id] = expected[from.row];
        delete expected[from.row];
      }
      from = null;
    } else {
      const row = state.data.rows.find((entry) => entry.id === id);
      if (text === (row.text || '').replace(/\s+$/, '')) delete edits[id]; else edits[id] = { text };
      if (!text.trim()) { ticked.delete(id); delete expected[id]; }
    }
    delete drafts[id];
    editing = null;
    drafting = null;
    say('');
    hidePreview();
    drawRows();
  }

  function moveFocus(to) {
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    if (!trs.length) return;
    focus = Math.max(0, Math.min(trs.length - 1, to));
    trs[focus].focus();
  }

  /**
   * Move a transaction to `date`, which is what the date editor or Alt+arrow asks for.
   *
   * Moving changes the transaction's date, not its position in the file: the list is ordered by
   * date, so the row appears in its new place, and nothing else about the journal changes.
   */
  function moveTo(id, date) {
    const row = rows().find((entry) => entry.id === id);
    if (!row || !date || row.date === date) return;
    if (readOnly()) { say('The journal is read-only, so nothing can be written: run open in the terminal to edit it.', true); return; }
    const refused = moveRefusal(state.data, date);
    if (refused) { say(`Cannot move it to ${date}: it is ${refused}.`, true); return; }
    if (id.startsWith('new:')) { say('A new posting takes its date from its text. Edit it to change the date.', true); return; }
    touched.add(id);
    send({ kind: 'date', id, date }, [id]);
  }

  /** Move a row up or down within its day, which moves its transaction in the file. */
  function reorder(id, direction) {
    if (readOnly()) { say('The journal is read-only, so the order cannot be changed: run open in the terminal to edit it.', true); return; }
    const where = neighbour(rows(), id, direction);
    const row = rows().find((entry) => entry.id === id);
    if (where.refused) { say(`${row ? row.description : 'It'} stays where it is: ${where.refused}.`, true); return; }
    touched.add(id);
    send({ kind: 'reorder', id, direction }, [id], (answer) => {
      if (!answer.ok) return;
      // The row the person moved keeps the focus, wherever it went.
      const moved = state.data.rows.find((entry) => entry.where.file === row.where.file && entry.text === row.text && entry.account === row.account && entry.where.occurrence === row.where.occurrence);
      const index = moved ? shown.findIndex((entry) => entry.id === moved.id) : -1;
      if (index >= 0) moveFocus(index);
    });
  }

  function undo() {
    if (!writable) return;
    if (!undoable && !busy) { say('Nothing to undo: no change has been written from this window.', true); return; }
    send({ kind: 'undo' });
  }

  function hidePreview() {
    pending = null;
    $('preview').hidden = true;
    $('preview').innerHTML = '';
  }

  /** Ask the plugin what Finish would write, and show it, with a button to write it. */
  async function preview() {
    const link = bridge();
    if (!link) { say('This window has lost touch with the app. Run reconcile again.', true); return; }
    const { date, balance } = statement();
    const request = writable
      ? { kind: 'finish', finish: { date, balance }, expected: lineByLine ? expected : {}, style: markStyle, targets: targetsOf(Object.keys(expected)) }
      : { ticked: [...ticked], finish: { date, balance }, edits, inserts, expected: lineByLine ? expected : {}, moved, style: markStyle, fingerprint: state.fingerprint };
    if (writable) say('Reading the file again…', false, { busy: true });
    const result = await link.preview(request);
    if (writable) say('');
    if (result.data) adopt(result.data);
    const canWriteFiles = (result.writable || []).some((file) => file.writable);
    const lines = [];
    for (const file of result.files) {
      const inserted = file.inserted || [];
      const replaced = (file.replaced || []).length;
      const said = [
        file.changes.length && `${file.changes.length} line${file.changes.length === 1 ? '' : 's'} would change`,
        replaced && `${replaced} transaction${replaced === 1 ? '' : 's'} rewritten`,
        inserted.length && `${inserted.length} transaction${inserted.length === 1 ? '' : 's'} added`,
      ].filter(Boolean);
      lines.push(`<p><b>${escape(file.path)}</b>${said.length ? `: ${said.join(', ')}` : ''}${file.appended ? `${said.length ? ', and' : ':'} at the end:` : ''}</p>`);
      for (const entry of inserted) lines.push(`<pre class="add">${escape(`${entry.side === 'before' ? `before line ${entry.line}` : `after line ${entry.line - 1}`}:\n${entry.text}`)}</pre>`);
      for (const entry of file.replaced || []) {
        lines.push(`<pre><span class="del">${escape(entry.before.split('\n').map((line, at) => `${String(entry.line + at).padStart(6)}  ${line}`).join('\n'))}</span>\n<span class="add">${escape(entry.after ? entry.after.split('\n').map((line) => `        ${line}`).join('\n') : '        (deleted)')}</span></pre>`);
      }
      const changes = file.changes.slice(0, 40).map((change) => `<span class="del">${escape(String(change.line).padStart(6))}  ${escape(change.before)}</span>\n<span class="add">${escape(String(change.line).padStart(6))}  ${escape(change.after)}</span>`);
      if (file.changes.length > 40) changes.push(`… and ${file.changes.length - 40} more`);
      if (changes.length) lines.push(`<pre>${changes.join('\n')}</pre>`);
      if (file.appended) lines.push(`<pre class="add" id="assertion">${escape(file.appended)}</pre>`);
    }
    // What kind of change this is, said before the lines it would write: the contract is that
    // nothing surprising reaches the file.
    lines.unshift(`<p class="marks">${markStyle === 'transaction'
      ? "Marks transactions: the cleared mark goes on the transaction's own line."
      : "Marks postings: the cleared mark goes on each posting's own line."}</p>`);
    // Marks that disagree with each other, said before anything is asserted over them.
    const conflicts = result.conflicts || markConflicts(rows().filter((row) => !date || row.date <= date), markStyle);
    if (conflicts.length) {
      lines.push(`<div class="conflicts"><p><b>${conflicts.length} transaction${conflicts.length === 1 ? '' : 's'} with marks that disagree</b> (a posting is its own mark, else its transaction's):</p>${conflicts.slice(0, 8).map((entry) => `<p data-id="${escape(entry.id)}">${escape(`${entry.date} ${entry.description}: ${entry.why}`)}</p>`).join('')}${conflicts.length > 8 ? `<p>and ${conflicts.length - 8} more</p>` : ''}</div>`);
    }
    if (!result.files.length && !result.missing.length) lines.push('<p>Nothing to write.</p>');
    // One line per reason: two hundred postings in a file that cannot be read are one problem.
    const reasons = [...new Set(result.missing.map((entry) => entry.why))];
    if (reasons.length) lines.push(`<p>${escape(reasons.join('; ').replace(/\.$/, ''))}.</p>`);
    if (!result.files.some((file) => file.appended) && result.assertion) {
      lines.push(`<p>The assertion to add at the end of the journal:</p><pre class="add" id="assertion">${escape(result.assertion)}</pre>`);
    }
    const canWrite = canWriteFiles && writable && result.files.length && !result.missing.length;
    lines.push(`<div class="tools">${canWrite ? '<button class="primary" id="apply">Write and check</button>' : ''}${!canWriteFiles ? '<button id="copy">Copy the assertion</button>' : ''}<button id="cancel">Cancel</button><span id="apply-said" class="muted" role="status"></span></div>`);
    if (!canWriteFiles) lines.push('<p class="note">This file did not come from an opened folder, so nothing can be written here. Run open in the terminal to edit it, or copy the assertion into the file yourself.</p>');
    pending = request;
    $('preview').innerHTML = lines.join('');
    $('preview').hidden = false;
    $('preview').scrollIntoView({ block: 'nearest' });
    const apply = $('apply');
    if (apply) apply.addEventListener('click', write);
    const copy = $('copy');
    if (copy) copy.addEventListener('click', async () => {
      const text = $('assertion') ? $('assertion').textContent : '';
      try { await window.navigator.clipboard.writeText(text); say('Copied. Paste it at the end of the journal.'); } catch { say('Copying was not allowed here; select the text above and copy it.', true); }
    });
    $('cancel').addEventListener('click', hidePreview);
  }

  /**
   * Write what the preview showed. The button cannot be pressed twice: it is disabled at once and
   * says what is happening, writing and then checking, until the answer is back.
   */
  function write() {
    const link = bridge();
    const button = $('apply');
    if (!link || !pending || !button || button.disabled) return;
    button.disabled = true;
    $('cancel').disabled = true;
    button.textContent = stageWords.writing;
    const request = pending;
    const progress = (stage) => {
      if ($('apply')) $('apply').textContent = stageWords[stage] || stageWords.writing;
      if ($('apply-said')) $('apply-said').textContent = '';
    };
    // Finish goes through the same queue as every other change, after whatever is still being
    // written, and is told the stages as they happen.
    queue.push({ change: request, ids: [], then: (answer) => {
      if (answer.ok) { hidePreview(); return; }
      if ($('apply')) { $('apply').disabled = false; $('apply').textContent = 'Write and check'; }
      if ($('cancel')) $('cancel').disabled = false;
      if ($('apply-said')) $('apply-said').textContent = answer.error || 'Nothing was written.';
    }, progress });
    run();
  }

  function startAdding(amount = null, date = null, row = null) {
    made += 1;
    editing = `new:${made}`;
    from = row ? { id: editing, row } : null;
    drafting = template(date || statement().date || state.statementDate, state.data.account, amount, style());
    drawRows();
  }

  /**
   * Open one transaction's date in place, ready to change. This is the only way to change a
   * date: deliberate, one row at a time, and it goes through the same checks as every other
   * date change, so it can never land before the asserted balance or write to a read-only file.
   */
  function startDateEdit(id) {
    if (readOnly()) { say('The journal is read-only, so the date cannot be changed: run open in the terminal to edit it.', true); return; }
    dateBeingEdited = id;
    drawRows();
    const input = $('rows').querySelector(`tr[data-id="${CSS.escape(id)}"] .date-input`);
    if (!input) return;
    input.focus();
    if (typeof input.showPicker === 'function') { try { input.showPicker(); } catch { /* not in every browser, and not in every gesture */ } }
  }

  /** Close the date editor, moving the transaction when a date was given. */
  function finishDateEdit(id, value) {
    if (dateBeingEdited !== id) return;
    dateBeingEdited = null;
    if (value) moveTo(id, value);
    drawRows();
  }

  /**
   * Open a new transaction after this one, prefilled with its day, so the two land in the
   * same place in the file as they do in the list.
   */
  function startInserting(after) {
    if (readOnly()) { say('The journal is read-only, so nothing can be written: run open in the terminal to edit it.', true); return; }
    const row = shown.find((entry) => entry.id === after) || rows().find((entry) => entry.id === after);
    startAdding(null, row ? row.date : null, row ? row.id : null);
  }

  // ---------------------------------------------------------------- finding a transaction

  let found = [];
  let chosen = -1;

  function openFind(amount = null, date = null) {
    $('find').hidden = false;
    const now = sums();
    const value = amount != null ? amount : now.difference;
    if (value != null && value !== 0) $('find-amount').value = bare(value);
    $('find-date').value = date || statement().date || '';
    $('find-amount').focus();
    $('find').scrollIntoView({ block: 'nearest' });
  }

  async function search() {
    const link = bridge();
    if (!link || typeof link.find !== 'function') { say('This window has lost touch with the app. Run reconcile again.', true); return; }
    const amount = parseInput($('find-amount').value, style());
    $('find-said').textContent = 'Looking…';
    $('found').innerHTML = '';
    $('find-file').hidden = true;
    const answer = await link.find({ amount, date: $('find-date').value || null, words: $('find-words').value });
    found = answer.candidates || [];
    chosen = -1;
    $('find-said').textContent = answer.error
      ? answer.error
      : found.length
        ? `${found.length} transaction${found.length === 1 ? '' : 's'} under other accounts. Moving a posting changes its account to ${state.data.account} in place: nothing is copied.`
        : 'Nothing under another account matches. It may be missing from the journal: add it instead.';
    $('found').innerHTML = found.map((candidate, index) => `<li data-found="${index}" tabindex="0">
<b>${escape(candidate.date)}</b> ${escape(candidate.description)}<span class="why">${escape(candidate.reasons.join(', '))}</span>
${candidate.postings.map((posting) => `<div class="posting"><span>${escape(posting.account)}</span><span class="amount">${escape(posting.amount)}</span>${writable && !posting.generated && posting.at != null ? `<button data-move="${index}" data-at="${posting.at}" title="change this posting's account to ${escape(state.data.account)}, in place">Move it to this account</button>` : ''}</div>`).join('')}
</li>`).join('');
    if (found.length) choose(0);
  }

  function choose(index) {
    chosen = index;
    for (const li of $('found').children) li.classList.toggle('chosen', Number(li.dataset.found) === index);
    const candidate = found[index];
    if (candidate) showFile($('find-file'), { path: candidate.file, first: candidate.first, last: Math.max(candidate.last, candidate.first + 1) });
  }

  function moveHere(index, at) {
    const candidate = found[index];
    if (!candidate) return;
    const posting = candidate.postings.find((entry) => entry.at === at);
    send({ kind: 'account', candidate: { file: candidate.file, first: candidate.first, last: candidate.last, text: candidate.text, description: candidate.description }, at }, [], (answer) => {
      if (!answer.ok) { $('find-said').textContent = answer.error; return; }
      $('find-said').textContent = `Moved: ${candidate.date} ${candidate.description} is in ${state.data.account} now, and no longer in ${posting ? posting.account : 'the other account'}.`;
      found.splice(index, 1);
      $('found').innerHTML = '';
      $('find-file').hidden = true;
    });
  }

  $('find-open').addEventListener('click', () => openFind());
  $('find-close').addEventListener('click', () => { $('find').hidden = true; });
  $('find-go').addEventListener('click', search);
  for (const id of ['find-amount', 'find-date', 'find-words']) {
    $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  }
  $('found').addEventListener('click', (event) => {
    const move = event.target.closest('button[data-move]');
    if (move) { moveHere(Number(move.dataset.move), Number(move.dataset.at)); return; }
    const li = event.target.closest('li[data-found]');
    if (li) choose(Number(li.dataset.found));
  });
  $('found').addEventListener('keydown', (event) => {
    const li = event.target.closest('li[data-found]');
    if (li && event.key === 'Enter' && event.target === li) choose(Number(li.dataset.found));
  });

  // ---------------------------------------------------------------- the file changing outside

  /**
   * Ask whether another program changed the file, and if so draw it as it is now. Only while
   * the window is in view and nothing of its own is being written: a write reads the file
   * again first anyway.
   */
  async function poll() {
    // window.__reconcileHold stops the looking, so a check can make an outside edit and act
    // before the window has seen it, which a person can do too.
    if (!writable || busy || queue.length || window.__reconcileHold) return;
    const link = bridge();
    if (!link || typeof link.poll !== 'function') return;
    busy = true;
    let answer;
    try { answer = await link.poll(); } catch { answer = null; }
    busy = false;
    if (answer && answer.changed && answer.data) {
      adopt(answer.data);
      say('The file changed outside this window, so it was read again.');
    } else if (answer && answer.error) {
      say(answer.error, true);
    }
    run();
  }
  if (writable) {
    setInterval(() => { if (root.visibilityState !== 'hidden') poll(); }, 2000);
    window.addEventListener('focus', () => poll());
    root.addEventListener('visibilitychange', () => { if (root.visibilityState === 'visible') poll(); });
  }

  // ---------------------------------------------------------------- events

  $('rows').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) {
      if (button.dataset.date) startDateEdit(button.dataset.date);
      else if (button.dataset.insert) startInserting(button.dataset.insert);
      else if (button.dataset.up) reorder(button.dataset.up, 'up');
      else if (button.dataset.down) reorder(button.dataset.down, 'down');
      else if (button.dataset.edit) { editing = button.dataset.edit; drawRows(); }
      else if (button.dataset.keep) keep(button.dataset.keep);
      else if (button.dataset.restore) { delete edits[button.dataset.restore]; drawRows(); }
      else if (button.dataset.drop) { inserts = inserts.filter((insert) => insert.id !== button.dataset.drop); ticked.delete(button.dataset.drop); delete expected[button.dataset.drop]; editing = null; drawRows(); }
      else if (button.dataset.undo) { delete edits[button.dataset.undo]; editing = null; drawRows(); }
      else if (button.dataset.close) { if (editing) delete drafts[editing]; editing = null; drafting = null; drawRows(); }
      return;
    }
    if (event.target.closest('input') || event.target.closest('tr.editor')) return;
    const tr = event.target.closest('tr[data-id]');
    if (tr) toggle(tr.dataset.id);
  });
  $('rows').addEventListener('input', (event) => {
    if (event.target.tagName === 'TEXTAREA') {
      if (editing) drafts[editing] = event.target.value;
      $('reading').textContent = reading(event.target.value);
      if (editing && editing.startsWith('new:')) drawEditorView();
      return;
    }
    const id = event.target.dataset.expect;
    if (!id) return;
    const value = parseInput(event.target.value, style());
    if (value == null) delete expected[id]; else expected[id] = value;
    const row = rows().find((entry) => entry.id === id);
    const cell = event.target.closest('tr').querySelector('td.delta');
    // A row whose running balance is unknown has no difference to show: `value - null` would be
    // the typed balance itself, presented as though the line were out by exactly that much.
    const point = value == null || !row || row.balance == null ? null : value - row.balance;
    cell.textContent = point == null ? '' : point === 0 ? '✓' : money(point);
    cell.className = `n delta ${point == null ? '' : point === 0 ? 'ok' : 'off'}`;
    hidePreview();
    drawSums();
  });
  $('rows').addEventListener('keydown', (event) => {
    // In the text, Enter is a new line; Ctrl+Enter (or Cmd+Enter) keeps it.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target.closest('tr.editor')) { event.preventDefault(); keep(event.target.closest('tr.editor').dataset.editor); }
  });
  $('rows').addEventListener('focusout', (event) => {
    const input = event.target.closest && event.target.closest('[data-date-input]');
    if (input && dateBeingEdited === input.dataset.dateInput) finishDateEdit(input.dataset.dateInput, input.value);
  });
  // The date editor is closed by any click away from it, not only by focus leaving it. Some
  // engines move focus when the date picker opens or is dismissed, so a later click fires no
  // focusout and the editor is left sitting over a row that then gets ticked.
  //
  // A click on the row itself only closes the editor: one click does one thing. Buttons and
  // fields are left alone so each still does its own job on the same click.
  root.addEventListener('click', (event) => {
    if (dateBeingEdited == null) return;
    const target = event.target;
    if (target.closest && target.closest('.date-input')) return;
    const id = dateBeingEdited;
    const open = $('rows').querySelector(`tr[data-id="${CSS.escape(id)}"] .date-input`);
    finishDateEdit(id, open ? open.value : '');
    const onRow = target.closest && target.closest('tr[data-id]');
    const onControl = target.closest && (target.closest('button') || target.closest('input') || target.closest('textarea'));
    if (onRow && !onControl) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);

  $('hidden').addEventListener('click', (event) => {
    if (!event.target.closest('[data-toggle-hidden]')) return;
    hideCleared = !hideCleared;
    hidePreview();
    drawRows();
  });
  $('notes').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-restore]');
    if (button) { delete edits[button.dataset.restore]; hidePreview(); drawRows(); }
  });
  $('status').addEventListener('click', (event) => {
    if (event.target.closest('#undo')) undo();
  });
  $('hints').addEventListener('click', (event) => {
    const add = event.target.closest('button[data-add]');
    if (add) { startAdding(Number(add.dataset.add), add.dataset.date, add.dataset.from); return; }
    const look = event.target.closest('button[data-find]');
    if (look) { openFind(Number(look.dataset.find), look.dataset.date); search(); return; }
    const p = event.target.closest('p[data-id]');
    if (!p) return;
    const index = shown.findIndex((row) => row.id === p.dataset.id);
    if (index >= 0) moveFocus(index);
  });
  $('style').addEventListener('change', () => {
    markStyle = $('style').value === 'transaction' ? 'transaction' : 'posting';
    const link = bridge();
    if (link && typeof link.setStyle === 'function') link.setStyle(markStyle);
    hidePreview();
    drawSub();
    drawRows();
    const conflicts = markConflicts(state.data.rows, markStyle).length;
    say(`Cleared marks now go on ${markStyle === 'transaction' ? 'the whole transaction' : "this account's line"}, from the next tick on.`
      + (conflicts ? ` ${conflicts} transaction${conflicts === 1 ? ' has' : 's have'} marks that disagree with this; Finish lists ${conflicts === 1 ? 'it' : 'them'}.` : ''));
  });
  $('lines').addEventListener('change', () => {
    lineByLine = $('lines').checked;
    $('table').classList.toggle('lines', lineByLine);
    const link = bridge();
    if (link && typeof link.setLines === 'function') link.setLines(lineByLine);
    hidePreview();
    drawSums();
    const typed = Object.keys(expected).length;
    say(lineByLine
      ? 'Type the statement\'s balance after a line to see where they part; lines that match are asserted when you finish.'
      : `Line by line is off${typed ? `: the ${typed} figure${typed === 1 ? '' : 's'} typed are kept, and not written` : ''}.`);
  });
  for (const id of ['date', 'balance']) $(id).addEventListener('input', () => { hidePreview(); id === 'date' ? drawRows() : drawSums(); });
  $('search').addEventListener('input', drawRows);
  $('add').addEventListener('click', () => startAdding());
  $('all').addEventListener('click', () => {
    const date = $('date').value;
    const changes = [];
    for (const row of shown) {
      if (date && row.date > date) continue;
      if (!ticked.has(row.id) && !row.inserted) changes.push({ id: row.id, on: true });
      ticked.add(row.id);
      touched.add(row.id);
    }
    if (writable && changes.length) send({ kind: 'tick', changes }, changes.map((change) => change.id));
    hidePreview();
    drawRows();
  });
  $('finish').addEventListener('click', () => preview());

  root.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(event.target.tagName);
    // The date editor: Enter keeps the date, Escape leaves it alone.
    const dateInput = event.target.closest && event.target.closest('[data-date-input]');
    if (dateInput) {
      if (event.key === 'Enter') { event.preventDefault(); finishDateEdit(dateInput.dataset.dateInput, dateInput.value); }
      else if (event.key === 'Escape') { event.preventDefault(); finishDateEdit(dateInput.dataset.dateInput, null); }
      return;
    }
    if (event.key === 'Escape') {
      if (editing) { delete drafts[editing]; editing = null; drafting = null; drawRows(); return; }
      if (event.target === $('search')) { $('search').value = ''; drawRows(); return; }
      if (!$('find').hidden && event.target.closest && event.target.closest('#find')) { $('find').hidden = true; return; }
    }
    if (typing) return;
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    // The row with the focus is the one a key acts on, however it got the focus: a click, a
    // hint, or the arrows.
    const current = root.activeElement && root.activeElement.closest ? root.activeElement.closest('#rows tr[data-id]') : null;
    if (current && trs.includes(current)) focus = trs.indexOf(current);
    // Shift with an arrow moves the transaction within its day, which is its place in the file.
    if (event.shiftKey && !event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'J' || event.key === 'K') && trs[focus]) {
      event.preventDefault();
      reorder(trs[focus].dataset.id, event.key === 'ArrowDown' || event.key === 'J' ? 'down' : 'up');
      return;
    }
    // Alt with an arrow moves the transaction to the next day that has postings, the quick way
    // to step it onto the day the statement shows.
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && trs[focus]) {
      event.preventDefault();
      const at = shown.findIndex((row) => row.id === trs[focus].dataset.id);
      const here = shown[at] && shown[at].date;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let target = null;
      for (let index = at + step; index >= 0 && index < shown.length; index += step) {
        if (shown[index].date !== here) { target = shown[index]; break; }
      }
      if (!target) {
        say(`There is no ${step > 0 ? 'later' : 'earlier'} date in this list to move it to.`, true);
        return;
      }
      moveTo(trs[focus].dataset.id, target.date);
      return;
    }
    if ((event.key === 'z' && (event.ctrlKey || event.metaKey)) || (event.key === 'u' && !event.ctrlKey && !event.metaKey)) { event.preventDefault(); undo(); return; }
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); moveFocus(focus + 1); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); moveFocus(focus - 1); }
    else if (event.key === ' ' && trs[focus] && event.target.tagName !== 'BUTTON') { event.preventDefault(); toggle(trs[focus].dataset.id); }
    else if (event.key === 'e' && trs[focus]) { event.preventDefault(); editing = trs[focus].dataset.id; drawRows(); }
    else if (event.key === 'd' && trs[focus]) { event.preventDefault(); startDateEdit(trs[focus].dataset.id); }
    else if ((event.key === 'i' || (event.key === 'N' && event.shiftKey)) && trs[focus]) { event.preventDefault(); startInserting(trs[focus].dataset.id); }
    else if (event.key === 'n') { event.preventDefault(); startAdding(); }
    else if (event.key === 'f' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); openFind(); }
    else if (event.key === 'a' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); $('all').click(); }
    else if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  });

  // The statement balance is the first thing to type when it was not given, so the cursor is
  // already there. Otherwise the postings are, and the keys do something straight away.
  const balanceGiven = $('balance').value.trim() !== '';
  $('balance').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); moveFocus(0); }
  });

  drawSub();
  drawRows();
  // Open where the work is: the rows stay, because the running balances need them, but the view
  // starts at the first one still to do.
  const firstLeft = shown.findIndex((row) => !ticked.has(row.id));
  const left = firstLeft > 0 ? firstLeft : 0;
  // Focus before scrolling: focusing the balance field scrolls back to the top, so doing it
  // afterwards would undo the scroll below.
  if (balanceGiven) moveFocus(left); else $('balance').focus();
  if (left > 0) {
    const tr = [...$('rows').children].find((element) => element.dataset.id === shown[left].id);
    if (tr && typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'center' });
  }
}
