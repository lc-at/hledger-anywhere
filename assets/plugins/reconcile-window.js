/**
 * The reconcile window: the statement, the account's postings, and the difference.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window; the window
 * imports `mount` to draw it. It reads and writes nothing itself: a preview and an apply go
 * back through the bridge to the plugin, which is the side that can reach the files.
 *
 * Each posting shows the account's balance after it, the way a statement prints one beside each
 * line, and takes the statement's figure for it: the difference shows there, and the first line
 * where it is not zero is where the statement and the journal part. A transaction is edited as
 * its journal text, anything in it, and a missing one is added the same way; nothing is written
 * until Save or Finish, which preview it first.
 *
 * Keys: ↑ ↓ or j k move, Space ticks, e edits, n adds a posting, a ticks every posting shown,
 * / searches, Ctrl+Enter keeps an edit, Escape clears the search or closes an editor.
 */

import { checkpoints, hints, moveRefusal, ordered, parseInput, readTransaction, readable, summarize, template } from './reconcile-data.js';
import { escape, isLight, mix } from './window-kit.js';

/**
 * The edit control's mark: a pencil, drawn rather than typed.
 *
 * A character would need the font to have a picture of a pencil, and the marks people's
 * fonts do have for this are inconsistent and were not wanted. It is stroked in
 * `currentColor`, so it takes the button's colour and therefore the theme's, and it is
 * hidden from assistive technology because the button already carries the name.
 */
const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path d="M4 20h4L20 8a2.83 2.83 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  + '</svg>';

/** The whole document, with the data in a JSON block and the page to be mounted. */
export function page({ data, colors, token, files, accounts = [], statementDate, statementBalance, fingerprint, module }) {
  const payload = JSON.stringify({ data, colors, token, files, accounts, statementDate, statementBalance, fingerprint }).replace(/</g, '\\u003c');
  const writable = files.some((file) => file.writable);
  const soft = mix(colors.background, colors.dim, 14);
  const softer = mix(colors.background, colors.dim, 7);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: reconcile ${escape(data.account)}</title>
<style>
  :root { color-scheme: ${isLight(colors.background) ? 'light' : 'dark'}; }
  body { margin:0; background:${colors.background}; color:${colors.foreground}; font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:20px 24px 40px; }
  h1 { font-size:18px; font-weight:600; margin:0; }
  .sub { color:${colors.dim}; margin:2px 0 14px; font-size:13px; }
  .statement { display:flex; flex-wrap:wrap; gap:16px; align-items:end; margin:0 0 12px; }
  label { display:flex; flex-direction:column; gap:3px; font-size:12px; color:${colors.dim}; }
  input { font:inherit; color:${colors.foreground}; background:${softer}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 8px; }
  input:disabled { opacity:.5; }
  input:focus-visible, button:focus-visible, tr:focus-visible { outline:2px solid ${colors.accent}; outline-offset:1px; }
  .sums { display:flex; flex-wrap:wrap; gap:1px; background:${colors.dim}44; border-radius:6px; overflow:hidden; margin:0 0 10px; }
  .sums div { flex:1 1 150px; }
  .sums div { background:${colors.background}; padding:8px 10px; }
  .sums span { display:block; font-size:11px; color:${colors.dim}; text-transform:uppercase; letter-spacing:.04em; }
  .sums b { font-variant-numeric:tabular-nums; font-weight:600; }
  /* The difference is the number the whole window is for, so it is the loud one. */
  .sums .difference { background:${softer}; }
  .sums .difference b { font-size:20px; }
  .sums .difference.zero b { color:${colors.accent}; }
  .sums .difference.zero span::after { content:' matches'; }
  .note, .hints p { font-size:13px; margin:4px 0; }
  .hints p { color:${colors.foreground}; border-left:2px solid ${colors.accent}; padding-left:8px; cursor:default; }
  .hints button { margin-left:8px; padding:1px 8px; font-size:12px; }
  .tools { display:flex; gap:10px; align-items:center; margin:12px 0 6px; flex-wrap:wrap; }
  .tools input[type=search] { flex:1; min-width:180px; }
  .pending { color:${colors.dim}; font-size:12px; }
  button { font:inherit; color:${colors.foreground}; background:${soft}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 12px; cursor:pointer; }
  button.primary { background:${colors.accent}; color:${colors.background}; border-color:${colors.accent}; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  /* The edit control sits beside the description rather than in a column of its own. A whole
     column for one small mark cost width on every row, and on a narrow window that width is
     what pushed the difference off the screen. Quiet until it is wanted. */
  button.edit { background:none; border:none; padding:0; color:${colors.dim};
    cursor:pointer; vertical-align:-2px; line-height:0; }
  button.edit:hover, button.edit:focus-visible { color:${colors.foreground}; }
  button.edit svg { display:block; }
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
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.tick { width:24px; text-align:center; }
  /* A date on two lines costs a row twice the height and reads worse. */
  td.date, th.date { white-space:nowrap; width:1%; }
  /* An optional column of boxes should not outshine the postings themselves: it is a line
     until it is used, and only the row under the pointer or the cursor shows it. */
  td.expect input { width:110px; text-align:right; padding:2px 6px; font-variant-numeric:tabular-nums;
    background:none; border-color:transparent; }
  tr:hover td.expect input, td.expect input:hover, td.expect input:focus { background:${softer}; border-color:${colors.dim}66; }
  td.delta.off { color:${colors.accent}; font-weight:600; }
  td.delta.ok { color:${colors.dim}; }
  tr { cursor:pointer; }
  tr.on td { background:${softer}; }
  tr.on td.tick { color:${colors.accent}; }
  tr.hinted td { box-shadow:inset 0 0 0 9999px ${mix(colors.background, colors.accent, 14)}; }
  tr.first td { box-shadow:inset 3px 0 0 ${colors.accent}; }
  tr.later td { opacity:.45; }
  tr.editor td { background:${softer}; cursor:default; }
  /* Where a dragged row would land, and which day it would take. */
  tr.drop td { box-shadow:inset 0 3px 0 ${colors.accent}; }
  tr[draggable="true"] { cursor:grab; }
  .editing textarea { display:block; width:100%; box-sizing:border-box; font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;
    color:${colors.foreground}; background:${colors.background}; border:1px solid ${colors.dim}66; border-radius:4px; padding:6px 8px; resize:vertical; tab-size:4; }
  .editing .buttons { display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap; }
  .editing .reading { color:${colors.foreground}; font-size:12px; margin:6px 0 0; }
  .against { color:${colors.dim}; }
  .badge { color:${colors.accent}; font-size:11px; margin-left:4px; }
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
  .readonly { color:${colors.dim}; }
</style></head>
<body><main>
  <h1>reconcile ${escape(data.account)}</h1>
  <p class="sub" id="sub"></p>
  <div class="statement">
    <label>Statement date<input type="date" id="date" value="${escape(statementDate || '')}"></label>
    <label>Statement closing balance<input type="text" id="balance" inputmode="decimal" placeholder="as the statement says it" value="${escape(statementBalance || '')}" autocomplete="off"></label>
  </div>
  <div class="sums" id="sums"></div>
  <p id="next"></p>
  <div id="notes"></div>
  <div class="hints" id="hints"></div>
  <div class="tools">
    <input type="search" id="search" placeholder="search descriptions, accounts or amounts (/)" aria-label="search">
    <button id="add" title="n">Add a posting</button>
    <button id="all" title="a">Tick all shown</button>
    <span class="pending" id="pending"></span>
    <button id="progress"${writable ? '' : ' disabled title="this file did not come from an opened folder"'}>Save</button>
    <button id="finish" class="primary" disabled>Finish</button>
  </div>
  <div id="status" role="status"></div>
  <div id="preview" class="preview" hidden></div>
  <datalist id="accounts">${accounts.map((name) => `<option value="${escape(name)}">`).join('')}</datalist>
  <div class="table"><table><thead><tr><th class="tick" aria-label="cleared" title="a ticked line is cleared: Save writes the mark"></th><th class="date">Date</th><th>Description</th><th class="n">Amount</th><th class="n">Balance</th><th class="n" title="the balance your statement shows after this line, if you want to check it line by line">Statement balance</th><th class="n">Difference</th></tr></thead><tbody id="rows"></tbody></table></div>
  <p class="keys">↑ ↓ or j k move · Space ticks · e edits · n adds a posting · a ticks all shown · Alt+↑↓ moves to the next day · / searches</p>
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
  return { id: null, from: first.id, amount: first.difference, date: row.date, text: `The statement and the journal part at ${row.date} ${row.description}, by ${say(first.difference)}, since the last line that matched. If the statement has a line the journal does not, add it.` };
}

/** Draw the window and wire it to the plugin. */
export function mount(root = document) {
  const state = JSON.parse(root.getElementById('reconcile-data').textContent);
  const $ = (id) => root.getElementById(id);
  const ticked = new Set(state.data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
  let edits = {};
  let inserts = [];
  let expected = {};
  // Rows whose transaction was moved, and the date it was moved to. Nothing is written until
  // Save or Finish, like every other change the window makes.
  let moved = {};
  let editing = null;
  // A posting added to explain a typed balance takes that balance over: the statement's line
  // it stood for is the new posting's.
  let from = null;
  // A new posting's text before it is kept, when it was started with an amount.
  let drafting = null;
  let made = 0;
  let focus = 0;
  let shown = [];
  let pending = null;
  const style = () => state.data.style;
  const money = (minor) => readable(minor, style());

  const bridge = () => {
    const bridges = window.opener && window.opener.__reconcileBridges;
    return bridges && bridges[state.token];
  };
  const statement = () => ({ date: $('date').value || null, balance: parseInput($('balance').value, style()) });
  const rows = () => ordered(state.data, { edits, inserts, moved });
  const sums = () => summarize({ data: state.data, ticked, statementDate: statement().date, statementBalance: statement().balance, edits, inserts, moved });

  function say(message, error = false) {
    $('status').textContent = message || '';
    $('status').className = error ? 'error' : '';
  }

  function drawSums() {
    const now = sums();
    const { balance } = statement();
    const cell = (name, value, extra = '', hint = '') => `<div class="${extra}"${hint ? ` title="${escape(hint)}"` : ''}><span>${name}</span><b>${escape(value)}</b></div>`;
    $('sums').innerHTML = [
      cell('Opening', money(now.opening), '', 'the balance this account was last proven to have'),
      cell(`Cleared (${now.tickedCount})`, money(now.tickedTotal), '', 'the lines ticked as cleared, added up; Save writes the cleared mark on each'),
      cell('Journal', money(now.expected), '', 'opening plus the ticked postings: what the journal says you have'),
      cell('Statement', balance == null ? 'type it above' : money(balance), '', 'the closing balance you typed'),
      cell('Difference', now.difference == null ? '-' : money(now.difference), `difference${now.difference === 0 ? ' zero' : ''}`, 'statement less journal: zero when they agree'),
    ].join('');
    const notes = [];
    // Why the list starts where it does, and how much of it is already done. Without this a
    // journal whose balance was last asserted months ago opens on months of finished work
    // and looks stuck there.
    const done = (() => {
      const cleared = rows().filter((row) => row.status === 'Cleared');
      return cleared.length ? { count: cleared.length, last: cleared[cleared.length - 1].date } : null;
    })();
    if (done && state.data.start) {
      notes.push(`The list starts at ${state.data.start.date}, where this account's balance was last asserted. ${done.count} posting${done.count === 1 ? '' : 's'} up to ${done.last} ${done.count === 1 ? 'is' : 'are'} already cleared and ticked. Finish writes a new assertion, so the next reconcile starts where this one ended.`);
    } else if (done) {
      notes.push(`${done.count} posting${done.count === 1 ? ' is' : 's are'} already cleared and ticked, up to ${done.last}.`);
    }
    if (now.tooEarly) notes.push(`The statement date is before ${state.data.start.date}, where this account's balance is already asserted.`);
    if (now.difference === 0 && now.outstanding.length) {
      notes.push(`${now.outstanding.length} posting${now.outstanding.length === 1 ? ' is' : 's are'} dated on or before the statement but not ticked. A balance assertion counts every posting up to its date, so tick ${now.outstanding.length === 1 ? 'it' : 'them'}, set the statement date earlier, or give ${now.outstanding.length === 1 ? 'it' : 'them'} the date the bank shows.`);
    }
    if (now.later) notes.push(`${now.later} later posting${now.later === 1 ? '' : 's'}, after the statement date, ${now.later === 1 ? 'is' : 'are'} shown faded and not counted.`);
    if (now.unknown) notes.push(`${now.unknown} edited transaction${now.unknown === 1 ? '' : 's'} cannot be read here, so the balances after ${now.unknown === 1 ? 'it' : 'them'} show ? until Save, when hledger reads ${now.unknown === 1 ? 'it' : 'them'}.`);
    const restores = Object.entries(edits).filter(([, edit]) => !edit.text.trim()).map(([id]) => {
      const row = state.data.rows.find((entry) => entry.id === id);
      return `<p class="note">Deleted: ${escape(row.date)} ${escape(row.description)} ${escape(money(row.amount))} <button class="icon" data-restore="${escape(id)}">restore</button></p>`;
    });
    $('notes').innerHTML = notes.map((text) => `<p class="note">${escape(text)}</p>`).join('') + restores.join('');

    // Hints: the statement total's, then the running totals'.
    const all = rows();
    const date = $('date').value;
    const found = now.difference ? hints(all.filter((row) => !date || row.date <= date), ticked, now.difference, style()) : [];
    const points = checkpoints(all, expected);
    const part = partHint(all, points, style());
    const lines = found.slice(0, 5).map((hint) => {
      const row = hint.id && all.find((entry) => entry.id === hint.id);
      return `<p${hint.id ? ` data-id="${escape(hint.id)}"` : ''}>${row ? `${escape(row.date)} ${escape(row.description)} ${escape(money(row.amount))}: ` : ''}${escape(hint.reason)}</p>`;
    });
    if (part) {
      lines.unshift(`<p${part.id ? ` data-id="${escape(part.id)}"` : ''}>${escape(part.text)}${part.id ? '' : `<button data-add="${part.amount}" data-date="${escape(part.date)}" data-from="${escape(part.from)}">Add ${escape(money(part.amount))}</button>`}</p>`);
    }
    $('hints').innerHTML = lines.join('');
    const lit = new Set([...found.map((hint) => hint.id), part && part.id].filter(Boolean));
    for (const tr of $('rows').children) {
      tr.classList.toggle('hinted', lit.has(tr.dataset.id));
      tr.classList.toggle('first', Boolean(points.first && points.first.id === tr.dataset.id));
    }

    const changes = describe();
    $('pending').textContent = changes;
    const writable = state.files.some((file) => file.writable);
    $('progress').disabled = !writable || !changes;
    $('finish').disabled = !now.canFinish;
    $('finish').textContent = writable ? 'Finish' : 'Finish (copy the assertion)';
    $('finish').title = now.canFinish ? 'mark the ticked postings and assert the statement balance' : 'at a difference of zero, with every posting up to the date ticked';
    $('next').innerHTML = nextStep(now, balance, writable);
  }

  /**
   * The one line that says what to do now. A window of numbers and empty boxes says nothing to
   * someone opening it for the first time, and the state it is in is exactly what decides the
   * next move, so it is written from that rather than left as a fixed paragraph.
   */
  function nextStep(now, balance, writable) {
    const readOnly = writable ? '' : ` <span class="readonly">The journal is read-only, so nothing can be written: run <b>open</b> in the terminal to edit it.</span>`;
    if (now.tooEarly) return 'Set the statement date after the balance already asserted below.';
    if (balance == null) return `Type the closing balance your statement shows, then tick the lines the statement has.${readOnly}`;
    if (now.difference == null) return `Tick the lines your statement shows.${readOnly}`;
    if (now.difference !== 0) {
      return `Tick the lines your statement shows. <b>${escape(money(now.difference))}</b> still to account for${now.tickedCount ? '' : ', and nothing is ticked yet'}.${readOnly}`;
    }
    if (now.outstanding.length) return `The totals match, but ${now.outstanding.length} posting${now.outstanding.length === 1 ? ' is' : 's are'} dated on or before the statement and not ticked. See below.`;
    if (!writable) return 'The totals match. Finish shows the assertion to copy into the journal yourself.';
    return 'The totals match. <b>Finish</b> marks the ticked postings and writes the balance assertion.';
  }

  /** How many transactions a move would re-date. A transaction may have several rows here. */
  function movedCount() {
    return new Set(Object.keys(moved).map((id) => id.split(':')[0])).size;
  }

  /** What Save would write, in words: nothing to say when there is nothing to write. */
  function describe() {
    const marks = state.data.rows.filter((row) => (ticked.has(row.id) ? row.status !== 'Cleared' : row.status === 'Cleared')).length;
    const matched = checkpoints(rows(), expected).points.filter((point) => point.difference === 0).length;
    const deleted = Object.values(edits).filter((edit) => !edit.text.trim()).length;
    const changed = Object.keys(edits).length - deleted;
    const dates = movedCount();
    const parts = [
      marks && `${marks} to clear`,
      dates && `${dates} date${dates === 1 ? '' : 's'} changed`,
      changed && `${changed} edit${changed === 1 ? '' : 's'}`,
      deleted && `${deleted} deleted`,
      inserts.length && `${inserts.length} new`,
      matched && `${matched} balance${matched === 1 ? '' : 's'} to assert`,
    ].filter(Boolean);
    return parts.length ? `unsaved: ${parts.join(', ')}` : '';
  }

  function drawSub() {
    const data = state.data;
    const since = data.start ? `opening balance asserted on ${data.start.date}` : 'no balance asserted yet, so from the first posting';
    const others = data.others.length ? `; postings in ${data.others.join(', ')} are not part of this` : '';
    const files = state.files.map((file) => `${file.path}${file.writable ? '' : ' (read-only)'}`).join(', ');
    $('sub').textContent = `${data.rows.length} postings in ${data.commodity || 'its commodity'}, ${since}${others}. ${files}`;
  }

  function rowHtml(row, later, newDay = false) {
    const point = expected[row.id] != null && row.balance != null ? expected[row.id] - row.balance : null;
    const delta = point == null ? '' : point === 0 ? '✓' : money(point);
    const badge = row.inserted ? '<span class="badge">new</span>' : row.edited ? '<span class="badge">edited</span>' : '';
    const value = expected[row.id] != null ? money(expected[row.id]).replace(` ${style().commodity}`, '').replace(style().commodity, '') : '';
    return `<tr data-id="${escape(row.id)}" tabindex="-1" draggable="${readOnly() ? 'false' : 'true'}" class="${ticked.has(row.id) ? 'on' : ''}${later ? ' later' : ''}${newDay ? ' day' : ''}" aria-selected="${ticked.has(row.id)}">
<td class="tick">${ticked.has(row.id) ? '✓' : ''}</td><td class="date">${escape(row.date)}</td>
<td>${escape(row.description)}${badge}${row.status === 'Pending' ? ' <span class="muted">pending</span>' : ''}&nbsp;<button class="edit" data-edit="${escape(row.id)}" title="edit (e)" aria-label="edit">${PENCIL}</button><br><span class="against">${escape(row.against || '')}</span></td>
<td class="n">${row.amount == null ? '?' : escape(money(row.amount))}</td><td class="n">${row.balance == null ? '?' : escape(money(row.balance))}</td>
<td class="n expect"><input data-expect="${escape(row.id)}" inputmode="decimal" aria-label="statement balance after this line" value="${escape(value)}" placeholder="—"></td>
<td class="n delta ${point == null ? '' : point === 0 ? 'ok' : 'off'}">${escape(delta)}</td></tr>`;
  }

  /** What a transaction's text means for the account, said under the editor as it is typed. */
  function reading(text) {
    if (!text.trim()) return 'Empty: the transaction will be deleted.';
    const read = readTransaction(text, state.data.account, style(), state.data.inclusive);
    if (!read.header) return 'The first line needs a date: 2026-09-05 Description.';
    if (!read.touches) return `It does not post to ${state.data.account}, so it will leave this list.`;
    if (read.postings < 2) return 'It needs another posting: the account the money came from or went to.';
    if (read.off) return `It does not balance: its amounts add up to ${money(read.off)}. Leave one amount out and hledger works it out.`;
    if (read.amount == null) return `The amount for ${state.data.account} cannot be worked out here (a cost, another commodity, or more than one amount left out); hledger reads it on Save.`;
    return `${read.date}: ${money(read.amount)} to ${state.data.account}${read.against ? `, against ${read.against}` : ''}.`;
  }

  /** The text an editor starts from: the edit so far, the transaction as written, or a template. */
  function textOf(row) {
    if (edits[row.id]) return edits[row.id].text;
    const insert = inserts.find((entry) => entry.id === row.id);
    if (insert) return insert.text;
    if (row.inserted) return row.text;
    return row.text;
  }

  /** An editor in place of a row: the transaction's journal text, all of it. */
  function editorHtml(row) {
    const text = textOf(row);
    const readable = text != null;
    const height = Math.min(16, Math.max(4, (text || '').split('\n').length + 1));
    return `<tr class="editor" data-editor="${escape(row.id)}"><td></td><td colspan="6"><div class="editing">
<textarea name="text" rows="${height}" spellcheck="false" aria-label="the transaction, as journal text"${readable ? '' : ' disabled'}>${escape(text || '')}</textarea>
<p class="reading" id="reading">${escape(readable ? reading(text) : 'Its file cannot be read here, so it cannot be edited; use edit in the terminal.')}</p>
<div class="buttons"><button class="primary" data-keep="${escape(row.id)}"${readable ? '' : ' disabled'}>Keep</button>
${row.inserted ? `<button data-drop="${escape(row.id)}">Remove</button>` : (edits[row.id] ? `<button data-undo="${escape(row.id)}">Undo the edit</button>` : '')}
<button data-close="1">Cancel</button>
<span class="muted">Ctrl+Enter keeps it. ${row.inserted ? '' : 'Empty it to delete the transaction. '}Nothing is written until Save or Finish, which show it first.</span></div>
</div></td></tr>`;
  }

  function drawRows() {
    const date = $('date').value;
    shown = matching(rows(), $('search').value, style());
    const html = [];
    if (editing && editing.startsWith('new:') && !inserts.some((insert) => insert.id === editing)) {
      html.push(editorHtml({ id: editing, inserted: true, text: drafting || template(statement().date || state.statementDate, state.data.account, null, style()) }));
    }
    // A day boundary gets a heavier rule than the hairline between postings, so the eye can
    // find where one day's postings end. It is decided here, where the order is known, rather
    // than guessed at in CSS.
    let previous = null;
    for (const row of shown) {
      html.push(rowHtml(row, date && row.date > date, previous !== null && row.date !== previous));
      previous = row.date;
      if (editing === row.id) html.push(editorHtml(row));
    }
    $('rows').innerHTML = html.join('');
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    drawSums();
    const field = $('rows').querySelector('tr.editor textarea:not([disabled])');
    if (field && editing) {
      field.focus();
      // A new posting's cursor goes where its description is to be written.
      if (editing.startsWith('new:') && !inserts.some((insert) => insert.id === editing)) field.setSelectionRange(11, 11);
    }
  }

  function toggle(id) {
    const row = rows().find((entry) => entry.id === id);
    const date = $('date').value;
    if (!row || (date && row.date > date)) return;
    if (ticked.has(id)) ticked.delete(id); else ticked.add(id);
    const tr = [...$('rows').children].find((element) => element.dataset.id === id);
    if (tr) {
      tr.classList.toggle('on', ticked.has(id));
      tr.setAttribute('aria-selected', String(ticked.has(id)));
      tr.firstElementChild.textContent = ticked.has(id) ? '✓' : '';
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
    if (text.trim() && !read.header) { say('The first line needs a date: 2026-09-05 Description.', true); return; }
    if (isNew && !text.trim()) { say('There is nothing to add. Remove it instead.', true); return; }
    if (isNew && !read.touches) { say(`It does not post to ${state.data.account}, so it does not belong here.`, true); return; }
    if (text.trim() && read.postings < 2) { say('It needs another posting: the account the money came from or went to.', true); return; }
    if (text.trim() && read.off) { say(`It does not balance: its amounts add up to ${money(read.off)}.`, true); return; }
    if (isNew) {
      const fresh = { id, text };
      // Added to explain where the statement and journal part, it goes beside that posting.
      if (from && from.id === id && rows().some((row) => row.id === from.row && row.date === read.date)) fresh.after = from.row;
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

  /** Whether the files behind this window can be written at all. */
  const readOnly = () => !state.files.some((file) => file.writable);

  /**
   * Move a transaction to `date`, which is what a drag or Alt+arrow does.
   *
   * Moving changes the transaction's date, not its position in the file: the list is ordered by
   * date, so the row appears in its new place, and nothing else about the journal changes. The
   * change is pending like an edit, so it is shown in the preview before anything is written.
   */
  function moveTo(id, date) {
    const row = rows().find((entry) => entry.id === id);
    if (!row || !date || row.date === date) return;
    if (readOnly()) { say('The journal is read-only, so nothing can be written: run open in the terminal to edit it.', true); return; }
    const refused = moveRefusal(state.data, date);
    if (refused) { say(`Cannot move it to ${date}: it is ${refused}.`, true); return; }
    if (id.startsWith('new:')) { say('A new posting takes its date from its text. Edit it to change the date.', true); return; }
    // Every row of the transaction moves with it, so one transaction cannot end up on two dates.
    // Moved back to the day it was written on, it is not a change at all.
    const transaction = id.split(':')[0];
    for (const entry of state.data.rows) {
      if (entry.id.split(':')[0] !== transaction) continue;
      if (entry.date === date) delete moved[entry.id];
      else moved[entry.id] = date;
    }
    say(`Moved ${row.description} to ${date}. Finish asserts from there; Save writes the date.`);
    hidePreview();
    drawRows();
  }

  function hidePreview() {
    pending = null;
    $('preview').hidden = true;
    $('preview').innerHTML = '';
  }

  /** Ask the plugin what would be written, and show it, with a button to write it. */
  async function preview(finish) {
    const link = bridge();
    if (!link) { say('This window has lost touch with the app. Run reconcile again.', true); return; }
    const { date, balance } = statement();
    const request = { ticked: [...ticked], finish: finish ? { date, balance } : null, edits, inserts, expected, moved, fingerprint: state.fingerprint };
    const result = await link.preview(request);
    const writable = result.writable.some((file) => file.writable);
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
      for (const entry of inserted) lines.push(`<pre class="add">${escape(`after line ${entry.line}:\n${entry.text}`)}</pre>`);
      for (const entry of file.replaced || []) {
        lines.push(`<pre><span class="del">${escape(entry.before.split('\n').map((line, at) => `${String(entry.line + at).padStart(6)}  ${line}`).join('\n'))}</span>\n<span class="add">${escape(entry.after ? entry.after.split('\n').map((line) => `        ${line}`).join('\n') : '        (deleted)')}</span></pre>`);
      }
      const changes = file.changes.slice(0, 40).map((change) => `<span class="del">${escape(String(change.line).padStart(6))}  ${escape(change.before)}</span>\n<span class="add">${escape(String(change.line).padStart(6))}  ${escape(change.after)}</span>`);
      if (file.changes.length > 40) changes.push(`… and ${file.changes.length - 40} more`);
      if (changes.length) lines.push(`<pre>${changes.join('\n')}</pre>`);
      if (file.appended) lines.push(`<pre class="add" id="assertion">${escape(file.appended)}</pre>`);
    }
    if (!result.files.length && !result.missing.length) lines.push('<p>Nothing to write.</p>');
    // One line per reason: two hundred postings in a file that cannot be read are one problem.
    const reasons = [...new Set(result.missing.map((entry) => entry.why))];
    if (reasons.length) lines.push(`<p>${escape(reasons.join('; '))}.</p>`);
    if (finish && !result.files.some((file) => file.appended) && result.assertion) {
      lines.push(`<p>The assertion to add at the end of the journal:</p><pre class="add" id="assertion">${escape(result.assertion)}</pre>`);
    }
    const canWrite = writable && result.files.length && !result.missing.length;
    lines.push(`<div class="tools">${canWrite ? `<button class="primary" id="apply">Write ${finish ? 'and check' : 'it'}</button>` : ''}${!writable && finish ? '<button id="copy">Copy the assertion</button>' : ''}<button id="cancel">Cancel</button></div>`);
    if (!writable) lines.push('<p class="note">This file did not come from an opened folder, so nothing can be written here. Run open in the terminal to edit it, or copy the assertion into the file yourself.</p>');
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

  async function write() {
    const link = bridge();
    if (!link || !pending) return;
    say('Writing, then checking with hledger…');
    const answer = await link.apply(pending);
    if (answer.data) {
      state.data = answer.data;
      state.fingerprint = answer.fingerprint || state.fingerprint;
      ticked.clear();
      for (const row of state.data.rows) if (row.status === 'Cleared') ticked.add(row.id);
      if (answer.ok) {
        // Written: the edits and new postings are the journal now. Typed balances that were not
        // written, because they did not match, are kept where their posting still is.
        edits = {};
        inserts = [];
        moved = {};
        expected = Object.fromEntries(Object.entries(expected).filter(([id]) => state.data.rows.some((row) => row.id === id)));
      }
    }
    hidePreview();
    drawSub();
    drawRows();
    say(answer.ok ? `${answer.message}.` : answer.error, !answer.ok);
  }

  function startAdding(amount = null, date = null, row = null) {
    made += 1;
    editing = `new:${made}`;
    from = row ? { id: editing, row } : null;
    drafting = template(date || statement().date || state.statementDate, state.data.account, amount, style());
    drawRows();
  }

  let dragging = null;
  $('rows').addEventListener('dragstart', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr || readOnly() || tr.dataset.id.startsWith('new:')) { event.preventDefault(); return; }
    dragging = tr.dataset.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tr.dataset.id);
  });
  $('rows').addEventListener('dragover', (event) => {
    if (!dragging) return;
    const tr = event.target.closest('tr[data-id]');
    if (!tr) return;
    event.preventDefault();
    const row = shown.find((entry) => entry.id === tr.dataset.id);
    const from = shown.find((entry) => entry.id === dragging);
    const refused = row ? moveRefusal(state.data, row.date) : null;
    // The cursor says no on a target that will not take it, and the line under the table says why.
    event.dataTransfer.dropEffect = refused ? 'none' : 'move';
    for (const other of $('rows').children) other.classList.toggle('drop', other === tr && !refused);
    if (row && refused) {
      say(`cannot move to ${row.date}: it is ${refused}`, true);
    } else if (row && from && row.date !== from.date) {
      say(`move to ${row.date}`);
    } else if (row) {
      say(`${row.date}, the date it already has`);
    }
  });
  $('rows').addEventListener('dragleave', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (tr) tr.classList.remove('drop');
  });
  $('rows').addEventListener('drop', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr || !dragging) return;
    event.preventDefault();
    const target = shown.find((entry) => entry.id === tr.dataset.id);
    const id = dragging;
    dragging = null;
    for (const other of $('rows').children) other.classList.remove('drop');
    if (target) moveTo(id, target.date);
  });
  $('rows').addEventListener('dragend', () => {
    dragging = null;
    for (const other of $('rows').children) other.classList.remove('drop');
    if (!$('status').textContent.startsWith('Moved')) say('');
  });

  $('rows').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) {
      if (button.dataset.edit) { editing = button.dataset.edit; drawRows(); }
      else if (button.dataset.keep) keep(button.dataset.keep);
      else if (button.dataset.restore) { delete edits[button.dataset.restore]; drawRows(); }
      else if (button.dataset.drop) { inserts = inserts.filter((insert) => insert.id !== button.dataset.drop); ticked.delete(button.dataset.drop); delete expected[button.dataset.drop]; editing = null; drawRows(); }
      else if (button.dataset.undo) { delete edits[button.dataset.undo]; editing = null; drawRows(); }
      else if (button.dataset.close) { editing = null; drafting = null; drawRows(); }
      return;
    }
    if (event.target.closest('input') || event.target.closest('tr.editor')) return;
    const tr = event.target.closest('tr[data-id]');
    if (tr) toggle(tr.dataset.id);
  });
  $('rows').addEventListener('input', (event) => {
    if (event.target.tagName === 'TEXTAREA') {
      $('reading').textContent = reading(event.target.value);
      return;
    }
    const id = event.target.dataset.expect;
    if (!id) return;
    const value = parseInput(event.target.value, style());
    if (value == null) delete expected[id]; else expected[id] = value;
    const row = rows().find((entry) => entry.id === id);
    const cell = event.target.closest('tr').querySelector('td.delta');
    const point = value == null || !row ? null : value - row.balance;
    cell.textContent = point == null ? '' : point === 0 ? '✓' : money(point);
    cell.className = `n delta ${point == null ? '' : point === 0 ? 'ok' : 'off'}`;
    hidePreview();
    drawSums();
  });
  $('rows').addEventListener('keydown', (event) => {
    // In the text, Enter is a new line; Ctrl+Enter (or Cmd+Enter) keeps it.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target.closest('tr.editor')) { event.preventDefault(); keep(event.target.closest('tr.editor').dataset.editor); }
  });
  $('notes').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-restore]');
    if (button) { delete edits[button.dataset.restore]; hidePreview(); drawRows(); }
  });
  $('hints').addEventListener('click', (event) => {
    const add = event.target.closest('button[data-add]');
    if (add) { startAdding(Number(add.dataset.add), add.dataset.date, add.dataset.from); return; }
    const p = event.target.closest('p[data-id]');
    if (!p) return;
    const index = shown.findIndex((row) => row.id === p.dataset.id);
    if (index >= 0) moveFocus(index);
  });
  for (const id of ['date', 'balance']) $(id).addEventListener('input', () => { hidePreview(); id === 'date' ? drawRows() : drawSums(); });
  $('search').addEventListener('input', drawRows);
  $('add').addEventListener('click', () => startAdding());
  $('all').addEventListener('click', () => {
    const date = $('date').value;
    for (const row of shown) if (!date || row.date <= date) ticked.add(row.id);
    hidePreview();
    drawRows();
  });
  $('progress').addEventListener('click', () => preview(false));
  $('finish').addEventListener('click', () => preview(true));

  root.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(event.target.tagName);
    if (event.key === 'Escape') {
      if (editing) { editing = null; drafting = null; drawRows(); return; }
      if (event.target === $('search')) { $('search').value = ''; drawRows(); return; }
    }
    if (typing) return;
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    // Alt with an arrow moves the transaction to the next day that has postings, which is the
    // keyboard's version of dropping it on a row. It changes the date, as a drag does. It comes
    // before the plain arrows below, which take the same keys for moving the focus.
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
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); moveFocus(focus + 1); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); moveFocus(focus - 1); }
    else if (event.key === ' ' && trs[focus] && event.target.tagName !== 'BUTTON') { event.preventDefault(); toggle(trs[focus].dataset.id); }
    else if (event.key === 'e' && trs[focus]) { event.preventDefault(); editing = trs[focus].dataset.id; drawRows(); }
    else if (event.key === 'n') { event.preventDefault(); startAdding(); }
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
  // Open where the work is. A journal last asserted months ago lists months of postings that
  // are already cleared and ticked, and starting at the top of those makes the window look as
  // though nothing has been done. The rows stay, because the running balances need them, but
  // the view starts at the first one still to do.
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
