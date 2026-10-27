/**
 * The reconcile window: the statement, the account's postings, and the difference.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window; the window
 * imports `mount` to draw it. It reads and writes nothing itself: a preview and an apply go
 * back through the bridge to the plugin, which is the side that can reach the files.
 *
 * Each posting shows the account's balance after it, the way a statement prints one beside each
 * line, and takes the statement's figure for it: the difference shows there, and the first line
 * where it is not zero is where the statement and the journal part. A posting can be edited
 * (date, description, and in a simple transaction its amount and other account) and a missing
 * one added; nothing is written until Save or Finish, which preview it first.
 *
 * Keys: ↑ ↓ or j k move, Space ticks, e edits, n adds a posting, a ticks every posting shown,
 * / searches, Escape clears the search or closes an editor.
 */

import { checkpoints, hints, ordered, parseInput, readable, summarize } from './reconcile-data.js';
import { escape, isLight, mix } from './window-kit.js';

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
  .sums { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:1px; background:${colors.dim}44; border-radius:6px; overflow:hidden; margin:0 0 10px; }
  .sums div { background:${colors.background}; padding:8px 10px; }
  .sums span { display:block; font-size:11px; color:${colors.dim}; text-transform:uppercase; letter-spacing:.04em; }
  .sums b { font-variant-numeric:tabular-nums; font-weight:600; }
  .sums .difference b { font-size:20px; }
  .sums .difference.zero b { color:${colors.accent}; }
  .note, .hints p { font-size:13px; margin:4px 0; }
  .hints p { color:${colors.foreground}; border-left:2px solid ${colors.accent}; padding-left:8px; cursor:default; }
  .hints button { margin-left:8px; padding:1px 8px; font-size:12px; }
  .tools { display:flex; gap:10px; align-items:center; margin:12px 0 6px; flex-wrap:wrap; }
  .tools input[type=search] { flex:1; min-width:180px; }
  .pending { color:${colors.dim}; font-size:12px; }
  button { font:inherit; color:${colors.foreground}; background:${soft}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 12px; cursor:pointer; }
  button.primary { background:${colors.accent}; color:${colors.background}; border-color:${colors.accent}; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.icon { background:none; border:none; padding:0 4px; color:${colors.dim}; }
  button.icon:hover { color:${colors.foreground}; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:${colors.dim}; font-weight:400; border-bottom:1px solid ${colors.dim}55; padding:4px 6px; position:sticky; top:0; background:${colors.background}; z-index:1; }
  td { padding:4px 6px; border-bottom:1px solid ${colors.dim}22; vertical-align:top; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.tick { width:24px; text-align:center; }
  td.expect input { width:120px; text-align:right; padding:2px 6px; font-variant-numeric:tabular-nums; }
  td.delta.off { color:${colors.accent}; font-weight:600; }
  td.delta.ok { color:${colors.dim}; }
  tr { cursor:pointer; }
  tr.on td { background:${softer}; }
  tr.on td.tick { color:${colors.accent}; }
  tr.hinted td { box-shadow:inset 0 0 0 9999px ${mix(colors.background, colors.accent, 14)}; }
  tr.first td { box-shadow:inset 3px 0 0 ${colors.accent}; }
  tr.later td { opacity:.45; }
  tr.editor td { background:${softer}; cursor:default; }
  tr.editor input { padding:3px 6px; }
  .editing { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
  .editing input[name=description] { min-width:220px; flex:1; }
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
</style></head>
<body><main>
  <h1>reconcile ${escape(data.account)}</h1>
  <p class="sub" id="sub"></p>
  <div class="statement">
    <label>Statement date<input type="date" id="date" value="${escape(statementDate || '')}"></label>
    <label>Statement closing balance<input type="text" id="balance" inputmode="decimal" placeholder="as the statement says it" value="${escape(statementBalance || '')}" autocomplete="off"></label>
  </div>
  <div class="sums" id="sums"></div>
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
  <table><thead><tr><th class="tick" aria-label="ticked"></th><th>Date</th><th>Description</th><th class="n">Amount</th><th class="n">Balance</th><th class="n">Statement balance</th><th class="n">Difference</th><th aria-label="edit"></th></tr></thead><tbody id="rows"></tbody></table>
  <p class="keys">↑ ↓ or j k move · Space ticks · e edits · n adds a posting · a ticks every posting shown · / searches · Esc closes</p>
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
  let editing = null;
  // A posting added to explain a typed balance takes that balance over: the statement's line
  // it stood for is the new posting's.
  let from = null;
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
  const rows = () => ordered(state.data, { edits, inserts });
  const sums = () => summarize({ data: state.data, ticked, statementDate: statement().date, statementBalance: statement().balance, edits, inserts });

  function say(message, error = false) {
    $('status').textContent = message || '';
    $('status').className = error ? 'error' : '';
  }

  function drawSums() {
    const now = sums();
    const { balance } = statement();
    const cell = (name, value, extra = '') => `<div class="${extra}"><span>${name}</span><b>${escape(value)}</b></div>`;
    $('sums').innerHTML = [
      cell('Opening', money(now.opening)),
      cell(`Ticked (${now.tickedCount})`, money(now.tickedTotal)),
      cell('Expected', money(now.expected)),
      cell('Statement', balance == null ? 'type it above' : money(balance)),
      cell('Difference', now.difference == null ? '-' : money(now.difference), `difference${now.difference === 0 ? ' zero' : ''}`),
    ].join('');
    const notes = [];
    if (now.tooEarly) notes.push(`The statement date is before ${state.data.start.date}, where this account's balance is already asserted.`);
    if (now.difference === 0 && now.outstanding.length) {
      notes.push(`${now.outstanding.length} posting${now.outstanding.length === 1 ? ' is' : 's are'} dated on or before the statement but not ticked. A balance assertion counts every posting up to its date, so tick ${now.outstanding.length === 1 ? 'it' : 'them'}, set the statement date earlier, or give ${now.outstanding.length === 1 ? 'it' : 'them'} the date the bank shows.`);
    }
    if (now.later) notes.push(`${now.later} later posting${now.later === 1 ? '' : 's'}, after the statement date, ${now.later === 1 ? 'is' : 'are'} shown faded and not counted.`);
    $('notes').innerHTML = notes.map((text) => `<p class="note">${escape(text)}</p>`).join('');

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
  }

  /** What Save would write, in words: nothing to say when there is nothing to write. */
  function describe() {
    const marks = state.data.rows.filter((row) => (ticked.has(row.id) ? row.status !== 'Cleared' : row.status === 'Cleared')).length;
    const matched = checkpoints(rows(), expected).points.filter((point) => point.difference === 0).length;
    const parts = [
      marks && `${marks} mark${marks === 1 ? '' : 's'}`,
      Object.keys(edits).length && `${Object.keys(edits).length} edit${Object.keys(edits).length === 1 ? '' : 's'}`,
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

  function rowHtml(row, later) {
    const point = expected[row.id] != null ? expected[row.id] - row.balance : null;
    const delta = point == null ? '' : point === 0 ? '✓' : money(point);
    const badge = row.inserted ? '<span class="badge">new</span>' : row.edited ? '<span class="badge">edited</span>' : '';
    const value = expected[row.id] != null ? money(expected[row.id]).replace(` ${style().commodity}`, '').replace(style().commodity, '') : '';
    return `<tr data-id="${escape(row.id)}" tabindex="-1" class="${ticked.has(row.id) ? 'on' : ''}${later ? ' later' : ''}" aria-selected="${ticked.has(row.id)}">
<td class="tick">${ticked.has(row.id) ? '✓' : ''}</td><td>${escape(row.date)}</td>
<td>${escape(row.description)}${badge}${row.status === 'Pending' ? ' <span class="muted">pending</span>' : ''}<br><span class="against">${escape(row.against || '')}</span></td>
<td class="n">${escape(money(row.amount))}</td><td class="n">${escape(money(row.balance))}</td>
<td class="n expect"><input data-expect="${escape(row.id)}" inputmode="decimal" aria-label="statement balance after this line" value="${escape(value)}" placeholder="—"></td>
<td class="n delta ${point == null ? '' : point === 0 ? 'ok' : 'off'}">${escape(delta)}</td>
<td><button class="icon" data-edit="${escape(row.id)}" title="edit (e)" aria-label="edit">✎</button></td></tr>`;
  }

  /** An editor in place of a row: date, description, and for a simple transaction amount and other account. */
  function editorHtml(row) {
    const simple = row.simple && !row.generated;
    const why = simple ? '' : ' title="in a transaction of more than two postings, or of several commodities, only the date and description can be changed here; use edit for the rest"';
    const amount = row.amount == null ? '' : money(row.amount).replace(` ${style().commodity}`, '').replace(style().commodity, '');
    return `<tr class="editor" data-editor="${escape(row.id)}"><td></td><td colspan="7"><div class="editing">
<label>Date<input type="date" name="date" value="${escape(row.date || '')}"${row.ownDate ? ' disabled title="this posting has a date of its own"' : ''}></label>
<label>Description<input name="description" value="${escape(row.description || '')}"></label>
<label>Amount, to ${escape(state.data.account)}<input name="amount" inputmode="decimal" value="${escape(amount)}"${simple ? '' : ` disabled${why}`}></label>
<label>Other account<input name="other" list="accounts" value="${escape(row.other || row.against || '')}"${simple ? '' : ` disabled${why}`}></label>
<button class="primary" data-keep="${escape(row.id)}">${row.inserted ? 'Keep' : 'Keep the edit'}</button>
${row.inserted ? `<button data-drop="${escape(row.id)}">Remove</button>` : (edits[row.id] ? `<button data-undo="${escape(row.id)}">Undo the edit</button>` : '')}
<button data-close="1">Cancel</button>
</div><p class="muted">Nothing is written until Save or Finish, which show it first.</p></td></tr>`;
  }

  function drawRows() {
    const date = $('date').value;
    shown = matching(rows(), $('search').value, style());
    const html = [];
    if (editing && editing.startsWith('new:') && !inserts.some((insert) => insert.id === editing)) {
      html.push(editorHtml({ id: editing, date: statement().date || state.statementDate, description: '', amount: null, simple: true, inserted: true, other: '' }));
    }
    for (const row of shown) {
      html.push(rowHtml(row, date && row.date > date));
      if (editing === row.id) html.push(editorHtml(row));
    }
    $('rows').innerHTML = html.join('');
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    drawSums();
    const field = $('rows').querySelector('tr.editor input:not([disabled])');
    if (field && editing) field.focus();
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
    const value = (name) => form.querySelector(`[name=${name}]`);
    const date = value('date').value;
    const description = value('description').value.trim();
    const amountField = value('amount');
    const amount = amountField.disabled ? null : parseInput(amountField.value, style());
    const other = value('other').disabled ? null : value('other').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { say('A date is needed.', true); return; }
    if (!description) { say('A description is needed.', true); return; }
    if (!amountField.disabled && (amount == null || amount === 0)) { say(`An amount is needed, positive when money comes into ${state.data.account}, negative when it goes out.`, true); return; }
    if (other !== null && !other) { say('The other account is needed: where the money came from or went.', true); return; }
    const insert = inserts.find((entry) => entry.id === id);
    if (id.startsWith('new:')) {
      const fresh = { id, date, description, amount, other };
      // Added to explain where the statement and journal part, it goes beside that posting.
      if (from && from.id === id && rows().some((row) => row.id === from.row && row.date === date)) fresh.after = from.row;
      if (insert) Object.assign(insert, fresh); else inserts.push(fresh);
      ticked.add(id);
      if (from && from.id === id && expected[from.row] != null) {
        expected[id] = expected[from.row];
        delete expected[from.row];
      }
      from = null;
    } else {
      const row = state.data.rows.find((entry) => entry.id === id);
      const edit = {};
      if (date !== row.date) edit.date = date;
      if (description !== row.description) edit.description = description;
      if (amount != null && amount !== row.amount) edit.amount = amount;
      if (other && other !== row.other) edit.other = other;
      if (Object.keys(edit).length) edits[id] = edit; else delete edits[id];
    }
    editing = null;
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
    const request = { ticked: [...ticked], finish: finish ? { date, balance } : null, edits, inserts, expected, fingerprint: state.fingerprint };
    const result = await link.preview(request);
    const writable = result.writable.some((file) => file.writable);
    const lines = [];
    for (const file of result.files) {
      const inserted = file.inserted || [];
      lines.push(`<p><b>${escape(file.path)}</b>${file.changes.length ? `: ${file.changes.length} line${file.changes.length === 1 ? '' : 's'} would change` : ''}${inserted.length ? `${file.changes.length ? ',' : ':'} ${inserted.length} transaction${inserted.length === 1 ? '' : 's'} added` : ''}${file.appended ? `${file.changes.length || inserted.length ? ', and' : ':'} at the end:` : ''}</p>`);
      for (const entry of inserted) lines.push(`<pre class="add">${escape(`after line ${entry.line}:\n${entry.text}`)}</pre>`);
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
    drawRows();
    const form = $('rows').querySelector('tr.editor');
    if (form && amount != null) form.querySelector('[name=amount]').value = money(amount).replace(` ${style().commodity}`, '').replace(style().commodity, '');
    if (form && date) form.querySelector('[name=date]').value = date;
  }

  $('rows').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) {
      if (button.dataset.edit) { editing = button.dataset.edit; drawRows(); }
      else if (button.dataset.keep) keep(button.dataset.keep);
      else if (button.dataset.drop) { inserts = inserts.filter((insert) => insert.id !== button.dataset.drop); ticked.delete(button.dataset.drop); delete expected[button.dataset.drop]; editing = null; drawRows(); }
      else if (button.dataset.undo) { delete edits[button.dataset.undo]; editing = null; drawRows(); }
      else if (button.dataset.close) { editing = null; drawRows(); }
      return;
    }
    if (event.target.closest('input') || event.target.closest('tr.editor')) return;
    const tr = event.target.closest('tr[data-id]');
    if (tr) toggle(tr.dataset.id);
  });
  $('rows').addEventListener('input', (event) => {
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
    if (event.key === 'Enter' && event.target.closest('tr.editor')) { event.preventDefault(); keep(event.target.closest('tr.editor').dataset.editor); }
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
      if (editing) { editing = null; drawRows(); return; }
      if (event.target === $('search')) { $('search').value = ''; drawRows(); return; }
    }
    if (typing) return;
    const trs = [...$('rows').children].filter((tr) => tr.dataset.id);
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); moveFocus(focus + 1); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); moveFocus(focus - 1); }
    else if (event.key === ' ' && trs[focus] && event.target.tagName !== 'BUTTON') { event.preventDefault(); toggle(trs[focus].dataset.id); }
    else if (event.key === 'e' && trs[focus]) { event.preventDefault(); editing = trs[focus].dataset.id; drawRows(); }
    else if (event.key === 'n') { event.preventDefault(); startAdding(); }
    else if (event.key === 'a' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); $('all').click(); }
    else if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  });

  drawSub();
  drawRows();
}
