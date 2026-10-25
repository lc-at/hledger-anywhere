/**
 * The reconcile window: the statement, the account's postings, and the difference.
 *
 * Shared by both sides of the plugin. The plugin imports `page` to write the window; the window
 * imports `mount` to draw it. It reads and writes nothing itself: a preview and an apply go
 * back through the bridge to the plugin, which is the side that can reach the files.
 *
 * Keys: ↑ ↓ or j k move, Space ticks, a ticks every posting shown, / searches, Escape clears it.
 */

import { hints, parseInput, readable, summarize } from './reconcile-data.js';
import { escape, isLight, mix } from './window-kit.js';

/** The whole document, with the data in a JSON block and the page to be mounted. */
export function page({ data, colors, token, files, statementDate, statementBalance, fingerprint, module }) {
  const payload = JSON.stringify({ data, colors, token, files, statementDate, statementBalance, fingerprint }).replace(/</g, '\\u003c');
  const writable = files.some((file) => file.writable);
  const soft = mix(colors.background, colors.dim, 14);
  const softer = mix(colors.background, colors.dim, 7);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hledger: reconcile ${escape(data.account)}</title>
<style>
  :root { color-scheme: ${isLight(colors.background) ? 'light' : 'dark'}; }
  body { margin:0; background:${colors.background}; color:${colors.foreground}; font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif; }
  main { max-width:1040px; margin:0 auto; padding:20px 24px 40px; }
  h1 { font-size:18px; font-weight:600; margin:0; }
  .sub { color:${colors.dim}; margin:2px 0 14px; font-size:13px; }
  .statement { display:flex; flex-wrap:wrap; gap:16px; align-items:end; margin:0 0 12px; }
  label { display:flex; flex-direction:column; gap:3px; font-size:12px; color:${colors.dim}; }
  input { font:inherit; color:${colors.foreground}; background:${softer}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 8px; }
  input:focus-visible, button:focus-visible, tr:focus-visible { outline:2px solid ${colors.accent}; outline-offset:1px; }
  .sums { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:1px; background:${colors.dim}44; border-radius:6px; overflow:hidden; margin:0 0 10px; }
  .sums div { background:${colors.background}; padding:8px 10px; }
  .sums span { display:block; font-size:11px; color:${colors.dim}; text-transform:uppercase; letter-spacing:.04em; }
  .sums b { font-variant-numeric:tabular-nums; font-weight:600; }
  .sums .difference b { font-size:20px; }
  .sums .difference.zero b { color:${colors.accent}; }
  .note, .hints p { font-size:13px; margin:4px 0; }
  .hints p { color:${colors.foreground}; border-left:2px solid ${colors.accent}; padding-left:8px; cursor:default; }
  .hints a { color:${colors.foreground}; }
  .tools { display:flex; gap:10px; align-items:center; margin:12px 0 6px; flex-wrap:wrap; }
  .tools input[type=search] { flex:1; min-width:180px; }
  button { font:inherit; color:${colors.foreground}; background:${soft}; border:1px solid ${colors.dim}66; border-radius:4px; padding:5px 12px; cursor:pointer; }
  button.primary { background:${colors.accent}; color:${colors.background}; border-color:${colors.accent}; font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:${colors.dim}; font-weight:400; border-bottom:1px solid ${colors.dim}55; padding:4px 6px; position:sticky; top:0; background:${colors.background}; }
  td { padding:4px 6px; border-bottom:1px solid ${colors.dim}22; vertical-align:top; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.tick { width:28px; text-align:center; }
  tr { cursor:pointer; }
  tr.on td { background:${softer}; }
  tr.on td.tick { color:${colors.accent}; }
  tr.hinted td { box-shadow:inset 0 0 0 9999px ${mix(colors.background, colors.accent, 14)}; }
  tr.later td { opacity:.45; cursor:default; }
  .against { color:${colors.dim}; }
  .pending { color:${colors.dim}; font-size:11px; }
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
    <button id="all" title="a">Tick all shown</button>
    <button id="progress"${writable ? '' : ' disabled title="this file did not come from an opened folder"'}>Save progress</button>
    <button id="finish" class="primary" disabled>Finish</button>
  </div>
  <div id="status" role="status"></div>
  <div id="preview" class="preview" hidden></div>
  <table><thead><tr><th class="tick" aria-label="ticked"></th><th>Date</th><th>Description</th><th class="n">Amount</th></tr></thead><tbody id="rows"></tbody></table>
  <p class="keys">↑ ↓ or j k move · Space ticks · a ticks every posting shown · / searches · Esc clears the search</p>
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

/** Draw the window and wire it to the plugin. */
export function mount(root = document) {
  const state = JSON.parse(root.getElementById('reconcile-data').textContent);
  const $ = (id) => root.getElementById(id);
  const ticked = new Set(state.data.rows.filter((row) => row.status === 'Cleared').map((row) => row.id));
  let focus = 0;
  let shown = [];
  let pending = null;

  const bridge = () => {
    const bridges = window.opener && window.opener.__reconcileBridges;
    return bridges && bridges[state.token];
  };

  function statement() {
    return { date: $('date').value || null, balance: parseInput($('balance').value, state.data.style) };
  }

  function sums() {
    const { date, balance } = statement();
    return summarize({ data: state.data, ticked, statementDate: date, statementBalance: balance });
  }

  function say(message, error = false) {
    $('status').textContent = message || '';
    $('status').className = error ? 'error' : '';
  }

  function drawSums() {
    const style = state.data.style;
    const now = sums();
    const { balance } = statement();
    const cell = (name, value, extra = '') => `<div class="${extra}"><span>${name}</span><b>${escape(value)}</b></div>`;
    $('sums').innerHTML = [
      cell('Opening', readable(now.opening, style)),
      cell(`Ticked (${now.tickedCount})`, readable(now.tickedTotal, style)),
      cell('Expected', readable(now.expected, style)),
      cell('Statement', balance == null ? 'type it above' : readable(balance, style)),
      cell('Difference', now.difference == null ? '-' : readable(now.difference, style), `difference${now.difference === 0 ? ' zero' : ''}`),
    ].join('');
    const notes = [];
    if (now.tooEarly) notes.push(`The statement date is before ${state.data.start.date}, where this account's balance is already asserted.`);
    if (now.difference === 0 && now.outstanding.length) {
      notes.push(`${now.outstanding.length} posting${now.outstanding.length === 1 ? ' is' : 's are'} dated on or before the statement but not ticked. A balance assertion counts every posting up to its date, so tick ${now.outstanding.length === 1 ? 'it' : 'them'}, set the statement date earlier, or give ${now.outstanding.length === 1 ? 'it' : 'them'} the date the bank shows.`);
    }
    if (now.later) notes.push(`${now.later} later posting${now.later === 1 ? '' : 's'}, after the statement date, ${now.later === 1 ? 'is' : 'are'} shown faded and not counted.`);
    $('notes').innerHTML = notes.map((text) => `<p class="note">${escape(text)}</p>`).join('');
    const found = now.difference ? hints(state.data.rows.filter((row) => !$('date').value || row.date <= $('date').value), ticked, now.difference, style) : [];
    $('hints').innerHTML = found.slice(0, 6).map((hint) => {
      const row = hint.id && state.data.rows.find((entry) => entry.id === hint.id);
      return `<p${hint.id ? ` data-id="${escape(hint.id)}"` : ''}>${row ? `${escape(row.date)} ${escape(row.description)} ${escape(readable(row.amount, style))}: ` : ''}${escape(hint.reason)}</p>`;
    }).join('');
    for (const tr of $('rows').children) tr.classList.toggle('hinted', found.some((hint) => hint.id === tr.dataset.id));
    const writable = state.files.some((file) => file.writable);
    $('finish').disabled = !now.canFinish;
    $('finish').textContent = writable ? 'Finish' : 'Finish (copy the assertion)';
    $('finish').title = now.canFinish ? 'mark the ticked postings and assert the statement balance' : 'at a difference of zero, with every posting up to the date ticked';
  }

  function drawSub() {
    const data = state.data;
    const since = data.start ? `opening balance asserted on ${data.start.date}` : 'no balance asserted yet, so from the first posting';
    const others = data.others.length ? `; postings in ${data.others.join(', ')} are not part of this` : '';
    const files = state.files.map((file) => `${file.path}${file.writable ? '' : ' (read-only)'}`).join(', ');
    $('sub').textContent = `${data.rows.length} postings in ${data.commodity || 'its commodity'}, ${since}${others}. ${files}`;
  }

  function drawRows() {
    const style = state.data.style;
    const date = $('date').value;
    shown = matching(state.data.rows, $('search').value, style);
    $('rows').innerHTML = shown.map((row) => {
      const later = date && row.date > date;
      return `<tr data-id="${escape(row.id)}" tabindex="-1" class="${ticked.has(row.id) ? 'on' : ''}${later ? ' later' : ''}" aria-selected="${ticked.has(row.id)}">
<td class="tick">${ticked.has(row.id) ? '✓' : ''}</td><td>${escape(row.date)}</td>
<td>${escape(row.description)}${row.status === 'Pending' ? ' <span class="pending">pending</span>' : ''}<br><span class="against">${escape(row.against)}</span></td>
<td class="n">${escape(readable(row.amount, style))}</td></tr>`;
    }).join('');
    focus = Math.min(focus, Math.max(0, shown.length - 1));
    drawSums();
  }

  function toggle(id) {
    const row = state.data.rows.find((entry) => entry.id === id);
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

  function moveFocus(to) {
    const rows = [...$('rows').children];
    if (!rows.length) return;
    focus = Math.max(0, Math.min(rows.length - 1, to));
    rows[focus].focus();
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
    const request = { ticked: [...ticked], finish: finish ? { date, balance } : null, fingerprint: state.fingerprint };
    const result = await link.preview(request);
    const writable = result.writable.some((file) => file.writable);
    const lines = [];
    for (const file of result.files) {
      lines.push(`<p><b>${escape(file.path)}</b>${file.changes.length ? `: ${file.changes.length} posting${file.changes.length === 1 ? '' : 's'} would be ${finish ? 'marked' : 're-marked'}` : ''}${file.appended ? `${file.changes.length ? ', and' : ':'} at the end:` : ''}</p>`);
      const changes = file.changes.slice(0, 40).map((change) => `<span class="del">${escape(String(change.line).padStart(6))}  ${escape(change.before)}</span>\n<span class="add">${escape(String(change.line).padStart(6))}  ${escape(change.after)}</span>`);
      if (file.changes.length > 40) changes.push(`… and ${file.changes.length - 40} more`);
      if (changes.length) lines.push(`<pre>${changes.join('\n')}</pre>`);
      if (file.appended) lines.push(`<pre class="add" id="assertion">${escape(file.appended)}</pre>`);
    }
    if (!result.files.length && !result.missing.length) lines.push('<p>Nothing to write: every posting is already marked as ticked here.</p>');
    // One line per reason: two hundred postings in a file that cannot be read are one problem.
    const reasons = [...new Set(result.missing.map((entry) => entry.why))];
    if (reasons.length) lines.push(`<p>${escape(reasons.join('; '))}.</p>`);
    if (finish && !result.files.some((file) => file.appended) && result.assertion) {
      lines.push(`<p>The assertion to add at the end of the journal:</p><pre class="add" id="assertion">${escape(result.assertion)}</pre>`);
    }
    const canWrite = writable && result.files.length && !result.missing.length;
    lines.push(`<div class="tools">${canWrite ? `<button class="primary" id="apply">Write ${finish ? 'and check' : 'the marks'}</button>` : ''}${!writable && finish ? '<button id="copy">Copy the assertion</button>' : ''}<button id="cancel">Cancel</button></div>`);
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
    }
    hidePreview();
    drawSub();
    drawRows();
    say(answer.ok ? `${answer.message}.` : answer.error, !answer.ok);
  }

  $('rows').addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (tr) toggle(tr.dataset.id);
  });
  $('hints').addEventListener('click', (event) => {
    const p = event.target.closest('p[data-id]');
    if (!p) return;
    const index = shown.findIndex((row) => row.id === p.dataset.id);
    if (index >= 0) moveFocus(index);
  });
  for (const id of ['date', 'balance']) $(id).addEventListener('input', () => { hidePreview(); id === 'date' ? drawRows() : drawSums(); });
  $('search').addEventListener('input', drawRows);
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
    if (event.key === 'Escape' && event.target === $('search')) { $('search').value = ''; drawRows(); return; }
    if (typing) return;
    const rows = [...$('rows').children];
    if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); moveFocus(focus + 1); }
    else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); moveFocus(focus - 1); }
    else if (event.key === ' ' && rows[focus] && event.target.tagName !== 'BUTTON') { event.preventDefault(); toggle(rows[focus].dataset.id); }
    else if (event.key === 'a' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); $('all').click(); }
    else if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  });

  drawSub();
  drawRows();
}
