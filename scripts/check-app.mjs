#!/usr/bin/env node
//
// Does the app itself boot, run a command and keep its scrollback, in a real browser?
//
// Every other check in scripts/ takes one piece of this project and tests it with the rest
// taken out: the plugins' commands and parsers against fixtures, the engine under Node's
// WASI, the reconcile write path against files on disk. What none of them can notice is the
// chain that actually ships — the wasm starting up, a keystroke reaching xterm and coming
// back as a command, the engine's report being drawn, and the scrollback a reload puts back
// underneath the fresh banner. This serves dist/ and drives all of that in headless Chrome
// over the DevTools protocol: the terminal is read as text, and typing is real key events
// rather than pasted text, because xterm drops a synthetic insert.
//
// The scrollback is the part with nothing else holding it to account. What was on screen is
// saved on the way out and replayed before this visit's banner, and `clear` is supposed to
// take the stored copy with it as well as the screen: both are asserted here by reloading
// and looking, rather than by reading the code that promises them.
//
// The terminal is read out of the DOM, so screenreader mode is switched on first — the
// setting a visitor who uses a screen reader would have anyway — and the page reloaded to
// pick it up. That is the same localStorage record the settings command writes.
//
// Usage:
//   node scripts/check-app.mjs
// Chrome is found the way scripts/browser.mjs finds it: CHROME first, then PATH, then
// agent-browser's install.
// dist/ has to exist: `trunk build` writes it, and CI runs this after the Build step.
//
// Coverage map: every Command variant (src/terminal/commands.rs:14-56), the scenario
// that drives it here, or why no run can.
//
//   Upload         mountTheUpload              Open        openAFolderReadOnly (read-only fallback)
//   Reopen         openAFolderReadOnly (its refusal)      Journal     switchTheJournal
//   Clear          reloadAndClear              Help        helpAndSettings
//   Demo           loadTheDemoJournal          Search      searchTheScreen
//   SearchAgain    searchTheScreen             Download    writeAndDownload
//   Alias          aliasAndRecall              Unalias     searchTheScreen
//   Font           themeAndFont                ScreenReader pluginsAndScreenreader
//   Plugins        pluginsAndScreenreader, addAndForgetARepository,
//                   reloadAfterTheManifestChanged, runTheProbePlugin
//   Settings       helpAndSettings, importTheSettingsBack
//   Theme          themeAndFont                History     finderAndHistory, clearTheHistory
//   Hledger        every report step, from loadTheDemoJournal on
//
// Inherent, for one reason now. Person-bound — no headless run can drive them: `open`'s
// File System Access picker and `reopen`'s happy path need a real grant from a person.
// What this map used to call "not driven, though a headless run could" has a step now:
// cancelARunningCommand drives Ctrl+C both ways it can arrive — the busy branch of
// app.rs `on_input` against a command slow enough to lose the race to the key (the `^C`
// line, the queued input dropped, `[cancelled]`, the prompt back) and the idle branch of
// app.rs `handle`, which throws a typed line away with no command running at all.
// `upload`, `open`'s fallback and `drop` are all driven above.
//
// Payload arms with no step here — their decisions are `cargo test`'s in dispatch.rs:
// `? <word>`, bare `settings`/`theme`/`alias`/`unalias`/`screenreader`/`download`/`find`,
// `history <words>`, `N`.

import { createServer } from 'node:http';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launch, Tab as BaseTab, until } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const SETTINGS_KEY = 'hledger-anywhere.settings.v1';
const SCROLLBACK_KEY = 'hledger-anywhere.scrollback.v1';

let checks = 0;
let failures = 0;
const check = (ok, label, detail = '') => {
  checks += 1;
  if (ok) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `  <- ${detail}` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (error) => String((error && error.message) || error).split('\n')[0];

// Steps run in order and stop at the first that cannot be done: every one after a failed
// step would fail for the same reason and say nothing new. This is the harness every
// scenario calls through, so it lives here rather than in any one of them.
let stopped = false;
const run = async (label, action) => {
  if (stopped) return;
  try {
    await action();
    check(true, label);
  } catch (error) {
    check(false, label, short(error));
    stopped = true;
  }
};

// How often a string is on screen, for reports that grow one copy per run.
const occurrences = (text, needle) => text.split(needle).length - 1;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.lock': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Serve dist/ on an ephemeral port, the files exactly as they are on disk. */
async function serve(dir) {
  const server = createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent(request.url.split('?')[0]);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    // The fixture repository, served by name: `plugins add` fetches it the way it
    // fetches any other, over this server's own port.
    if (path === PROBE_REPOSITORY) {
      response.writeHead(200, { 'content-type': TYPES['.json'] });
      response.end(PROBE_MANIFEST_SERVED);
      return;
    }
    // The module that repository's manifest names, served beside it: `plugins add` never
    // fetches it, and the loader's `import()` is the only thing that does — resolved
    // against the manifest's own URL (assets/js/plugins.js `moduleFor`), which lands on
    // this server's `/round25probe.js`.
    if (path === PROBE_MODULE) {
      response.writeHead(200, { 'content-type': TYPES['.js'] });
      response.end(PROBE_MODULE_TEXT);
      return;
    }
    const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
    const file = join(dir, normalize(name));
    if (!file.startsWith(dir + sep)) {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(file).then(
      (body) => {
        response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
        response.end(body);
      },
      () => {
        response.writeHead(404);
        response.end('not found');
      },
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/**
 * The journal the upload step mounts, and the only place `expenses:round17test`
 * and `$42.75` are written — nothing else in this session, nor anything else in
 * this repository, holds either of them.
 */
const UPLOAD_JOURNAL = `\
; Fixture of scripts/check-app.mjs, for the upload step alone.
2026-05-04 * Round 17
    expenses:round17test              $42.75
    assets:bank:checking
`;

/**
 * The journal the drop step throws at the page, and the only place
 * `expenses:round18drop` and `$84.25` are written — nothing else in this
 * session, nor anything else in this repository, holds either of them.
 */
const DROP_JOURNAL = `\
; Fixture of scripts/check-app.mjs, for the drop step alone.
2026-05-05 * Round 18
    expenses:round18drop             $84.25
    assets:bank:checking
`;

/**
 * What `balance -O csv` writes for DROP_JOURNAL, byte for byte, and the only
 * thing the file downloaded below is allowed to hold: four rows, 98 bytes,
 * from the shipped engine itself —
 * `HLEDGER_NO_FILE_ARG=1 node scripts/hledger-wasm.mjs drop.journal balance -O csv`.
 * The report does not depend on the terminal width, so the browser's own
 * `COLUMNS` cannot move it.
 */
const REPORT_CSV = `\
"account","balance"
"assets:bank:checking","$-84.25"
"expenses:round18drop","$84.25"
"Total:","0"
`;

/**
 * The journal the open step's fallback mounts, and the only place
 * `expenses:round24open` and `$63.50` are written — nothing else in this session,
 * nor anything else in this repository, holds either of them.
 */
const OPEN_JOURNAL = `\
; Fixture of scripts/check-app.mjs, for the open step alone.
2026-05-06 * Round 24
    expenses:round24open            $63.50
    assets:bank:checking
`;

/**
 * What sits under `prices/` in the folder the open step hands over, and the only
 * copy of its text. Its path — not its contents — is what this file is for: it
 * only reaches the terminal if the directory pick kept the paths inside it.
 */
const OPEN_PRICES = `\
; Fixture of scripts/check-app.mjs, for the open step alone.
2026-05-06 price x  $1.00
`;

/**
 * The journal the cancel step mounts, and the only place `expenses:round27slow` is
 * written — nothing else in this session, nor anything else in this repository, holds
 * it. The transactions are what it is for: `balance` over them is slow enough to still
 * be running when Ctrl+C lands (the arithmetic is in the step that presses the key).
 *
 * Sized against the shipped engine itself, once, on this machine — generate, then
 * `HLEDGER_NO_FILE_ARG=1 node --experimental-wasi-unstable-preview1
 * scripts/hledger-wasm.mjs <file> balance` (AGENTS.md) — at 12,000 transactions:
 * 984,953 bytes and 5,360 ms, of which 519 ms is the engine's own startup (a
 * two-transaction journal costs that much alone), so ~4.8 s is the journal. The report
 * it would have drawn is four rows — two accounts, the rule, the total — so cancelling
 * it and drawing it later barely moves the screen, and the file is far under
 * `MAX_FILE_BYTES` (src/upload.rs, 5 MB), which at this density would buy ~64,000
 * transactions and ~28 s.
 */
const SLOW_JOURNAL = 'round27slow.journal';
const SLOW_ACCOUNT = 'expenses:round27slow';
const SLOW_TRANSACTIONS = 12000;

/** The slow journal's own text: transactions dated through January, two accounts, all of it balanced. */
function slowJournal(count) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    entries.push(
      `2026-01-${day} * slow ${i}\n    ${SLOW_ACCOUNT}    $${1 + (i % 9)}.00\n    assets:bank:checking\n`,
    );
  }
  return `; Fixture of scripts/check-app.mjs, for the cancel step alone.\n${entries.join('')}`;
}

/**
 * The repository `plugins add` installs, and the manifest this run first reads for it.
 *
 * Its shape is the one `Manifest` reads (src/plugins/mod.rs): a `plugins` entry with a
 * name and a summary, which is all `Registry::check` asks of one. `serve` answers for
 * this path rather than dist/ holding it, so the fetch runs against this run's own
 * server the way any repository's would. The `module` is not fetched by `plugins add`
 * (app.rs `install_repository` → plugins::loader::fetch): it is imported only when its
 * own command first runs, which the `runTheProbePlugin` scenario below does — `serve`
 * answers for that file too, as `PROBE_MODULE`. The reload scenario below rebinds what
 * `serve` holds to `PROBE_MANIFEST_RENAMED`.
 */
const PROBE_REPOSITORY = '/round25probe.json';
const PROBE_MANIFEST = `\
{
  "manifest": 1,
  "name": "round25probe",
  "plugins": [
    {
      "name": "round25probe",
      "group": "Check",
      "summary": "round25probe: a repository this check added and then forgot",
      "completes": ["probe"],
      "module": "./round25probe.js"
    }
  ]
}
`;

/**
 * What `serve` answers with for `PROBE_REPOSITORY`: the manifest above until the reload
 * scenario changes it, `PROBE_MANIFEST_RENAMED` while that scenario's reload runs, and
 * the manifest above again once the repository is forgotten.
 */
let PROBE_MANIFEST_SERVED = PROBE_MANIFEST;

/**
 * The path `PROBE_MANIFEST` gives its module, resolved against the manifest's own URL by
 * the loader (assets/js/plugins.js `moduleFor`), which is what puts it on this server.
 */
const PROBE_MODULE = '/round25probe.js';

/**
 * What `serve` answers for `PROBE_MODULE`, and the only copy of the module's text: a
 * plugin in the shape `assets/js/plugins.js` `run` builds one from — a default export
 * holding `run(args, host)`, which the loader awaits, and whose errors come back to the
 * app as `${name} failed: ...`.
 *
 * What it does is only what this run has to see on screen: say a line carrying the
 * plugin's own name and the `args` it was handed, ask the engine for `balance` and say
 * the row that names the upload fixture — the only way an answer from `host.hledger` can
 * reach a screen — remember a setting and say the value `host.setting` read back, and try
 * to save a file, which with no folder open has to come back as `host_save`'s refusal
 * (src/app.rs).
 */
const PROBE_MODULE_TEXT = `\
export default {
  async run(args, host) {
    host.say('round25probe: run(' + JSON.stringify(args) + ') as ' + host.name);
    const report = await host.hledger('balance');
    const row = report.split('\\n').find((line) => line.includes('expenses:round17test')) || '(no such row)';
    host.say('round25probe: hledger said ' + row.trim());
    host.remember('checked', 'on');
    host.say('round25probe: setting read back ' + host.setting('checked'));
    const files = host.files();
    host.say('round25probe: files ' + files.map((file) => file.path + (file.writable ? ' writable' : ' read-only')).join(', '));
    const held = host.read('round17.journal');
    host.say('round25probe: read ' + (held !== null && held.includes('expenses:round17test') ? 'held the fixture' : 'missed it'));
    const fresh = await host.refresh();
    host.say('round25probe: refresh ' + JSON.stringify(fresh));
    const answer = await host.save('probe.journal', 'x\\n');
    host.say('round25probe: save answered ' + JSON.stringify(answer));
  },
};
`;

/**
 * What `host_save` says when nothing has opened a folder, and the only place this file
 * holds it: the first of its two refusals (src/app.rs `host_save`), which the probe
 * plugin says back through `host.save` and the scenario below asserts verbatim. Only
 * `open` can make a loaded file writable, and that runs later in this run.
 */
const SAVE_REFUSAL = 'no folder is open for editing; run `open` first';

/**
 * The same repository after its manifest changed: the plugin renamed and its summary
 * rewritten. That is the pair a re-read has to leave nothing of — the old name gone as a
 * whole line rather than sitting beside the new one. The only place `round26reload` is
 * written.
 */
const PROBE_MANIFEST_RENAMED = `\
{
  "manifest": 1,
  "name": "round25probe",
  "plugins": [
    {
      "name": "round26reload",
      "group": "Check",
      "summary": "round26reload: the same repository read again with a changed manifest",
      "completes": ["probe"],
      "module": "./round26reload.js"
    }
  ]
}
`;

/**
 * Write the four files the upload step hands to the picker, and return their paths.
 *
 * One mounts, three cannot, for the three reasons `src/upload.rs` gives for
 * refusing: a file of no bytes (`admit_size`), a file with a NUL byte in it
 * (`admit_text`), and a file one kilobyte over `MAX_FILE_BYTES`, whose reason is
 * the size formatted to one decimal place — 5 MB plus 1 KB reads as 5.0.
 */
async function uploadFixtures(dir) {
  await writeFile(join(dir, 'round17.journal'), UPLOAD_JOURNAL);
  await writeFile(join(dir, 'empty.journal'), '');
  await writeFile(join(dir, 'binary.journal'), Buffer.from('not\0journal'));
  await writeFile(join(dir, 'huge.journal'), 'a'.repeat(5 * 1024 * 1024 + 1024));
  return ['round17.journal', 'empty.journal', 'binary.journal', 'huge.journal']
    .map((name) => join(dir, name));
}

/**
 * Write the folder the open step's fallback mounts — a journal at its root, a file
 * under `prices/` — and return the directory to hand the picker.
 *
 * The directory itself is what gets handed over, because that is what a person picks:
 * the browser turns it into the `webkitRelativePath`s a real pick carries
 * (`journal/hledger.journal` and `journal/prices/x.journal`), and `strip_common_root`
 * (src/journal.rs) drops the shared `journal/` on the way in.
 */
async function openFixtures(dir) {
  const folder = join(dir, 'journal');
  await mkdir(join(folder, 'prices'), { recursive: true });
  await writeFile(join(folder, 'hledger.journal'), OPEN_JOURNAL);
  await writeFile(join(folder, 'prices', 'x.journal'), OPEN_PRICES);
  return folder;
}


/**
 * The terminal as text, plus which xterm put it in the DOM.
 *
 * xterm draws its rows itself when it can and mirrors them into an accessibility tree when
 * screenreader mode is on; a build may have either, so the one that is there is read, and
 * the run says which it was.
 */
const READ_TERMINAL = `(() => {
  const rows = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent).join('\\n');
  const rendered = '.xterm-rows > div';
  const spoken = '.xterm-accessibility-tree > div';
  if (document.querySelectorAll(rendered).length) return { via: 'xterm-rows', text: rows(rendered) };
  if (document.querySelectorAll(spoken).length) return { via: 'xterm-accessibility-tree', text: rows(spoken) };
  return { via: 'nothing', text: '' };
})()`;

/** One tab: the terminal read back as text, and the input events a person would make. */
class Tab extends BaseTab {
  constructor(cdp, sessionId, options) {
    super(cdp, sessionId, options);
    this.via = null;
  }

  /**
   * Wait for boot to be over, not merely for a banner to be on screen.
   *
   * A reload replays the previous visit's scrollback first, so every word this visit is
   * about to print is already on screen before it prints any of it, and one banner proves
   * nothing. What is waited for is the banners the stored copy holds — all of them replayed
   * — plus this visit's own, and the prompt boot draws last. Nothing else writes to the
   * terminal in that window, so when both are there boot is over: the count alone is not
   * enough, because the banner is printed before the engine is compiled and the prompt
   * after it, and typing into a half-drawn terminal loses the first keystrokes to it.
   *
   * The count is also what makes a broken replay fail here rather than later, with the
   * numbers to say so.
   */
  async booted() {
    // The banner's own title line, `hledger-anywhere  hledger …` (messages.rs welcome),
    // rather than the word alone, read out of the stored copy with its escape sequences
    // taken off first (`\x1b[1mhledger-anywhere\x1b[0m  \x1b[…mhledger …` is one line of
    // it). The stored copy holds every write the visit made and the screen holds only
    // what survived: xterm redraws the line once per keystroke, so typing a line that
    // contains the word — `settings import hledger-anywhere-settings.json` does — counts
    // every redraw in the stored copy and once on screen. The title line is written once
    // per boot, is never typed, and is never redrawn over, so both sides count the same
    // banners: the stored ones plus this visit's own.
    const stored = (await this.storedScrollback()).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const expected = stored.match(/hledger-anywhere {2}hledger/g);
    const want = (expected ? expected.length : 0) + 1;
    const at = `(() => {
      const lines = (${READ_TERMINAL}).text.split('\\n').map((line) => line.trim()).filter(Boolean);
      const banners = (lines.join('\\n').match(/hledger-anywhere {2}hledger/g) || []).length;
      return banners >= ${want} && lines.length > 0 && lines[lines.length - 1].includes('»');
    })()`;
    try {
      await this.until(at, 'the terminal to finish booting');
    } catch (error) {
      const lines = (await this.read()).split('\n').map((line) => line.trim()).filter(Boolean);
      const banners = (lines.join('\n').match(/hledger-anywhere {2}hledger/g) || []).length;
      throw new Error(
        `${error.message}: ${banners} banner on screen over ${lines.length} rows, ${want} expected (${expected ? expected.length : 0} in the stored copy) — the stored scrollback did not come back, or this visit never finished printing`,
      );
    }
  }

  async read() {
    const { via, text } = await this.eval(READ_TERMINAL);
    this.via = via;
    return text;
  }

  /** What the scrollback key holds right now — what the next reload will replay. */
  async storedScrollback() {
    return (await this.eval(`localStorage.getItem(${JSON.stringify(SCROLLBACK_KEY)}) || ''`)) || '';
  }

  async focus() {
    const found = await this.eval("Boolean(document.querySelector('.xterm-helper-textarea'))");
    if (!found) throw new Error('the terminal has no input to type into');
    await this.eval("document.querySelector('.xterm-helper-textarea').focus(), document.activeElement.className");
    await sleep(60);
  }

  /**
   * One key, pressed and released the way the keyboard sends it.
   *
   * `Input.insertText` is not an option: xterm reads the key event, and a character that
   * arrived without one is dropped. `windowsVirtualKeyCode` is what the page sees as
   * `keyCode`, which is what xterm's own translation of Ctrl+letter and of Enter works on.
   */
  async press(key, { code, keyCode, text, modifiers = 0 } = {}) {
    const down = { type: 'keyDown', key, code: code || key, windowsVirtualKeyCode: keyCode, modifiers };
    if (text !== undefined) down.text = text;
    await this.send('Input.dispatchKeyEvent', down);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || key, windowsVirtualKeyCode: keyCode, modifiers });
    await sleep(60);
  }

  /** Type one command, character by character, and leave the line at the prompt. */
  async type(line) {
    await this.focus();
    for (const character of line) {
      if (character === ' ') await this.press(' ', { code: 'Space', keyCode: 32, text: ' ' });
      else if (character === '-') await this.press('-', { code: 'Minus', keyCode: 189, text: '-' });
      // Punctuation takes the code and key code a keyboard sends for it. xterm
      // translates the event itself and keeps a printable character only when the
      // key code is one it recognises: a '.' claiming its own code point (46) is
      // below that, and the keystroke never reaches the line — so '.' goes as the
      // Period key's 190 and '/' as the Slash key's 191, which is the repository
      // path `plugins add` is given below.
      else if (character === '.') await this.press('.', { code: 'Period', keyCode: 190, text: '.' });
      else if (character === '/') await this.press('/', { code: 'Slash', keyCode: 191, text: '/' });
      else await this.press(character, { code: `Key${character.toUpperCase()}`, keyCode: character.toUpperCase().charCodeAt(0), text: character });
    }
    await sleep(120);
  }

  async enter() {
    await this.press('Enter', { code: 'Enter', keyCode: 13 });
  }

  /** Ctrl+L, which the app reads as the control character xterm translates it to. */
  async clearScreen() {
    await this.press('l', { code: 'KeyL', keyCode: 76, modifiers: 2 });
  }
}

// ------------------------------------------------------------------ the scenarios

/**
 * Boot the page, then boot it again with the setting this run reads the terminal by.
 *
 * Needs: dist/ served at `base` and a tab open over it — nothing has been typed yet.
 * Leaves: the banner on screen, `SETTINGS_KEY` holding `{"screen_reader":true}` in
 * localStorage with the reload that mounted it, boot over (prompt drawn last) and
 * xterm's rows in the DOM, which is the only way any step below can read any of it.
 */
async function bootTheTerminal({ tab, base }) {
  await run('the app boots to its banner', async () => {
    await tab.navigate(`${base}/`);
    await tab.booted();
    const text = await tab.read();
    if (!text.includes('hledger-anywhere')) throw new Error('the banner is not on screen');
  });

  if (!stopped) {
    await tab.eval(`localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, '{"screen_reader":true}')`);
    await tab.reload();
    await run('the terminal is readable as rows', async () => {
      await tab.booted();
      const text = await tab.read();
      if (!text.includes('hledger-anywhere')) throw new Error('the banner is not on screen');
    });
  }
}

/**
 * Load the sample journal and draw the report every later count reads.
 *
 * Needs: the terminal readable as rows, an empty line at the prompt.
 * Leaves: `demo` run, `Loaded the sample journal` on screen and one `balance --tree`
 * report under it holding `income:salary` — the row the alias, search, journal and
 * reload steps all count against.
 */
async function loadTheDemoJournal({ tab }) {
  await run('typing echoes at the prompt', async () => {
    await tab.type('demo');
    const text = await tab.read();
    if (!text.trimEnd().endsWith('demo')) throw new Error(`the line reads ${JSON.stringify(text.trimEnd().split('\n').pop())}`);
  });

  await run('the demo journal loads', async () => {
    await tab.enter();
    await tab.until(`(${READ_TERMINAL}).text.includes('Loaded the sample journal')`, 'the sample journal to load');
  });

  await run('a balance report is drawn', async () => {
    await tab.type('balance --tree');
    await tab.enter();
    await tab.until(`(${READ_TERMINAL}).text.includes('income:salary')`, 'the report to be drawn');
  });
}

/**
 * Define the alias, run it, and recall it from history.
 *
 * Needs: the demo journal loaded and `income:salary` on screen from the balance step -
 * the alias's own report is asserted as the second copy of that line, and the recalled
 * run as the third.
 * Leaves: `bal` in history, `[bal runs balance]` twice and `income:salary` three times
 * on screen. Every count after this is read off the screen at the moment it is used, so
 * these numbers are this scenario's own proof and nothing later's.
 */
async function aliasAndRecall({ tab }) {
  // The app's own commands after the engine's: what it says for itself, the alias it
  // keeps, the history it recalls, the help a bare `?` prints and the settings written
  // out. The decisions behind all of that are `cargo test`'s; what only a browser can
  // see is whether `apply` put them on the screen, so each step reads the terminal
  // rather than the state behind it.

  await run('the alias is defined and said so', async () => {
    await tab.type('alias bal=balance');
    await tab.enter();
    await tab.until(`(${READ_TERMINAL}).text.includes('bal now runs balance')`, 'the alias to be accepted');
  });

  await run('the alias runs the command it names', async () => {
    await tab.type('bal');
    await tab.enter();
    // The note is the expansion saying itself out loud; the row is the engine answering
    // under the name that was typed.
    await tab.until(`(${READ_TERMINAL}).text.includes('[bal runs balance]')`, 'the alias note');
    await tab.until(`(${READ_TERMINAL}).text.split('income:salary').length - 1 >= 2`, 'the report from the alias');
  });

  await run('up arrow recalls the alias command', async () => {
    await tab.focus();
    await tab.press('ArrowUp', { code: 'ArrowUp', keyCode: 38 });
    // The echo is what proves the recall reached the line editor: the last row is the
    // prompt, and it only ends with the command once ↑ has put the line back on it.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('bal')`, 'the recalled line to be echoed');
  });

  await run('the recalled line runs and reports again', async () => {
    await tab.enter();
    // Both are here twice now: the note would still be on screen from the run above if
    // the recall had only echoed the line, so the count is what says it ran again.
    await tab.until(`(${READ_TERMINAL}).text.split('[bal runs balance]').length - 1 >= 2`, 'the alias note from the recalled line');
    await tab.until(`(${READ_TERMINAL}).text.split('income:salary').length - 1 >= 3`, 'the report to be drawn again');
  });
}

/**
 * Print the help overview and write the settings file out.
 *
 * Needs: the demo journal loaded, so the overview's command list has `demo` in it.
 * Leaves: the overview's three stable rows on screen, `settings export` in history for
 * the listing the finder group draws, and `hledger-anywhere-settings.json` in the
 * loaded-file list — the journal listing and the `journal ` completion both assert it.
 */
async function helpAndSettings({ tab }) {
  await run('a bare ? prints the overview', async () => {
    await tab.type('?');
    await tab.enter();
    // Three stable pieces of the overview rather than the page: the keys section says
    // how the line editor behaves, the demo row is a command the overview lists, and
    // neither is a heading a later edit could rename.
    await tab.until(`(${READ_TERMINAL}).text.includes('Enter runs a command.')`, 'the overview to be drawn');
    const text = await tab.read();
    if (!text.includes('Up and Down recall history.')) throw new Error('the keys section is not on screen');
    if (!text.includes('load the sample journal')) throw new Error('the command list is not on screen');
  });

  await run('settings export writes the settings file', async () => {
    await tab.type('settings export');
    await tab.enter();
    // The byte count in the message varies with what is set, so the file name is the
    // part worth holding still.
    await tab.until(`(${READ_TERMINAL}).text.includes('hledger-anywhere-settings.json')`, 'the export to be written');
  });
}

/**
 * Read the settings file the export above wrote back in, and put it into effect.
 *
 * Needs: `hledger-anywhere-settings.json` still in the loaded-file list — it is until
 * upload/drop/open replace that list — and nothing the record holds having changed
 * since it was written this visit, so this is a round trip that must change nothing.
 * Leaves: the same settings in force, said out loud as what was applied, and the line
 * at the prompt again. What the import names — font, screen reader, aliases, theme,
 * plugin settings, repositories — is what the steps below still find. Nothing here
 * writes a banner: the word `hledger-anywhere` reaches the screen only inside the file
 * name, which `booted` does not count, so the count the reload scenario waits for does
 * not move; the font and the theme are untouched by an import of the values they
 * already hold.
 */
async function importTheSettingsBack({ tab }) {
  // The wasm-only half of `settings`: `export` wrote the record out and put it in the
  // loaded files, and `import <path>` reads that same file back through
  // `file_contents` → `apply_settings_text` → `apply_settings` (src/app.rs) — the
  // chain no other check reaches, because the picker branch needs a person to choose
  // a file. What only a browser can show is that the loaded file was found by name,
  // applied, and confirmed on the screen the way the code words it.

  await run('settings import applies the exported file back unchanged', async () => {
    await tab.type('settings import hledger-anywhere-settings.json');
    await tab.enter();
    // `settings_imported` (src/terminal/messages.rs) lists what `apply_settings`
    // applied, in the order that function lists them: font, screen reader, aliases,
    // theme, plugin settings, repositories — six of them, because the file was
    // written by this visit and nothing in it had to be dropped, so there is no
    // `could not use:` line under the list.
    const said = 'Applied 6 settings: font, screen reader, aliases, theme, plugin settings, repositories.';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(said)})`, 'the import to be confirmed');
    // `settle` draws the prompt under the message; that is the line the next scenario
    // starts typing into.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the import');
  });
}

/**
 * Search the scrollback: land on a match, step to the next, and prove the app's own
 * words are left out of what is searched.
 *
 * Needs: `income:salary` rows on screen from the balance step — the total is counted
 * off them at the moment this runs, never pinned anywhere.
 * Leaves: the match counter, a stepped one and `No match for {word}.` on screen. The
 * total itself stays inside this scenario, because only the `n` step under it uses it.
 */
async function searchTheScreen({ tab }) {
  // Search is the one app command whose work happens on the screen itself: `find`
  // decides, and only a run like this one can show that App::find then read the rows,
  // counted the hits and left the app's own words out of them. The words asserted are
  // the ones it formats — `match {index} of {total} · {term}` and
  // `No match for {term}.` — rather than anything paraphrased here.

  // The counter line the search just printed is chatter and does not add to what the
  // next search counts, so `n` a step below asserts against this same number.
  let salaryMatches = 0;

  await run('find lands on a match and says which one', async () => {
    await tab.type('find salary');
    await tab.enter();
    // The first search starts at the top, so the index can only be 1; the total
    // belongs to whatever is on screen and is read from the line itself.
    const counter = /match 1 of (\d+) · salary/;
    await tab.until(`(${READ_TERMINAL}).text.match(${counter})`, 'the match counter to be announced');
    const text = await tab.read();
    salaryMatches = Number(counter.exec(text)[1]);
    if (salaryMatches < 2) throw new Error(`only ${salaryMatches} match: n has nowhere to step to`);
    if (!text.includes('income:salary')) throw new Error('the report row the search landed on is not on screen');
  });

  await run('n steps to the next match', async () => {
    await tab.type('n');
    await tab.enter();
    // `n` is a bare word, classified as the repeat rather than run as a command, and
    // it walks forward from the last hit — same total, index one on. Wrapping would
    // announce 1 again, so the 2 is what says it really moved.
    const stepped = new RegExp(`match 2 of ${salaryMatches} · salary`);
    await tab.until(`(${READ_TERMINAL}).text.match(${stepped})`, 'the counter to step on');
  });

  await run("the app's own words are left out of the search", async () => {
    const word = 'some-unique-word-xyz';
    // Nothing above prints this word, engine or app: it is typed from here on, and
    // the screen is read first so that a stray earlier mention cannot be what the
    // search ends up finding.
    if ((await tab.read()).includes(word)) throw new Error(`${word} was already on screen`);
    await tab.type(`unalias ${word}`);
    await tab.enter();
    // The echo of the typed line and `No alias called {word}.` — both words the app
    // says about itself, both visibly on screen, neither engine output.
    await tab.until(`(${READ_TERMINAL}).text.includes('No alias called ${word}')`, 'the complaint about the alias');
    const text = await tab.read();
    if (!text.includes(word)) throw new Error('the word is not on screen at all');
    await tab.type(`find ${word}`);
    await tab.enter();
    // Every row holding the word matches a chatter line exactly, so all of them are
    // dropped before the search looks, and what is left can only be the refusal.
    await tab.until(`(${READ_TERMINAL}).text.includes('No match for ${word}.')`, 'the no-match message');
  });
}

/**
 * Move the main file to the other loaded journal and back, and prove the engine
 * followed the window rather than only the screen saying it did.
 *
 * Needs: the demo's two journals plus the file `settings export` added to the loaded
 * list (the listing's count is not pinned — it grew with that export), and
 * `income:salary` on screen to count the rows against.
 * Leaves: the main file back at `hledger.journal` and two more balance reports on
 * screen. The report drawn under the other file has no `income:salary` row in it -
 * demo-prices.journal holds no postings — which is what says the engine really read
 * the file the window chose.
 */
async function switchTheJournal({ tab }) {
  // The journal chain: `-f` is never needed because the app chooses the main file and
  // exports it as `$LEDGER_FILE`, and `demo` proved only the default choice.

  await run('journal lists the loaded files with the main one marked', async () => {
    await tab.type('journal');
    await tab.enter();
    // The listing is `file_list`: a header naming how many files are loaded, one row
    // per file with `*` on the one hledger reads, and the sentence explaining the
    // mark. The count is not pinned here — `settings export` above added a file to
    // the same list — so the rows are what carry the assertion.
    await tab.until(`(${READ_TERMINAL}).text.match(/\\d+ files? loaded:/)`, 'the list of files');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    if (!lines.some((line) => /^\d+ files? loaded:$/.test(line))) {
      throw new Error('the listing header is not on screen');
    }
    // `choose_main` scored the file whose `include` names the other, so the mark
    // belongs on hledger.journal and nowhere else.
    if (!lines.includes('* hledger.journal')) throw new Error('the main file is not marked in the listing');
    if (!lines.includes('demo-prices.journal')) throw new Error('the other loaded file is not listed');
    if (!lines.join(' ').includes('is the file hledger reads')) {
      throw new Error('the listing does not say what the mark means');
    }
  });

  await run('journal moves the main file to the one named', async () => {
    await tab.type('journal demo-prices.journal');
    await tab.enter();
    // `set_journal` says which file it is now reading, and the prompt redraws under
    // that message with the new name rather than the old one.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('Now reading demo-prices.journal. Type balance for a report.')`,
      'the switch to be announced',
    );
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('demo-prices.journal »')`,
      'the prompt to name the file being read',
    );
  });

  await run('the engine reads the file the window chose', async () => {
    const before = await tab.read();
    const salary = occurrences(before, 'income:salary');
    const rules = occurrences(before, '--------------------');
    await tab.type('balance --tree');
    await tab.enter();
    // A fresh rule means a report was drawn: hledger's total rule is twenty dashes
    // whatever the report holds, so the count only moves when one arrives.
    await tab.until(
      `(${READ_TERMINAL}).text.split('--------------------').length - 1 > ${rules}`,
      'the report under the other file',
    );
    const after = await tab.read();
    // `income:salary` is written in hledger.journal and nowhere else: demo-prices.journal
    // is two price directives with no postings, so a report drawn from it has no such
    // row. One more of them than before would mean the engine still had the old
    // `$LEDGER_FILE` and read hledger.journal while the window said otherwise.
    const grown = occurrences(after, 'income:salary');
    if (grown !== salary) {
      throw new Error(`${grown - salary} more income:salary row(s) than before the switch: the engine still read hledger.journal`);
    }
  });

  await run('the report returns when the main file does', async () => {
    await tab.type('journal hledger.journal');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.includes('Now reading hledger.journal. Type balance for a report.')`,
      'the switch back to be announced',
    );
    const before = occurrences(await tab.read(), 'income:salary');
    await tab.type('balance --tree');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.split('income:salary').length - 1 > ${before}`,
      'the salary row to come back',
    );
    const after = occurrences(await tab.read(), 'income:salary');
    // One report, one row for the account: `--tree` does not split it further, so the
    // count says the report really was drawn rather than something else adding a row.
    if (after !== before + 1) {
      throw new Error(`the report added ${after - before} salary rows, expected exactly one`);
    }
  });
}

/**
 * Open the finder over the history, choose from it, and list the history itself.
 *
 * Needs: `balance --tree` as the most recent command (the journal group's last), with
 * `bal`, `demo` and `settings export` under it in the history; every count here is read
 * off the screen at the moment it is used, so the reports drawn above move nothing.
 * Leaves: the finder closed with an empty line at the prompt and the history listing on
 * screen. The command the selection holds never leaves this scenario either — it is
 * read off the list, not guessed at above.
 */
async function finderAndHistory({ tab }) {
  // The only parts of Ctrl+R's finder and of `history` that no other check touches: the
  // matching and the drawing are pinned by `cargo test` against `Picker` and
  // `history_listing`, but only a real window can show that a keystroke opened the
  // finder, that what was typed went into its query rather than the line, and that the
  // selection ran.

  // The command the finder holds on the selection, read off the list itself: what is
  // put on the prompt is whatever row carries the marker, so the run below asserts the
  // command that was actually chosen rather than the one this script guessed at.
  let chosen = '';

  await run('ctrl+r opens the finder over the history', async () => {
    await tab.focus();
    // The same shape as Ctrl+L above: keyCode 82 for `r`, modifiers 2 for Ctrl, and no
    // text — xterm translates the pair to the control character `\u{12}`, which is what
    // app.rs matches to open the finder.
    await tab.press('r', { code: 'KeyR', keyCode: 82, modifiers: 2 });
    // The query line is drawn synchronously with the key, but the terminal is read out
    // of the DOM, so the drawing is waited for rather than assumed.
    await tab.until(`(${READ_TERMINAL}).text.includes('history>')`, 'the finder query line');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const query = lines.find((line) => line.startsWith('history>'));
    // `history> ` + the query + the count, which is ` {matches}/{total}` (history.rs
    // picker_lines). Nothing is typed yet, so the query is empty and the count is the
    // whole history: three spaces between the prompt and the first digit.
    if (!query || !/^history>\s+\d+\/\d+$/.test(query)) {
      throw new Error(`the query line reads ${JSON.stringify(query)}`);
    }
    // Under the query the matches, newest first with an empty query, the selected one
    // marked `▌ ` — and the most recent command run was `balance --tree`.
    const selected = lines.find((line) => line.startsWith('▌'));
    if (!selected) throw new Error('no row of the list is selected');
    if (!selected.includes('balance')) throw new Error(`the top of the list is ${JSON.stringify(selected)}`);
  });

  await run('typing narrows the finder to the matching commands', async () => {
    await tab.type('bal');
    // The count after the query is the filtered one, in the format picker_lines writes:
    // two spaces, then `{matches}/{total}`.
    const counter = /^history> bal {2}(\d+)\/(\d+)$/;
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => ${counter}.test(line.trim()))`,
      'the filtered match count',
    );
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const query = lines.find((line) => line.startsWith('history>'));
    const [, matches, total] = counter.exec(query);
    // `balance --tree` and `bal` are both in the history and both match as a run at the
    // start of the word, so one match would mean the query never left the line editor.
    if (Number(matches) < 2) throw new Error(`only ${matches} of ${total} commands match bal`);
    if (Number(matches) > Number(total)) throw new Error(`${matches} matches out of ${total}`);
    const selected = lines.find((line) => line.startsWith('▌'));
    if (!selected || !selected.includes('balance')) {
      throw new Error(`the selection is ${JSON.stringify(selected)}`);
    }
    chosen = selected.replace(/^▌ /, '');
  });

  await run('enter puts the chosen command on the prompt and it runs', async () => {
    await tab.enter();
    // Enter closes the finder and leaves the selection on the line, as fzf's does:
    // running is a second, deliberate Enter (app.rs finder_input). The echo is what
    // says the choice reached the line editor rather than only the list.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith(${JSON.stringify(chosen)})`,
      'the chosen command to land on the prompt',
    );
    const before = occurrences(await tab.read(), '--------------------');
    await tab.enter();
    // A fresh rule means a fresh report: hledger's total rule is twenty dashes whatever
    // the report holds, so the count only moves when one arrives.
    await tab.until(
      `(${READ_TERMINAL}).text.split('--------------------').length - 1 > ${before}`,
      'the report from the chosen command',
    );
  });

  await run('escape closes the finder without running anything', async () => {
    await tab.focus();
    await tab.press('r', { code: 'KeyR', keyCode: 82, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.includes('history>')`, 'the finder to open again');
    await tab.type('zz');
    // No command in the history holds a z: with a query and nothing under it,
    // picker_lines draws this line instead of a list.
    await tab.until(`(${READ_TERMINAL}).text.includes('nothing matches')`, 'the empty list to be said');
    await tab.press('Escape', { code: 'Escape', keyCode: 27 });
    await tab.until(`!(${READ_TERMINAL}).text.includes('history>')`, 'the finder to close');
    const text = await tab.read();
    // `close_finder` erased from the query line down and redrew the prompt with the line
    // as it was — empty, because nothing was typed into it before Ctrl+R — so the last
    // row is the prompt again and none of the finder is left.
    if (text.includes('nothing matches')) throw new Error('the list is still on screen');
    if (!text.trimEnd().endsWith('»')) {
      throw new Error(`the last line is ${JSON.stringify(text.trimEnd().split('\n').pop())}`);
    }
  });

  await run('history lists the commands that were run', async () => {
    await tab.type('history');
    await tab.enter();
    // `history_listing` numbers every entry oldest first, two spaces after the number:
    // `{n}  {command}`, raw command lines rather than what they expanded to. `demo`
    // opened the sample journal and `settings export` wrote the settings file, both
    // run earlier this visit, and the listing is waited for rather than the echo of it.
    await tab.until(`(${READ_TERMINAL}).text.includes('  settings export')`, 'the listing to be drawn');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    if (!lines.some((line) => /^\d+  demo$/.test(line))) throw new Error('demo is not in the listing');
    if (!lines.some((line) => /^\d+  settings export$/.test(line))) {
      throw new Error('settings export is not in the listing');
    }
  });
}

/**
 * Forget the commands run so far, and show what that leaves behind.
 *
 * Needs: the history listing the scenario above just drew — `demo` and `settings
 * export` among its rows — and an empty line at the prompt.
 * Leaves: the history holding only what was run since the clear (the clear wiped the
 * line that asked for it as well, so the first entry is `history` itself), ↑ with
 * nothing to recall, and the line at the prompt. The steps above keep their order and
 * their listing: nothing after this reads the history they drew, and every count below
 * is taken from reports on the screen, not from it.
 */
async function clearTheHistory({ tab }) {
  // What `history clear` is for, end to end: `Command::History(Some("clear"))` decides
  // `Effect::ClearHistory` followed by its own sentence (src/dispatch.rs), `apply`
  // empties the stored list (src/app.rs), and the recall key and the listing are what a
  // person then sees of that. `cargo test` pins the decision and the listing formatter;
  // only a run like this one can show the list actually going.

  await run('history clear forgets the commands run so far', async () => {
    await tab.type('history clear');
    await tab.enter();
    // The sentence dispatch.rs prints after the wipe, word for word — it names the two
    // things that read the history, ↑ and Ctrl+R, which is what the steps below check.
    const said = 'The history is cleared: nothing is left for ↑ or Ctrl+R to recall.';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(said)})`, 'the clear to be announced');
  });

  await run('up arrow recalls nothing after the clear', async () => {
    await tab.focus();
    await tab.press('ArrowUp', { code: 'ArrowUp', keyCode: 38 });
    // `history_prev` returns without touching the line when the history is empty, so
    // the prompt redraws as it was: the line held nothing before the key and holds
    // nothing now, and a command recalled onto it would end with that command instead
    // of with the prompt. That ↑ reaches the editor at all is what the alias scenario
    // above proved; what is new here is what it has to find.
    const last = (await tab.read()).trimEnd().split('\n').pop();
    if (!last.endsWith('»')) throw new Error(`the line after ↑ reads ${JSON.stringify(last)}`);
  });

  await run('history lists only what was run since the clear', async () => {
    await tab.type('history');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === '1  history')`,
      'the listing to be drawn',
    );
    // The whole of the new listing, read from the clear message down so the listing
    // the scenario above drew cannot stand in for it: `submit` remembers the line
    // before it lists (src/app.rs), so what the clear left is this one entry, numbered
    // first and only — the old rows are numbered above the message and gone from it.
    const text = await tab.read();
    const after = text.slice(text.lastIndexOf('The history is cleared'));
    const rows = after.split('\n').map((line) => line.trim()).filter((line) => /^\d+  /.test(line));
    if (rows.length !== 1 || rows[0] !== '1  history') {
      throw new Error(`the listing after the clear holds ${JSON.stringify(rows)}`);
    }
  });
}

/**
 * Drive the rest of what the help's line on Tab promises — commands, flags, accounts,
 * aliases and paths — where each list comes from: the cursor's position picks the list,
 * `complete_or_menu` gathers the sources for it, and the rows are what `show_options`
 * drew.
 *
 * Needs: an empty line at the prompt (the finder closed on it and the history clear
 * above left it that way), the alias `bal`
 * defined, the demo's journals and the settings file still the loaded list, and
 * `assets:bank:checking` and `income:salary` in the main file for Tab to fetch the
 * accounts from.
 * Leaves: the line empty again with no menu on screen — where the theme step starts.
 */
async function completeAtThePrompt({ tab }) {
  // Three surfaces the Keys section of the help promises and no step above drives:
  // the menu Tab draws, the colours `theme` writes into the page, and the size `font`
  // gives xterm. Each is asserted by the value the code itself formats — the heading
  // `completion` prints, the theme's own background as a custom property, the font
  // size as the rows measure it — rather than by something having changed.

  await run('tab on an empty line lists the commands', async () => {
    await tab.focus();
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // `completion` heads the empty-line list with this sentence (terminal/commands.rs)
    // and `show_options` prints it directly above the columns, so the row under the
    // heading is the first candidate: `starting_words` opens with `upload`.
    const heading = 'Commands you can run:';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(heading)})`, 'the command list to be drawn');
    // Blank rows are the rest of the tall window, so the empty ones are dropped
    // before the end of the text is read as the prompt.
    const lines = (await tab.read()).split('\n').map((line) => line.trim()).filter(Boolean);
    const at = lines.findIndex((line) => line === heading);
    if (at < 0) throw new Error('the heading is not a line of its own');
    if (!lines[at + 1] || !lines[at + 1].startsWith('upload')) {
      throw new Error(`the row under the heading reads ${JSON.stringify(lines[at + 1])}`);
    }
    // The last line is the prompt: an empty token lists the candidates and types
    // nothing onto the line, so what was there is still all that is there.
    const prompt = lines.pop();
    if (!prompt.endsWith('»')) throw new Error(`the last line is ${JSON.stringify(prompt)}`);
    // Every candidate appears in the rows between the heading and the prompt —
    // `format_columns` is column-major and lays each row out to the width the
    // terminal gave it — so the words are matched in the list alone, where an
    // earlier step's output cannot stand in for them.
    const listed = lines.slice(at + 1).join(' ');
    for (const word of ['open', 'demo', 'balance', 'screenreader', 'history']) {
      if (!new RegExp(`\\b${word}\\b`).test(listed)) {
        throw new Error(`${word} is not among the commands listed`);
      }
    }
  });

  await run('tab completes the word on the line', async () => {
    await tab.type('dem');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // One candidate starts with `dem` — `demo` — and `complete` puts it on the line
    // with a space after it (`format!("{only} ")`, terminal/mod.rs), so the prompt
    // redraws over the typed token with the whole word where `dem` was.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('demo')`, 'the completed word on the line');
    const raw = (await tab.read()).split('\n').filter((line) => line.trim()).pop();
    // The row holds what `complete` put there: the prompt, the whole word where `dem`
    // was, and the space that follows it — `format!("{only} ")` — as the row shows it.
    if (!raw.trimEnd().endsWith('» demo') || !/\bdemo\s+$/.test(raw)) {
      throw new Error(`the row reads ${JSON.stringify(raw)}`);
    }
  });

  await run('an ambiguous prefix opens a menu the tabs step through', async () => {
    await tab.focus();
    // Ctrl+U kills the completed `demo ` off the line without running it, which is
    // what leaves the menu's own line to say something on its own.
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.type('d');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // Four commands start with `d` — demo, descriptions, diff, download — and they
    // agree on nothing past it, so `complete` opens the menu: the first of them,
    // sorted, goes on the line, and `show_options` lists all four above the prompt
    // with no heading, because the line itself is what shows the choice.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» demo')`, 'the first candidate on the line');
    const menu = /^demo\s+descriptions\s+diff\s+download$/;
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => ${menu}.test(line.trim()))`,
      'the menu to be drawn',
    );
    // The second Tab steps to the next candidate (`menu_next`); the list is printed
    // once, so only the line changes.
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» descriptions')`, 'the selection to step on');
    // Escape is `menu_cancel`: the line goes back to what was typed, and only that.
    await tab.press('Escape', { code: 'Escape', keyCode: 27 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» d')`, 'the line to be put back');
    // And the line is emptied again for the commands below.
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  // The rest of what the help's line on Tab promises — commands, flags,
  // accounts, aliases and paths — driven where each list comes from: the
  // cursor's position picks the list (terminal/commands.rs `completion`),
  // `complete_or_menu` (app.rs) gathers the sources for it, and the rows are
  // what `show_options` drew. The line may only change where `complete`
  // changes it, and each assertion is on the words the code itself offers.

  await run('tab completes a flag after a command', async () => {
    await tab.type('balance -');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // Every flag in FLAGS (terminal/mod.rs) starts with `-` and they agree on
    // nothing past it, so `complete` opens the menu: sorted, the first of them
    // — `--account` — goes on the line where the `-` was.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('» balance --account')`,
      'the first flag on the line',
    );
    const lines = (await tab.read()).split('\n').filter((line) => line.trim());
    // The menu is printed above the prompt with no heading — the line itself
    // shows the choice — so the rows over the prompt are the candidates: the
    // run of rows that start with the flag character, `format_columns` having
    // laid them out one line that never wraps (its width formula guarantees
    // the widest item fits).
    const rows = [];
    for (let at = lines.length - 2; at >= 0; at -= 1) {
      const row = lines[at].trim();
      if (row.startsWith('--') || row === '-O') rows.unshift(row);
      else break;
    }
    if (!rows.length) throw new Error('no menu above the prompt');
    // The whole menu, not a sample: FLAGS holds 32 names and every one of them
    // is a word for `balance`, laid out column-major and padded to the widest.
    const offered = rows.join(' ').split(/\s+/);
    const unique = new Set(offered);
    if (unique.size !== 32 || !offered.every((word) => word.startsWith('-'))) {
      throw new Error(`the menu holds ${unique.size} words, not the 32 flags: ${rows.join(' | ')}`);
    }
    for (const flag of ['--tree', '--depth', '--real']) {
      if (!unique.has(flag)) throw new Error(`${flag} is not among the flags offered`);
    }
    // Escape is `menu_cancel`: the line goes back to what was typed...
    await tab.press('Escape', { code: 'Escape', keyCode: 27 });
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('» balance -')`,
      'the line to be put back',
    );
    // ...and is emptied for the steps below.
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  await run('tab lists the loaded files after a command', async () => {
    await tab.type('journal ');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // Nothing is typed after the space, so there is no token to complete from
    // and `complete` lists instead of typing a guess: the heading is the one
    // `completion` gives an argument-position list, and the words under it
    // start with the loaded paths (Sources.paths ← App::paths).
    const heading = 'Flags, accounts and paths:';
    await tab.until(
      `(${READ_TERMINAL}).text.includes(${JSON.stringify(heading)})`,
      'the argument list to be drawn',
    );
    const lines = (await tab.read()).split('\n').filter((line) => line.trim());
    const at = lines.lastIndexOf(heading);
    if (at < 0) throw new Error('the heading is not a line of its own');
    // The list ends at the prompt, and the prompt row is the line itself: the
    // empty token left `journal ` exactly as it was typed — its own trailing
    // space plus the one xterm leaves in the cursor's cell, so the two.
    const raw = lines[lines.length - 1];
    if (!raw.endsWith('» journal  ')) throw new Error(`the last line reads ${JSON.stringify(raw)}`);
    const listed = lines.slice(at + 1, lines.length - 1).join(' ');
    // What the session has loaded: the demo's two journals, plus the file
    // `settings export` absorbed into the same list earlier in the run.
    for (const name of ['hledger.journal', 'demo-prices.journal', 'hledger-anywhere-settings.json']) {
      if (!listed.includes(name)) throw new Error(`${name} is not among the words offered`);
    }
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  await run('tab offers the accounts from the loaded journal', async () => {
    await tab.type('balance ');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    const heading = 'Flags, accounts and paths:';
    const holds = `(() => {
      const lines = (${READ_TERMINAL}).text.split('\\n').map((line) => line.trim()).filter(Boolean);
      const at = lines.lastIndexOf(${JSON.stringify(heading)});
      return at >= 0 && lines.slice(at + 1).some((line) => line.includes('assets:bank:checking'));
    })()`;
    // Account names are a whole engine run, fetched in the background when
    // the first Tab asks for them (App::ensure_accounts → `hledger accounts`),
    // and a Tab while they load lists what has arrived — so the Tab is pressed
    // again until the journal's own names are in the list, rather than
    // assuming the run finished by some deadline.
    await until('the account names to arrive', async () => {
      if (await tab.eval(holds)) return true;
      await tab.press('Tab', { code: 'Tab', keyCode: 9 });
      return false;
    });
    const lines = (await tab.read()).split('\n').filter((line) => line.trim());
    const at = lines.lastIndexOf(heading);
    if (at < 0) throw new Error('the heading is not a line of its own');
    const raw = lines[lines.length - 1];
    if (!raw.endsWith('» balance  ')) throw new Error(`the last line reads ${JSON.stringify(raw)}`);
    // Both accounts are written in the demo journal (terminal/mod.rs
    // DEMO_JOURNAL), and the rows after the heading are the list alone.
    const listed = lines.slice(at + 1, lines.length - 1).join(' ');
    for (const account of ['assets:bank:checking', 'income:salary']) {
      if (!listed.includes(account)) throw new Error(`${account} is not among the words offered`);
    }
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  await run('tab completes the alias where an alias may follow', async () => {
    await tab.type('balance b');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // Aliases join an argument-position list (completion adds
    // Sources.aliases when no plugin owns the line), and `bal` is the only
    // word offered starting with `b` — no flag, path or demo account does —
    // so `complete` puts it on the line whole with the space it appends to a
    // completion, exactly as it did for `dem` above.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('» balance bal')`,
      'the alias on the line',
    );
    const raw = (await tab.read()).split('\n').filter((line) => line.trim()).pop();
    if (!raw.trimEnd().endsWith('» balance bal') || !/\bbal\s+$/.test(raw)) {
      throw new Error(`the row reads ${JSON.stringify(raw)}`);
    }
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  await run('a word nothing starts with is answered with the closest names', async () => {
    await tab.type('bnc');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // No command starts with `bnc`, but `balance` holds those letters in
    // order, so `complete` answers with the fuzzy list under this exact
    // heading (app.rs) — and the line is left as typed: a closest name is
    // worth showing, not worth typing over someone.
    const heading = 'Nothing starts with that. Closest names:';
    await tab.until(
      `(${READ_TERMINAL}).text.includes(${JSON.stringify(heading)})`,
      'the closest names to be drawn',
    );
    const lines = (await tab.read()).split('\n').filter((line) => line.trim());
    const at = lines.lastIndexOf(heading);
    if (at < 0) throw new Error('the heading is not a line of its own');
    const listed = lines.slice(at + 1, lines.length - 1).join(' ');
    if (!/\bbalance\b/.test(listed)) throw new Error('balance is not among the closest names');
    const raw = lines[lines.length - 1];
    // The line is untouched: the row ends with `bnc` and the one space xterm
    // leaves in the cursor's own cell — the empty prompt row read
    // `hledger.journal »  ` for the same reason — and with no second one,
    // which a space typed onto the line would put there.
    if (!raw.endsWith('» bnc ') || raw.endsWith('» bnc  ')) {
      throw new Error(`the last line reads ${JSON.stringify(raw)}`);
    }
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });

  await run('shift+tab steps backward through the menu', async () => {
    await tab.focus();
    await tab.type('d');
    await tab.press('Tab', { code: 'Tab', keyCode: 9 });
    // The same four commands starting with `d` as the menu step above: sorted,
    // the first on the line, all four printed over the prompt.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» demo')`, 'the first candidate on the line');
    const menu = /^demo\s+descriptions\s+diff\s+download$/;
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => ${menu}.test(line.trim()))`,
      'the menu to be drawn',
    );
    // Shift+Tab reaches the app as xterm's CSI Z: keyCode 9 with Shift set —
    // 8 in the modifier field this file sends Ctrl as 2 in — and app.rs reads
    // it as `menu_previous`. From the first candidate that wraps to the last,
    // which no forward step could produce: a Tab from `demo` is
    // `descriptions`.
    await tab.press('Tab', { code: 'Tab', keyCode: 9, modifiers: 8 });
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('» download')`,
      'the selection to step back to',
    );
    // And a plain backward step: `download`'s predecessor in the sorted list.
    await tab.focus();
    await tab.press('Tab', { code: 'Tab', keyCode: 9, modifiers: 8 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» diff')`, 'the previous candidate');
    await tab.focus();
    await tab.press('Escape', { code: 'Escape', keyCode: 27 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('» d')`, 'the line to be put back');
    await tab.press('u', { code: 'KeyU', keyCode: 85, modifiers: 2 });
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the line to be cleared');
  });
}

/**
 * Paint the page with `theme` and move the terminal's size with `font`, putting it back.
 *
 * Needs: `--term-bg` still the built-in #000000, which nothing above changes.
 * Leaves: gruvbox applied, and the font at the size `font` first reported: `booted`
 * counts banners in a window sized for the default font, and a big one scrolls them
 * out of it — which is what the reload scenario at the end depends on.
 */
async function themeAndFont({ tab }) {
  await run('theme paints the page in the theme’s own background', async () => {
    // `apply_theme` writes the theme's colours onto the document element as custom
    // properties; `--term-bg` is the background, and it starts at the built-in
    // theme's #000000 (theme.rs), which is also what the stylesheet declares.
    const bg = "getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim()";
    const before = await tab.eval(bg);
    if (before !== '#000000') {
      throw new Error(`--term-bg reads ${JSON.stringify(before)} before the command, not the built-in #000000`);
    }
    await tab.type('theme gruvbox');
    await tab.enter();
    // `theme_applied` is what a found theme says for itself, and gruvbox's own
    // background is #282828 (assets/plugins/plugins.json), not merely something
    // other than what was there.
    await tab.until(`(${READ_TERMINAL}).text.includes('Theme gruvbox')`, 'the theme to be confirmed');
    await tab.until(`${bg} === '#282828'`, '--term-bg to read gruvbox’s background');
  });

  await run('font sets the terminal’s size and puts it back', async () => {
    await tab.type('font');
    await tab.enter();
    // `font` with no argument reports the size it is at, in px (dispatch.rs).
    const report = /The font is (\d+)px, between/;
    await tab.until(`(${READ_TERMINAL}).text.match(${report})`, 'the font size to be reported');
    const original = Number(report.exec(await tab.read())[1]);
    if (!(original > 0)) throw new Error('no font size in the report');
    // The size as a browser measures it: xterm injects the option into its own rule
    // for `.xterm-rows`, so the rows' computed font-size is the number to hold the
    // command to — and it has to agree with the size the command just reported.
    const rowsFont = "getComputedStyle(document.querySelector('.xterm-rows')).fontSize";
    const measures = (size) => `${rowsFont} === '${size}px'`;
    if (!(await tab.eval(measures(original)))) {
      throw new Error(`the rows measure ${await tab.eval(rowsFont)}, not the reported ${original}px`);
    }
    // `font 30` is inside the 8–32 range `font_size` clamps to, so 30 is what both
    // the message and the rows have to say.
    await tab.type('font 30');
    await tab.enter();
    await tab.until(`(${READ_TERMINAL}).text.includes('The font is now 30px.')`, 'the new size to be announced');
    await tab.until(measures('30'), 'the rows to measure 30px');
    // Back to the size it was before this step: `set_font_size` puts it there and the
    // rows measure it again.
    await tab.type(`font ${original}`);
    await tab.enter();
    await tab.until(`(${READ_TERMINAL}).text.includes('The font is now ${original}px.')`, 'the original size to be announced');
    await tab.until(measures(String(original)), 'the rows to measure the original size again');
  });
}

/**
 * Hand the picker four files, mount the one that mounts, and read the report back.
 *
 * Needs: the four fixture files `uploadFixtures` wrote into `fixtures`, and `launched`'s
 * CDP session to intercept the file chooser with.
 * Leaves: `round17.journal` mounted as the main file with the prompt naming it, and
 * `expenses:round17test` and `$42.75` on screen. The demo journals are gone with it,
 * and nothing below needs them: the reload and clear steps read scrollback text, and
 * every report they look for was drawn before this step.
 */
async function mountTheUpload({ tab, launched, fixtures }) {
  // `upload` opens the picker inside the key handler (app.rs, `Effect::Upload`), the
  // browser hands over four files, and `src/upload.rs` mounts the one it can and says
  // why the other three are skipped. The upload replaces what was loaded, which is what
  // the README promises.

  await run('upload mounts one file and says why it skips three', async () => {
    const paths = await uploadFixtures(fixtures);

    // A file picker is a modal dialog, so headless cannot show one and wait for
    // a person: `Page.setInterceptFileChooserDialog` turns the click's dialog
    // into `Page.fileChooserOpened`, and the backendNodeId that event carries is
    // the input the four paths go back to with `DOM.setFileInputFiles`.
    let chooser = null;
    const watching = launched.cdp.on((message) => {
      if (message.sessionId === tab.sessionId && message.method === 'Page.fileChooserOpened') {
        chooser = message.params || {};
      }
    });
    let handed = 'the intercepted file chooser';
    try {
      let intercepted = true;
      try {
        await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
      } catch {
        intercepted = false;
      }
      await tab.type('upload');
      await tab.enter();
      if (intercepted) await until('the intercepted file chooser to open', () => chooser, { timeoutMs: 15000 });
      if (chooser && chooser.backendNodeId) {
        await tab.send('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
      } else {
        // No chooser event: the input `open_picker` made is still on the page, so
        // the same four files are built onto it and the `change` the picker waits
        // on is dispatched by hand. `upload.rs` still reads, skips and mounts every
        // file; only the dialog's own plumbing goes unexercised, and that is why
        // this run says so.
        handed = 'an in-page change event, because no chooser opened';
        const failed = await tab.eval(`(() => {
          const input = document.getElementById('hledger-anywhere-upload-input');
          if (!input) return 'the upload input is not on the page';
          const transfer = new DataTransfer();
          transfer.items.add(new File([${JSON.stringify(UPLOAD_JOURNAL)}], 'round17.journal'));
          transfer.items.add(new File([], 'empty.journal'));
          transfer.items.add(new File([new Uint8Array([0x6e, 0x6f, 0x74, 0x00, 0x6a, 0x6f, 0x75, 0x72, 0x6e, 0x61, 0x6c])], 'binary.journal'));
          transfer.items.add(new File(['a'.repeat(5 * 1024 * 1024 + 1024)], 'huge.journal'));
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));
          return '';
        })()`);
        if (failed) throw new Error(failed);
      }
    } finally {
      watching();
    }

    // The picker settles on `change`. Whether `DOM.setFileInputFiles` fired one
    // itself is what this wait answers: the input still being in the page means
    // the promise never settled, and dispatching the event then is the event the
    // browser would have sent with files of its own.
    const arrived = `(${READ_TERMINAL}).text.includes('Uploaded 1 file.')`;
    try {
      await tab.until(arrived, 'the uploaded files to arrive', 15000);
    } catch {
      const waiting = await tab.eval("Boolean(document.getElementById('hledger-anywhere-upload-input'))");
      if (!waiting) throw new Error('the selection was read, but the arrival message never printed');
      handed += '; a change event was dispatched for it';
      await tab.eval("document.getElementById('hledger-anywhere-upload-input').dispatchEvent(new Event('change'))");
      await tab.until(arrived, 'the uploaded files to arrive after the change event');
    }
    if (handed !== 'the intercepted file chooser') console.log(`note the files were handed over by ${handed}`);

    // Every line is `files_arrived` (src/terminal/messages.rs) as it renders:
    // `source` and the count from `count`, one row per loaded file, one row per
    // skip carrying the reason upload.rs itself formats — `admit_size`'s
    // "empty file", `admit_text`'s NUL verdict, and the per-file limit to one
    // decimal place — and the sentence naming the file `choose_main` picked.
    const text = await tab.read();
    const lines = text.split('\n').map((line) => line.trim());
    const said = [
      'Uploaded 1 file.',
      'round17.journal',
      'skipped empty.journal: empty file',
      'skipped binary.journal: looks like a binary file',
      'skipped huge.journal: 5.0 MB is over the per-file limit',
    ];
    for (const line of said) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line on screen`);
    }
    if (!text.includes('Reading round17.journal. Type balance for a report, or ? for the rest.')) {
      throw new Error('the arrival message does not name the file hledger reads');
    }
  });

  await run('the engine reads the uploaded journal', async () => {
    const before = await tab.read();
    // Nothing earlier in the session can have written either string: the fixture
    // above is their only copy, so a report holding them can only have been
    // drawn from the file the picker mounted.
    if (occurrences(before, 'expenses:round17test')) throw new Error('the fixture account was already on screen');
    if (occurrences(before, '$42.75')) throw new Error('the fixture amount was already on screen');
    const rules = occurrences(before, '--------------------');
    await tab.type('balance --tree');
    await tab.enter();
    // A fresh rule means a report was drawn, and the rows under it say which
    // journal it was drawn from: `accept_files` replaced the loaded files and
    // `configure` re-exported `$LEDGER_FILE`, so the engine can only reach this
    // account if both moved to the uploaded file.
    await tab.until(
      `(${READ_TERMINAL}).text.split('expenses:round17test').length - 1 > 0`,
      'the report from the uploaded journal',
    );
    const after = await tab.read();
    if (occurrences(after, '--------------------') <= rules) throw new Error('no fresh report rule was drawn');
    if (!after.includes('$42.75')) throw new Error('the fixture amount is not in the report');
  });

  await run('the prompt names the uploaded journal', async () => {
    // `prompt_for` dims the basename of the file being read, and `announce`
    // redraws the prompt under the arrival message and under every report since,
    // so the last row is the uploaded file's name rather than the demo's.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('round17.journal »')`,
      'the prompt to name the uploaded journal',
    );
  });
}

/**
 * List the plugins, then take the accessibility tree away and bring it back.
 *
 * Needs: the upload chain's prompt to have ended it, nothing typed since, and the
 * accessibility tree there to begin with — screenreader mode was switched on at boot
 * and this toggles it off and on again.
 * Leaves: the plugin listing on screen, the tree back on and the line cleared. None of
 * this prints `hledger-anywhere`, so the banner count the reload scenario waits for
 * does not move.
 */
async function pluginsAndScreenreader({ tab }) {
  // The surfaces the upload chain leaves undriven: the registry's own listing, the
  // accessibility tree the `screenreader` command moves, and the third way a file
  // arrives — dropped on the page rather than picked or opened. Each is asserted by
  // the words the code itself formats (`plugin_list`, `set_screen_reader`,
  // `files_arrived`) or by the DOM the code itself creates.

  await run('the plugins are listed with their summaries', async () => {
    await tab.type('plugins');
    await tab.enter();
    // `plugin_list` (src/terminal/messages.rs) heads the list with `count` and
    // the word `installed`, then one row per plugin as `  {name:<14}  {summary}`
    // — the name padded to fourteen columns, two spaces, the summary — then the
    // repositories section and the line that says how to read them again. There
    // is no group column here: the group is the help's (`help_entries`), and
    // this listing prints name and summary alone.
    const header = '3 plugins, installed';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(header)})`, 'the plugin listing to be drawn');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const row = (name, summary) => `${name.padEnd(14)}  ${summary}`;
    const said = [
      row('chart', "chart hledger's numbers in a window: chart [options] <type> [query]"),
      // `edit` is one of hledger's own words (HLEDGER_COMMANDS), so `list_plugins`
      // replaces the manifest's summary with `shadowing_note`'s: the summary, then
      // how to reach hledger's own instead.
      row('edit', "edit a loaded journal in a window; hledger edit still runs hledger's own"),
      row('reconcile', 'check an account against a statement, in a window'),
    ];
    for (const line of said) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line of the listing`);
    }
    // The repositories section, from the bundled repository `BUNDLED_REPOSITORIES`
    // names and the flag `plugin_list` marks it with.
    if (!lines.includes('Repositories')) throw new Error('the repositories section is not headed');
    if (!lines.includes('/plugins/plugins.json  bundled')) {
      throw new Error('the bundled repository is not listed as bundled');
    }
    if (!lines.includes('plugins reload reads them again; plugins remove <url> forgets one.')) {
      throw new Error('the listing does not say how to read the repositories again');
    }
  });

  await run('screenreader off takes the accessibility tree away and on brings it back', async () => {
    const tree = "document.querySelectorAll('.xterm-accessibility-tree > div').length";
    if (!(await tab.eval(`${tree} > 0`))) throw new Error('the accessibility tree is not there to begin with');
    await tab.type('screenreader off');
    await tab.enter();
    // `set_screen_reader` (src/app.rs) moves xterm's option first — which is what
    // disposes the AccessibilityManager and takes its rows out of the page — and
    // only then announces, so by the time the words are on screen the tree is
    // already gone. Both are waited for: the sentence `set_screen_reader` writes,
    // and the empty tree that sentence is written over.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('The accessibility tree is now off.')`,
      'the switch off to be announced',
    );
    await tab.until(`${tree} === 0`, 'the accessibility tree to be removed');
    const off = await tab.eval(tree);

    await tab.type('screenreader on');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.includes('The accessibility tree is now on. A screen reader can now read the terminal line by line.')`,
      'the switch on to be announced',
    );
    await tab.until(`${tree} > 0`, 'the accessibility tree to come back');
    const on = await tab.eval(tree);

    // The run reads the terminal to do any of this, and every step below reads it
    // too: a mode that took the rows with it would fail here rather than later.
    const text = await tab.read();
    if (!text.trimEnd().endsWith('»')) {
      throw new Error(`the last line reads ${JSON.stringify(text.trimEnd().split('\n').pop())}`);
    }
    console.log(`note the accessibility tree held ${on} rows on and ${off} off`);
  });
}

/**
 * Install a repository this server itself serves, list it, then forget it.
 *
 * Needs: the plugin listing the scenario above drew — three installed, the bundled
 * repository among them — an empty line at the prompt, and `serve` answering for
 * `PROBE_REPOSITORY`.
 * Leaves: the registry and the settings record back as the listing found them — the
 * three bundled plugins, no remembered repository — with the line at the prompt.
 * `round25probe` and its repository are this scenario's own, and nothing after it
 * lists plugins or completions. None of this prints `hledger-anywhere`, so the banner
 * count the reload scenario waits for does not move; the font and the theme are
 * untouched.
 */
async function addAndForgetARepository({ tab }) {
  // The registry's own install path, driven the way a visitor drives it: a manifest
  // fetched over HTTP (assets/js/plugins.js `fetchManifest` → plugins::loader::fetch),
  // parsed and checked by `Registry::install` (src/plugins/mod.rs), remembered by
  // `add_repository` (src/app.rs) — and then `forget_repository` taking it back. What
  // only a browser can show is the fetch reaching this run's server and the listing
  // growing and shrinking around it.

  await run('plugins add reads the repository and registers its plugin', async () => {
    await tab.type(`plugins add ${PROBE_REPOSITORY}`);
    await tab.enter();
    // `plugin_installed` (src/terminal/messages.rs): how many registered, the
    // repository by the name it was given, and the plugin's own name — then the
    // sentence `add_repository` says once, when a repository is added.
    const read = `Read 1 plugin from ${PROBE_REPOSITORY}: round25probe.`;
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(read)})`, 'the repository to be read');
    const warning = 'A plugin is code running in this page, so install repositories you trust.';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(warning)})`, 'the warning about plugins');
    // `settle` draws the prompt under the message; the listing below types into it.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the add');
  });

  await run('the listing shows the added plugin and its repository', async () => {
    await tab.type('plugins');
    await tab.enter();
    // `plugin_list` heads with `count` and `installed`: four now, where the scenario
    // above saw three. The row is the same `{name:<14}  {summary}` format it asserted,
    // and the repositories section carries the new URL without the `bundled` flag —
    // `plugin_list` gives that to `BUNDLED_REPOSITORIES` alone.
    await tab.until(`(${READ_TERMINAL}).text.includes('4 plugins, installed')`, 'the listing to grow');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const row = `${'round25probe'.padEnd(14)}  round25probe: a repository this check added and then forgot`;
    if (!lines.includes(row)) throw new Error(`${JSON.stringify(row)} is not a line of the listing`);
    if (!lines.includes(PROBE_REPOSITORY)) throw new Error('the repository is not in the listing');
  });

  await run('plugins remove forgets the repository', async () => {
    await tab.type(`plugins remove ${PROBE_REPOSITORY}`);
    await tab.enter();
    // `plugin_removed` for the one plugin that came from it — not the `Nothing was
    // installed from {url}.` a repository with no plugins behind it would get.
    const said = `Forgot 1 plugin that came from ${PROBE_REPOSITORY}.`;
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(said)})`, 'the repository to be forgotten');
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the remove');
  });

  await run('the listing is back to the bundled three', async () => {
    await tab.type('plugins');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === '3 plugins, installed')`,
      'the listing to shrink back',
    );
    // Read from the forget message down, so the listings drawn before it cannot stand
    // in for this one: the header, then neither of this scenario's own lines — the
    // plugin's row and the bare repository path, both matched whole. The echoes of the
    // add and remove commands still hold the URL, and neither is a line of the listing.
    const text = await tab.read();
    const after = text.slice(text.lastIndexOf('Forgot 1 plugin that came from'));
    const lines = after.split('\n').map((line) => line.trim());
    if (!lines.includes('3 plugins, installed')) throw new Error('the listing header is not on screen');
    const row = `${'round25probe'.padEnd(14)}  round25probe: a repository this check added and then forgot`;
    if (lines.includes(row)) throw new Error('the added plugin is still in the listing');
    if (lines.includes(PROBE_REPOSITORY)) throw new Error('the repository is still in the listing');
  });
}

/**
 * Read a repository again after its manifest changed underneath it.
 *
 * Needs: the probe repository added and forgotten by the scenario above, so the listing
 * is the bundled three with no remembered repository, and `serve` answering for
 * `PROBE_REPOSITORY`, whose manifest this scenario changes in place.
 * Leaves: the registry and the settings record back as the listing found them — the
 * three bundled plugins, no remembered repository — with the line at the prompt, and
 * `serve` answering with the manifest it started with. Nothing after this scenario lists
 * plugins or fetches `PROBE_REPOSITORY` until the scenario below adds that repository
 * back to run the plugin its manifest names. None of this prints `hledger-anywhere`, so
 * the banner count the reload scenario waits for does not move; the font and the theme
 * are untouched.
 */
async function reloadAfterTheManifestChanged({ tab }) {
  // `plugins reload` (app.rs `reload_plugins`) forgets every remembered repository, runs
  // `loader::reset` so a module added since is imported when it runs, and reads each
  // manifest again through `install_repository`. What only a browser can show is the
  // fetch reaching this run's server a second time and the listing turning over: the
  // plugin renamed and its summary rewritten, with the stale one gone rather than left
  // beside the new one. `cargo test` holds the registry's half of that
  // (src/plugins/mod.rs) and dispatch.rs holds the decision; this holds the chain.

  const read = `Read 1 plugin from ${PROBE_REPOSITORY}: round25probe.`;
  const forgot = `Forgot 1 plugin that came from ${PROBE_REPOSITORY}.`;
  const staleRow = `${'round25probe'.padEnd(14)}  round25probe: a repository this check added and then forgot`;
  const freshRow = `${'round26reload'.padEnd(14)}  round26reload: the same repository read again with a changed manifest`;

  await run('plugins add reads the repository while its manifest still says round25probe', async () => {
    await tab.type(`plugins add ${PROBE_REPOSITORY}`);
    await tab.enter();
    // `plugin_installed` (src/terminal/messages.rs) says the same sentence the scenario
    // above said for the same manifest, so this run's copy is counted rather than
    // matched: two now, where the screen held one.
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(read)}).length - 1 >= 2`,
      'the repository to be read again',
    );
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the add');
  });

  await run('the listing shows the plugin as the manifest first wrote it', async () => {
    await tab.type('plugins');
    await tab.enter();
    // The row is on screen once from the scenario above; a second copy can only be this
    // listing, and reading it from the end of this add's own message keeps the earlier
    // listing from standing in for this one.
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(staleRow)}).length - 1 >= 2`,
      'the listing to show the added plugin',
    );
    const text = await tab.read();
    const lines = text.slice(text.lastIndexOf(read)).split('\n').map((line) => line.trim());
    if (!lines.includes('4 plugins, installed')) throw new Error('the listing header is not after this add');
    if (!lines.includes(staleRow)) throw new Error(`${JSON.stringify(staleRow)} is not a line of the listing`);
    if (!lines.includes(PROBE_REPOSITORY)) throw new Error('the repository is not in the listing');
  });

  await run('plugins reload reads the changed manifest', async () => {
    // The same URL, the same repository, a manifest that renamed its only plugin.
    PROBE_MANIFEST_SERVED = PROBE_MANIFEST_RENAMED;
    await tab.type('plugins reload');
    await tab.enter();
    // `reload_plugins` prints no line of its own when every repository reads: `submit`
    // has already ended the typed line, and `settle` is what draws the prompt back under
    // it. The prompt returning is therefore all the reload itself says, and it cannot be
    // there before the reload finishes, because the typed line is what the screen ends
    // with until then.
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the reload');
  });

  await run('the listing shows only what the changed manifest lists', async () => {
    await tab.type('plugins');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.includes(${JSON.stringify(freshRow)})`,
      'the reloaded plugin to be listed',
    );
    // Read from this listing's own header: it is the last one on screen, and neither of
    // this scenario's earlier listings can stand in for it. The stale row was written
    // once above and must not have been written again.
    const text = await tab.read();
    const lines = text
      .slice(text.lastIndexOf('4 plugins, installed'))
      .split('\n')
      .map((line) => line.trim());
    if (!lines.includes('4 plugins, installed')) throw new Error('the listing header is not on screen');
    if (!lines.includes(freshRow)) throw new Error(`${JSON.stringify(freshRow)} is not a line of the listing`);
    if (lines.includes(staleRow)) throw new Error('the plugin the manifest renamed is still in the listing');
    if (!lines.includes(PROBE_REPOSITORY)) throw new Error('the repository is not in the listing');
  });

  await run('plugins remove forgets the repository again', async () => {
    await tab.type(`plugins remove ${PROBE_REPOSITORY}`);
    await tab.enter();
    // `plugin_removed` for the one plugin that came from it, the same sentence the
    // scenario above saw, so it is counted rather than matched.
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(forgot)}).length - 1 >= 2`,
      'the repository to be forgotten again',
    );
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the remove');
    PROBE_MANIFEST_SERVED = PROBE_MANIFEST;
  });

  await run('the listing is back to the bundled three', async () => {
    await tab.type('plugins');
    await tab.enter();
    // This scenario's own forget message is the marker: the listing drawn after it is
    // this one, holding the header and neither of this scenario's rows.
    await tab.until(
      `(${READ_TERMINAL}).text.lastIndexOf('3 plugins, installed') > (${READ_TERMINAL}).text.lastIndexOf(${JSON.stringify(forgot)})`,
      'the listing to shrink back',
    );
    const text = await tab.read();
    const lines = text
      .slice(text.lastIndexOf(forgot))
      .split('\n')
      .map((line) => line.trim());
    if (!lines.includes('3 plugins, installed')) throw new Error('the listing header is not on screen');
    if (lines.includes(staleRow)) throw new Error('the renamed plugin is still in the listing');
    if (lines.includes(freshRow)) throw new Error('the reloaded plugin is still in the listing');
    if (lines.includes(PROBE_REPOSITORY)) throw new Error('the repository is still in the listing');
  });
}

/**
 * Run the probe repository's own plugin, from the module its manifest names.
 *
 * Needs: the probe repository added and forgotten by the scenarios above — so the registry
 * is the bundled three and `serve` answers for `PROBE_REPOSITORY` with `PROBE_MANIFEST`
 * again — the uploaded journal still loaded with no folder open (`open`'s fallback mounts
 * one later, and nothing before it opens a folder), and the line at the prompt.
 * Leaves: the registry as the remove left it — the three bundled plugins, no remembered
 * repository — plus the one setting the plugin remembered, with the line at the prompt.
 * None of this prints `hledger-anywhere`, so the banner count the reload scenario waits
 * for does not move; the font and the theme are untouched.
 */
async function runTheProbePlugin({ tab }) {
  // The chain no other step here reaches: a word classify gives to hledger
  // (src/terminal/commands.rs) handed by dispatch to the registry's owner
  // (src/dispatch.rs `Effect::RunPlugin`), `run_plugin` building the host (src/app.rs
  // `host`), the loader importing the module over this run's server and awaiting it
  // (src/plugins/loader.rs `run`, assets/js/plugins.js `run`), and the plugin's own
  // calls coming back as `host.say` lines. `cargo test` holds the dispatch decision and
  // `scripts/check-host-contract.mjs` holds the shape of the API; what only a browser
  // can show is the whole of it running, with real files and the real engine behind it.

  const read = `Read 1 plugin from ${PROBE_REPOSITORY}: round25probe.`;
  const forgot = `Forgot 1 plugin that came from ${PROBE_REPOSITORY}.`;

  await run('plugins add reads the repository whose module is about to run', async () => {
    await tab.type(`plugins add ${PROBE_REPOSITORY}`);
    await tab.enter();
    // The same sentence the two scenarios above said for this manifest, so it is counted
    // rather than matched: three now, where the screen held two.
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(read)}).length - 1 >= 3`,
      'the repository to be read a third time',
    );
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the add');
  });

  await run('the plugin word runs the module its manifest names', async () => {
    const before = await tab.read();
    const quoted = occurrences(before, 'expenses:round17test');
    await tab.type('round25probe');
    await tab.enter();
    // The module's first line, through `host.say`: it carries the plugin's own name and
    // the `args` the loader handed over, so nothing but this module's `run` writing them
    // — reached by importing `PROBE_MODULE` — can put it on screen.
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === 'round25probe: run("") as round25probe')`,
      'the module to be imported and run',
      20000,
    );

    // `host.hledger` (src/app.rs `host` → `host_run`) runs `balance` over the loaded
    // files and resolves with its stdout, which reaches a screen only by the plugin
    // saying it: the row that names the upload fixture is in the line it says, so a
    // screen holding one more copy of that account than it did above is a screen the
    // engine's answer reached.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('round25probe: hledger said ')`,
      'the plugin to say what hledger answered',
    );
    const said = await tab.read();
    if (occurrences(said, 'expenses:round17test') <= quoted) {
      throw new Error('the plugin said what hledger answered, but no copy of the fixture account was added to the screen');
    }

    // `remember` writes the plugin's own settings and `setting` reads them back
    // (src/app.rs `host`): the line holds the value the plugin read, so `null` here
    // would be a round-trip that lost it.
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === 'round25probe: setting read back on')`,
      'the setting to round-trip',
    );

    // `host.files` (src/app.rs `host_files`): with no folder open every loaded file is
    // read-only, and the list holds the journal the upload mounted — no folder, no
    // writable entry, and nothing else is loaded at this point in the run.
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === 'round25probe: files round17.journal read-only')`,
      'host.files to list the loaded journal read-only',
    );

    // `host.read` (src/app.rs `host_read`) answers with the text itself, synchronously:
    // the line holds what the plugin found in the file, and the fixture account can
    // only be there if the loaded file's contents came back.
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === 'round25probe: read held the fixture')`,
      'host.read to hand back the loaded file',
    );

    // `host.refresh` (src/app.rs `host_refresh`) with no folder open answers the empty
    // report rather than an error: no folder, nothing to re-read, and never a rejection.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('round25probe: refresh {"changed":[],"missing":[]}')`,
      'host.refresh to answer an empty report with no folder open',
    );

    // `host.save` (src/app.rs `host` → `host_save`) with no folder open has to refuse at
    // its first branch, and the refusal comes back as the `{error: "..."}` the docs
    // promise rather than a rejection. Asserted verbatim: these are the app's own words
    // (SAVE_REFUSAL), reached here only because the plugin asked to write a file.
    await tab.until(
      `(${READ_TERMINAL}).text.includes(${JSON.stringify(SAVE_REFUSAL)})`,
      'host.save to refuse with no folder open',
    );
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const saving = lines.find((line) => line.startsWith('round25probe: save answered '));
    if (!saving) throw new Error('the plugin did not say what host.save answered');
    if (!saving.includes(SAVE_REFUSAL)) {
      throw new Error(`${JSON.stringify(saving)} does not hold ${JSON.stringify(SAVE_REFUSAL)} verbatim`);
    }

    // The loader awaits the module and `run_plugin` settles after it, so the prompt is
    // what says the whole run finished rather than dying partway through it.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('»')`,
      'the prompt to come back after the plugin ran',
    );
  });

  await run('plugins remove forgets the repository the module came from', async () => {
    await tab.type(`plugins remove ${PROBE_REPOSITORY}`);
    await tab.enter();
    // The same sentence the scenarios above said twice, so it is counted rather than
    // matched: three now, where the screen held two. Nothing after this scenario lists
    // plugins, so this is what leaves the registry as the scenarios before it found it.
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(forgot)}).length - 1 >= 3`,
      'the repository to be forgotten a third time',
    );
    await tab.until(`(${READ_TERMINAL}).text.trimEnd().endsWith('»')`, 'the prompt to come back after the remove');
  });
}

/**
 * Throw the drop fixture at the page, mark it as the drop target, and read the report
 * back from the file the drop handed over.
 *
 * Needs: the page's drop listener (bound at boot) and `expenses:round18drop` and
 * `$84.25` not yet on screen — the first read confirms that rather than assuming it.
 * Leaves: `round18.journal` mounted as the main file with the prompt naming it and its
 * report on screen. Like the scenario above it, this prints no `hledger-anywhere`, so
 * the banner count the reload scenario waits for does not move.
 */
async function dropAJournal({ tab }) {
  await run('a dropped journal arrives and the page marks the drop', async () => {
    const before = await tab.read();
    // Nothing earlier in the session can have written either string: the fixture
    // above is their only copy, so a report holding them can only have come from
    // the file the drop handed over.
    if (occurrences(before, 'expenses:round18drop')) throw new Error('the drop fixture account was already on screen');
    if (occurrences(before, '$84.25')) throw new Error('the drop fixture amount was already on screen');

    // `drop_target` (src/app.rs) binds ONE listener to `document` for dragover,
    // dragleave and drop, and decides whether a drag carries files from
    // `dataTransfer.types` — a DataTransfer holding a file lists `Files`, and a
    // text selection being moved lists nothing, which is the case the handler
    // leaves alone. The dragover is what marks the page (`body.drop-target`,
    // assets/css/app.css), the drop unmarks it and takes the files, so both
    // events are dispatched on `document`, the element the listener is bound to,
    // each with its own transfer holding the fixture.
    const marked = await tab.eval(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(DROP_JOURNAL)}], 'round18.journal'));
      document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return document.body.classList.contains('drop-target');
    })()`);
    if (!marked) throw new Error('the dragover did not mark the page as the drop target');

    const stillMarked = await tab.eval(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(DROP_JOURNAL)}], 'round18.journal'));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return document.body.classList.contains('drop-target');
    })()`);
    if (stillMarked) throw new Error('the drop left the page marked as the drop target');

    // `accept_files` says `Dropped` where the upload step heard `Uploaded`: the
    // same `files_arrived` lines, the source swapped, one row for the one file
    // that mounted, and the sentence naming the file `choose_main` picked.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('Dropped 1 file.')`,
      'the dropped file to arrive',
      15000,
    );
    const text = await tab.read();
    const lines = text.split('\n').map((line) => line.trim());
    for (const line of ['Dropped 1 file.', 'round18.journal']) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line on screen`);
    }
    if (!text.includes('Reading round18.journal. Type balance for a report, or ? for the rest.')) {
      throw new Error('the arrival message does not name the file hledger reads');
    }
  });

  await run('the engine reads the dropped journal', async () => {
    const before = await tab.read();
    // `accept_files` replaced the loaded files and `configure` re-exported
    // `$LEDGER_FILE`, so a report holding the fixture's account can only have
    // been drawn from the file the drop handed over.
    if (occurrences(before, 'expenses:round18drop')) throw new Error('the drop fixture account was already on screen');
    if (occurrences(before, '$84.25')) throw new Error('the drop fixture amount was already on screen');
    const rules = occurrences(before, '--------------------');
    await tab.type('balance --tree');
    await tab.enter();
    // A fresh rule means a report was drawn, and the row under it says which
    // journal it was drawn from.
    await tab.until(
      `(${READ_TERMINAL}).text.split('expenses:round18drop').length - 1 > 0`,
      'the report from the dropped journal',
    );
    const after = await tab.read();
    if (occurrences(after, '--------------------') <= rules) throw new Error('no fresh report rule was drawn');
    if (!after.includes('$84.25')) throw new Error('the drop fixture amount is not in the report');
  });

  await run('the prompt names the dropped journal', async () => {
    // `prompt_for` dims the basename of the file being read, and `announce`
    // redraws the prompt under every report, so the last row is the dropped
    // file's name rather than the uploaded one's.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('round18.journal »')`,
      'the prompt to name the dropped journal',
    );
  });
}

/**
 * Write a report into the engine's filesystem with `-o`, read it back out with
 * `download`, and refuse a name nothing wrote.
 *
 * Needs: `downloads` for the bytes to land in, and the browser's download events
 * listened for before anything asks for one — nothing has asked for a download yet, so
 * the listener counts every event from the first click on.
 * Leaves: `round19.csv` in the engine's filesystem and on disk in `downloads`, byte for
 * byte `REPORT_CSV`, exactly one download begun, and the listener removed. None of the
 * three prints `hledger-anywhere`, so the banner count the reload scenario waits for
 * does not move.
 */
async function writeAndDownload({ tab, launched, downloads }) {
  // A report the screen would have to cut is written into the engine's own filesystem
  // with `-o`, `download` reads it back and hands it to the browser, and real bytes land
  // on disk — plus the refusal for a name nothing wrote.

  // The browser's download events, listened for before anything asks for a
  // download: `downloadWillBegin` says which file was offered, `downloadProgress`
  // with `state: completed` says the browser finished it. Both stay registered
  // through the refusal below, which asserts that no second download started.
  let downloadBegun = null;
  let downloadCompleted = false;
  let downloadStarts = 0;
  const watchingDownloads = launched.cdp.on((message) => {
    if (message.method === 'Browser.downloadWillBegin') {
      downloadStarts += 1;
      downloadBegun = message.params || {};
    }
    if (message.method === 'Browser.downloadProgress'
        && (message.params || {}).state === 'completed') {
      downloadCompleted = true;
    }
  });

  // What `-o` announced, as a number: the note counts the bytes it wrote, and
  // the same count has to be on the file the download below leaves behind.
  let writtenBytes = 0;

  await run('a report written with -o is announced with its name and size', async () => {
    await tab.type('balance -O csv -o round19.csv');
    await tab.enter();
    // `finish` → `record_writes` (src/app.rs) is the whole of this run's
    // output: hledger's stdout is empty because the report went to the file,
    // so what is on screen is `wrote_note` (src/terminal/messages.rs) and
    // nothing else — `[wrote {path} ({size}). Take a copy with download {path}
    // while this visit lasts]`, the size in `bytes_label`'s own words.
    const note = /\[wrote round19\.csv \((\d+) bytes\)\. Take a copy with download round19\.csv while this visit lasts\]/;
    await tab.until(`(${READ_TERMINAL}).text.match(${note})`, 'the write to be announced');
    writtenBytes = Number(note.exec(await tab.read())[1]);
    // The note counts what the run wrote; the report above is what has to come
    // back out of it, and the two numbers are the same or this chain is a lie.
    if (writtenBytes !== Buffer.byteLength(REPORT_CSV)) {
      throw new Error(`the note says ${writtenBytes} bytes, the report is ${Buffer.byteLength(REPORT_CSV)}`);
    }
  });

  await run('download saves the whole report to disk', async () => {
    // Somewhere for it to land, named before the click that starts it, with
    // events on so "it finished" is the browser's own word rather than a
    // deadline. `Browser.setDownloadBehavior` is the level that still has it;
    // `Page.setDownloadBehavior` was taken away.
    await launched.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true,
    });

    downloadBegun = null;
    downloadCompleted = false;
    const before = downloadStarts;

    await tab.type('download round19.csv');
    await tab.enter();
    // `App::download` → `save_to_disk` (src/app.rs): the file out of `written`
    // as a blob URL behind an anchor click, and this is what it says first —
    // `Saving {path} ({size} bytes). Check your downloads.`
    const saving = `Saving round19.csv (${writtenBytes} bytes). Check your downloads.`;
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(saving)})`, 'the save to be announced');

    // The announcement is the click, not the bytes: what is waited for is the
    // browser saying the download completed AND a file of the size the note
    // promised being readable in the directory it was given.
    let bytes = null;
    try {
      await until('the download to land as round19.csv', async () => {
        if (!(downloadStarts > before && downloadCompleted)) return false;
        try {
          bytes = await readFile(join(downloads, 'round19.csv'));
        } catch {
          return false; // still on its way
        }
        return Boolean(bytes);
      });
    } catch (error) {
      // What the browser had said by then, beside the wait's own name.
      throw new Error(
        `${error.message}: begun=${JSON.stringify(downloadBegun)} completed=${downloadCompleted} bytes=${bytes && bytes.length}`,
      );
    }

    // The name the browser was offered, which is the name the anchor set
    // (`save_to_disk` keeps only the last path segment).
    if (!downloadBegun || downloadBegun.suggestedFilename !== 'round19.csv') {
      throw new Error(`the download began as ${JSON.stringify(downloadBegun && downloadBegun.suggestedFilename)}`);
    }
    // The bytes: the CSV the engine writes for the dropped journal, header
    // first and the drop's own row under it, whole — the report `-o` put in
    // the mount is the report that reaches the disk.
    if (bytes.length !== writtenBytes) {
      throw new Error(`the file holds ${bytes.length} bytes, the note said ${writtenBytes}`);
    }
    const saved = bytes.toString('utf8');
    if (!saved.startsWith('"account","balance"\n')) throw new Error(`the header reads ${JSON.stringify(saved.split('\n')[0])}`);
    if (!saved.includes('"expenses:round18drop","$84.25"')) throw new Error('the drop fixture row is not in the file');
    if (saved !== REPORT_CSV) throw new Error(`the file reads ${JSON.stringify(saved)}`);
    console.log(`note the download landed as ${bytes.length} bytes in ${downloads}`);
  });

  await run('a file that was never written is refused by name', async () => {
    await tab.type('download no-such-file.csv');
    await tab.enter();
    // `App::download` (src/app.rs) with nothing of that name in `written`: the
    // refusal names the file, then `download_list` (src/terminal/messages.rs)
    // lists what there is instead — this session has written one file, so it
    // is the list of names rather than the empty "nothing has been written
    // yet" sentence.
    const refusal = 'Nothing called no-such-file.csv was written.';
    await tab.until(`(${READ_TERMINAL}).text.includes(${JSON.stringify(refusal)})`, 'the refusal to be announced');
    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    // Each of them a line of its own, as `download_list` writes them: the
    // header, the one file this session did write, and the sentence saying
    // how to save one.
    const said = [
      'Nothing called no-such-file.csv was written.',
      'Written by commands this session:',
      'round19.csv',
      'Save one with download <path>.',
    ];
    for (const line of said) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line of the refusal`);
    }
    // A refusal is not a download: nothing was handed to the browser for the
    // name that does not exist.
    if (downloadStarts !== 1) {
      throw new Error(`${downloadStarts} downloads began, expected only the one for round19.csv`);
    }
    watchingDownloads();
  });
}

/**
 * Take `open` down its fallback — the folder picker with no File System Access API —
 * and read from the folder it mounts read-only.
 *
 * Needs: the folder `openFixtures` wrote inside `fixtures`, `launched`'s CDP session
 * to intercept the directory chooser with (the same wiring the upload step uses), and
 * `expenses:round24open` and `$63.50` not yet on screen — the first read confirms that
 * rather than assuming it. `open` replaces the loaded files exactly as `upload` did, so
 * nothing after this scenario needs the ones it takes away.
 * Leaves: `hledger.journal` and `prices/x.journal` mounted with the prompt naming the
 * first, the fixture's account and amount on screen from a fresh report, and `reopen`'s
 * refusal under them. The page's `showDirectoryPicker` is deleted and left deleted: no
 * later step opens *that* picker — the cancel scenario below runs `upload`, which takes
 * the plain file input — and `clear` and the reloads open nothing, while every reload
 * the reload scenario performs mounts a fresh page where the method is back, so the
 * deletion needs no putting back. Nothing here prints `hledger-anywhere`, so the banner
 * count that scenario waits for does not move; the font and the theme are untouched.
 */
async function openAFolderReadOnly({ tab, launched, fixtures }) {
  // The branch `fs_access::available()` is for: without the File System Access API no
  // directory handle can be kept, so `App::open` says the folder loads read-only and
  // hands the same job to `upload::Mode::Directory` — the fallback the help promises
  // ("A browser without the File System Access API falls back to a read-only folder
  // picker") and the one no other check drives. What only a real browser run can show
  // is the whole chain: the method's absence read as absence, the dialog opened from
  // inside the Enter handler, a directory handed back through it with its paths inside
  // it intact, and the engine reading the journal that arrived.

  await run('the folder api is taken away and open mounts the folder read-only', async () => {
    const folder = await openFixtures(fixtures);

    // `fs_access::available()` (src/fs_access.rs) is a secure context — this page is
    // served over localhost, so that half is already true — plus `Reflect.has(window,
    // 'showDirectoryPicker')`, which the method answers as its own property here. The
    // delete is the whole trigger, and both halves are checked so a build that never
    // had the method fails under this label rather than passing for the wrong reason.
    const api = await tab.eval(`(() => {
      const before = Reflect.has(window, 'showDirectoryPicker');
      delete window.showDirectoryPicker;
      return { before, after: Reflect.has(window, 'showDirectoryPicker') };
    })()`);
    if (!api.before) throw new Error('showDirectoryPicker was not on the window to take away');
    if (api.after) throw new Error('showDirectoryPicker is still on the window after the delete');

    // The upload step's interception, unchanged in shape: headless cannot show the
    // directory dialog either, so the click's `Page.fileChooserOpened` is where the
    // fallback's own `<input type=file webkitdirectory>` gets caught.
    let chooser = null;
    const watching = launched.cdp.on((message) => {
      if (message.sessionId === tab.sessionId && message.method === 'Page.fileChooserOpened') {
        chooser = message.params || {};
      }
    });
    let handed = 'the intercepted file chooser';
    try {
      let intercepted = true;
      try {
        await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
      } catch {
        intercepted = false;
      }
      await tab.type('open');
      await tab.enter();
      // The sentence `App::open` prints before it opens the dialog: it is what says
      // the delete above was read as an absent API rather than the dialog merely
      // failing to open.
      await tab.until(
        `(${READ_TERMINAL}).text.includes('This browser cannot open a folder for editing, so open loads it read-only.')`,
        'the fallback to be announced',
      );
      if (intercepted) await until('the intercepted file chooser to open', () => chooser, { timeoutMs: 15000 });
      if (chooser && chooser.backendNodeId) {
        // The directory itself, not the files in it: `DOM.setFileInputFiles` expands
        // it into the `webkitRelativePath`s a real pick carries — `journal/
        // hledger.journal` and `journal/prices/x.journal` here — which is what
        // `Mode::Directory` reads and `strip_common_root` (src/journal.rs) shortens.
        await tab.send('DOM.setFileInputFiles', { files: [folder], backendNodeId: chooser.backendNodeId });
      } else {
        // No chooser event: the input `open_picker` made is still on the page, so
        // the same two files are built onto it with those paths and the `change`
        // the picker waits on is dispatched by hand.
        handed = 'an in-page change event, because no chooser opened';
        const failed = await tab.eval(`(() => {
          const input = document.getElementById('hledger-anywhere-upload-input');
          if (!input) return 'the upload input is not on the page';
          const transfer = new DataTransfer();
          const pairings = ${JSON.stringify([
            ['journal/hledger.journal', OPEN_JOURNAL],
            ['journal/prices/x.journal', OPEN_PRICES],
          ])};
          for (const [path, contents] of pairings) {
            const file = new File([contents], path.slice(path.lastIndexOf('/') + 1));
            Object.defineProperty(file, 'webkitRelativePath', { value: path });
            transfer.items.add(file);
          }
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));
          return '';
        })()`);
        if (failed) throw new Error(failed);
      }
    } finally {
      watching();
    }

    // The same settle as the upload step: whether the files went in with the browser's
    // own `change` or the one dispatched above, the input still being on the page says
    // the selection has not been read yet.
    const arrived = `(${READ_TERMINAL}).text.includes('Uploaded 2 files.')`;
    try {
      await tab.until(arrived, 'the opened files to arrive', 15000);
    } catch {
      const waiting = await tab.eval("Boolean(document.getElementById('hledger-anywhere-upload-input'))");
      if (!waiting) throw new Error('the selection was read, but the arrival message never printed');
      handed += '; a change event was dispatched for it';
      await tab.eval("document.getElementById('hledger-anywhere-upload-input').dispatchEvent(new Event('change'))");
      await tab.until(arrived, 'the opened files to arrive after the change event');
    }
    if (handed !== 'the intercepted file chooser') console.log(`note the files were handed over by ${handed}`);

    // Every line `files_arrived` (src/terminal/messages.rs) writes for this mount: the
    // source is `accept_files`' `"Uploaded"` even down this branch, the paths are the
    // folder's own contents with `journal/` stripped off — `prices/x.journal` is the
    // row that says the subfolder survived — and the last line names the file
    // `choose_main` picked, by its conventional name rather than the subfolder's.
    const text = await tab.read();
    const lines = text.split('\n').map((line) => line.trim());
    for (const line of ['Uploaded 2 files.', 'hledger.journal', 'prices/x.journal']) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line on screen`);
    }
    if (!text.includes('Reading hledger.journal. Type balance for a report, or ? for the rest.')) {
      throw new Error('the arrival message does not name the file hledger reads');
    }
  });

  await run('the engine reads the journal in the opened folder', async () => {
    const before = await tab.read();
    // Nothing earlier in the session can have written either string: the fixture
    // above is their only copy, so a report holding them can only have been drawn
    // from the folder the picker mounted.
    if (occurrences(before, 'expenses:round24open')) throw new Error('the open fixture account was already on screen');
    if (occurrences(before, '$63.50')) throw new Error('the open fixture amount was already on screen');
    const rules = occurrences(before, '--------------------');
    await tab.type('balance --tree');
    await tab.enter();
    // A fresh rule means a report was drawn, and the rows under it say which
    // journal it was drawn from: `accept_files` replaced the loaded files and
    // `configure` re-exported `$LEDGER_FILE`, so the engine can only reach this
    // account if both moved to the file from the folder.
    await tab.until(
      `(${READ_TERMINAL}).text.split('expenses:round24open').length - 1 > 0`,
      'the report from the opened journal',
    );
    const after = await tab.read();
    if (occurrences(after, '--------------------') <= rules) throw new Error('no fresh report rule was drawn');
    if (!after.includes('$63.50')) throw new Error('the open fixture amount is not in the report');
  });

  await run('the prompt names the opened journal', async () => {
    // `prompt_for` dims the basename of the file being read, and `announce` redraws
    // the prompt under the arrival message and under every report since — so the last
    // row is the folder's own journal rather than the dropped one it replaced.
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith('hledger.journal »')`,
      'the prompt to name the opened journal',
    );
  });

  await run('reopen says there is no remembered folder', async () => {
    await tab.type('reopen');
    await tab.enter();
    // The fallback never kept a handle — only the File System Access path remembers
    // one — and a fresh profile starts with none stored, so `reopen` answers from its
    // first branch (app.rs) without asking the browser for anything.
    await tab.until(
      `(${READ_TERMINAL}).text.includes('There is no remembered folder to reopen. open chooses one, and remembers it for next time.')`,
      'reopen to say it has nothing to reopen',
    );
  });
}

/**
 * Follow the engine's worker over CDP: which session it is, and how many times it has
 * fetched the wasm.
 *
 * The page's resource timing never sees into a worker: `performance.getEntriesByType('resource')`
 * on the page holds only the page's own requests (probed against the built app — the engine's
 * fetch is not among them), so a zero there would prove nothing. Every worker target gets a
 * DevTools session of its own, though, and `Runtime.evaluate` in that session answers with the
 * worker's own `performance`, where its fetches do land. The sessions come from
 * `Target.setAutoAttach` on the page's session, which attaches to the worker already running as
 * well as to the one a cancel spawns next — `Target.getTargets` will not name a worker at all,
 * it reports one with an empty URL, and an explicit `Target.attachToTarget` answers but never
 * runs what is sent to it — with `waitForDebuggerOnStart: false` leaving them running. A count
 * is only ever read from a session whose target URL ended in `/js/hledger-worker.js`, so a
 * number from anywhere else cannot pass for "the engine did not fetch".
 */
function followTheEngineWorker(tab, launched) {
  const sessions = new Set();
  const stop = launched.cdp.on((message) => {
    if (message.method === 'Target.attachedToTarget') {
      const info = message.params.targetInfo;
      if (info.type === 'worker' && info.url.endsWith('/js/hledger-worker.js')) {
        sessions.add(message.params.sessionId);
      }
    } else if (message.method === 'Target.detachedFromTarget') {
      sessions.delete(message.params.sessionId);
    }
  });
  const attached = tab.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  /** This worker's own count of engine fetches, waited for then read from the worker. */
  const fetched = async () => {
    await attached;
    await until('the engine worker session to be attached', () => sessions.size === 1);
    const [sessionId] = [...sessions];
    const { result, exceptionDetails } = await launched.cdp.send(
      'Runtime.evaluate',
      {
        expression: `performance.getEntriesByType('resource').filter((entry) => entry.name.includes('hledger.wasm')).length`,
        returnByValue: true,
      },
      sessionId,
    );
    if (exceptionDetails || typeof result.value !== 'number') {
      throw new Error('the engine worker did not answer with its fetch count');
    }
    return result.value;
  };

  return { fetched, stop };
}

/**
 * Cancel a command that is still running, then run the engine again after it, then
 * cancel nothing and clear the line anyway.
 *
 * Needs: the folder `openAFolderReadOnly` mounted — a journal being read, the line
 * empty at the prompt — `launched`'s CDP session to intercept the file chooser with
 * (the same wiring the upload step uses), and `fixtures` to write the slow journal
 * into. The engine has been run all session, so what the timing below waits for is
 * the command itself rather than a first compile. `upload` replaces whatever is
 * loaded, exactly as the upload step did, and no scenario between here and the end
 * needs the folder's files.
 * Leaves: `round27slow.journal` mounted as the main file with the prompt naming it,
 * a `^C` and an `[cancelled]` from the stopped run, a report drawn by the engine
 * that took its place, a second `^C` from the idle line, and the line at the prompt.
 * None of it prints `hledger-anywhere`, so the banner count the reload scenario
 * waits for does not move; the font and the theme are untouched.
 */
async function cancelARunningCommand({ tab, launched, fixtures }) {
  // The last thing the coverage map called "not driven, though a headless run could",
  // both ways Ctrl+C reaches the app: the busy branch of `on_input` (app.rs), which
  // must see the key while a command is still running to write `^C`, take the queued
  // line with `pending.clear()` and throw the worker away (app.rs `cancel` →
  // src/hledger/bridge.rs `cancel` → assets/js/hledger-wasi.js `cancel`, which ends
  // the run as `EngineError::Cancelled` → `[cancelled]` in `finish`); and the idle
  // branch of `handle` (app.rs), which throws a typed line away with nothing running
  // at all. The first one needs a command slow enough to lose the race to the key —
  // `slowJournal` writes that command, sized in its own comment against the engine.

  // Before anything is cancelled: what the running worker has fetched of the engine.
  // The check after the restart counts the same thing in the worker that replaces it,
  // and this is the control that says the counter can see a fetch at all — the page's
  // own resource timing cannot see into a worker, so a bare zero would prove nothing.
  const engine = followTheEngineWorker(tab, launched);
  const fetchedBeforeCancel = await engine.fetched();

  await run('the slow journal arrives and is the file being read', async () => {
    const journal = slowJournal(SLOW_TRANSACTIONS);
    await writeFile(join(fixtures, SLOW_JOURNAL), journal);

    // The upload step's interception, in shape (see that step for the plumbing):
    // headless cannot show the file dialog and wait for a person, so the click's
    // `Page.fileChooserOpened` is where the input the picker opens gets caught.
    let chooser = null;
    const watching = launched.cdp.on((message) => {
      if (message.sessionId === tab.sessionId && message.method === 'Page.fileChooserOpened') {
        chooser = message.params || {};
      }
    });
    let handed = 'the intercepted file chooser';
    try {
      let intercepted = true;
      try {
        await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
      } catch {
        intercepted = false;
      }
      await tab.type('upload');
      await tab.enter();
      if (intercepted) await until('the intercepted file chooser to open', () => chooser, { timeoutMs: 15000 });
      if (chooser && chooser.backendNodeId) {
        await tab.send('DOM.setFileInputFiles', { files: [join(fixtures, SLOW_JOURNAL)], backendNodeId: chooser.backendNodeId });
      } else {
        // No chooser event: the input `open_picker` made is still on the page, so the
        // file this step just wrote is built onto it and the `change` the picker waits
        // on is dispatched by hand. The text goes in whole rather than as an
        // expression, because the point is that the page mounts the very journal the
        // engine was measured against.
        handed = 'an in-page change event, because no chooser opened';
        const failed = await tab.eval(`(() => {
          const input = document.getElementById('hledger-anywhere-upload-input');
          if (!input) return 'the upload input is not on the page';
          const transfer = new DataTransfer();
          transfer.items.add(new File([${JSON.stringify(journal)}], ${JSON.stringify(SLOW_JOURNAL)}));
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));
          return '';
        })()`);
        if (failed) throw new Error(failed);
      }
    } finally {
      watching();
    }

    // Waited for on this step's own words rather than `Uploaded 1 file.`, which has
    // been on screen since the upload step printed it: only this journal's name in
    // the sentence `files_arrived` writes for the file `choose_main` picked is new.
    const arrival = `Reading ${SLOW_JOURNAL}. Type balance for a report, or ? for the rest.`;
    const arrived = `(${READ_TERMINAL}).text.includes(${JSON.stringify(arrival)})`;
    try {
      await tab.until(arrived, 'the uploaded journal to arrive');
    } catch {
      const waiting = await tab.eval("Boolean(document.getElementById('hledger-anywhere-upload-input'))");
      if (!waiting) throw new Error('the selection was read, but the arrival message never printed');
      handed += '; a change event was dispatched for it';
      await tab.eval("document.getElementById('hledger-anywhere-upload-input').dispatchEvent(new Event('change'))");
      await tab.until(arrived, 'the uploaded journal to arrive after the change event');
    }
    if (handed !== 'the intercepted file chooser') console.log(`note the file was handed over by ${handed}`);

    // Every line `files_arrived` (src/terminal/messages.rs) writes for this mount,
    // with the upload step's own message counted rather than matched: it is on screen
    // once from there, and twice only when this upload arrived as well.
    const text = await tab.read();
    const lines = text.split('\n').map((line) => line.trim());
    const said = [
      'Uploaded 1 file.',
      SLOW_JOURNAL,
      arrival,
    ];
    for (const line of said) {
      if (!lines.includes(line)) throw new Error(`${JSON.stringify(line)} is not a line on screen`);
    }
    const uploads = occurrences(text, 'Uploaded 1 file.');
    if (uploads !== 2) {
      throw new Error(`${uploads} copies of 'Uploaded 1 file.' on screen: one from the upload step, one from this one`);
    }
  });

  await run('ctrl+c stops the command that was running', async () => {
    const before = await tab.read();
    // None of these three can be on screen yet: `^C` comes only from the two Ctrl+C
    // arms (app.rs), `[cancelled]` only from a run the worker was thrown away under
    // (app.rs `finish`), and the account exists only in the journal just mounted —
    // and only a report draws it, which is what makes it the proof the run below was
    // stopped before it could print anything.
    if (occurrences(before, '^C')) throw new Error('^C was already on screen');
    if (occurrences(before, '[cancelled]')) throw new Error('[cancelled] was already on screen');
    if (occurrences(before, SLOW_ACCOUNT)) throw new Error(`${SLOW_ACCOUNT} was already on screen`);

    await tab.type('balance');
    await tab.enter();
    // `submit` → `run_with` sets `busy` and the tab title in the same key handler
    // (app.rs), before the Enter key press returns, so the title naming the command
    // is what says the *busy* branch — not the idle one — will read the next key.
    // Polling for it, rather than sleeping: it is written with `busy`.
    await tab.until(`document.title.includes('running balance')`, 'the command to start running');

    // And a line started while the command runs, which the busy branch buffers
    // (app.rs `on_input`, `pending`) instead of dropping. The ^C below has to take it
    // with `pending.clear()`: were the buffer still holding `bal`, `settle` would
    // replay it and draw the prompt over it, so the last line below would read
    // `round27slow.journal » bal` and the prompt assertion would fail on exactly that.
    await tab.type('bal');

    // Ctrl+C, in the shape Ctrl+L and Ctrl+R are sent in above: keyCode 67 for `c`,
    // modifiers 2 for Ctrl, no text — xterm translates the pair to `\u{3}`, which is
    // what app.rs `on_input` matches.
    //
    // The race, as arithmetic rather than as trust: `press` paces every key with a
    // fixed 60 ms (its own definition) and `type` adds a focus and 120 ms per line,
    // so Enter → title gate → `bal` → this key is ~600 ms of input pacing against the
    // 5,360 ms the shipped engine measured for this journal natively (see
    // `slowJournal`). The run's own request is posted on the microtask checkpoint
    // that follows the Enter event — before any further keystroke can be dispatched —
    // so it is in the bridge's pending map by the time this key lands, ~600 ms into a
    // 5,360 ms run. This machine would have to be ~9× faster for the command to win.
    await tab.press('c', { code: 'KeyC', keyCode: 67, modifiers: 2 });

    // The busy branch's three words, in the order the code writes them: `^C` from the
    // key handler itself, `[cancelled]` where `finish` reads the worker's rejection
    // (app.rs: `Err(EngineError::Cancelled) => self.say("[cancelled]")`), and the
    // prompt `settle` draws under both, naming the file the upload mounted — empty,
    // because the buffered line went with the cancel.
    const prompt = `${SLOW_JOURNAL} »`;
    await tab.until(
      `(${READ_TERMINAL}).text.split('\\n').some((line) => line.trim() === '^C')`,
      'the ^C to be written',
    );
    await tab.until(`(${READ_TERMINAL}).text.includes('[cancelled]')`, 'the run to end as cancelled');
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith(${JSON.stringify(prompt)})`,
      'the prompt to come back with the queued line dropped',
    );

    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const mark = lines.indexOf('^C');
    const result = lines.lastIndexOf('[cancelled]');
    if (mark > result) {
      throw new Error('the ^C was written after the result: the key did not land while the command was running');
    }
    if (occurrences(lines.join('\n'), SLOW_ACCOUNT)) {
      throw new Error('the cancelled run drew a report anyway');
    }
  });

  await run('the engine runs the next command after a cancel', async () => {
    // The cancel throws the whole worker away (bridge.rs `cancel`), so what runs next
    // is a rebuilt one: a fresh worker starts with no environment at all, and app.rs
    // `cancel` answers that with `configure` before the next command's own request
    // reaches it. A worker poisoned by the cancellation, or one missing `$LEDGER_FILE`,
    // would draw no report or hledger's complaint about having none — so a real report
    // from the journal still mounted is what says the engine survived.
    const before = await tab.read();
    const rules = occurrences(before, '--------------------');
    await tab.type('balance --tree');
    await tab.enter();
    await tab.until(
      `(${READ_TERMINAL}).text.split(${JSON.stringify(SLOW_ACCOUNT)}).length - 1 > 0`,
      'the report from the restarted engine',
    );
    await tab.until(
      `(${READ_TERMINAL}).text.split('--------------------').length - 1 > ${rules}`,
      'a fresh report rule',
    );
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith(${JSON.stringify(`${SLOW_JOURNAL} »`)})`,
      'the prompt to come back after the report',
    );
    const after = await tab.read();
    // One report, one row for the account: `--tree` does not split a leaf account
    // further, so a second copy would be another report rather than this one.
    const rows = occurrences(after, SLOW_ACCOUNT);
    if (rows !== 1) throw new Error(`the account is in ${rows} rows, expected the one report`);
    if (occurrences(after, '--------------------') <= rules) throw new Error('no fresh report rule was drawn');
  });

  await run('the restarted engine starts from the compiled module, not a fetch', async () => {
    // The worker the cancel threw away fetched the engine itself — counted at the
    // top of this scenario, and asserted here rather than trusted there. The worker
    // that replaced it must not fetch at all: hledger-wasi.js kept the module the
    // dead one compiled, keyed by the URL it was compiled for, and handed it to the
    // new worker with its first request, so the restart is an instantiate with no
    // fetch and no compile. Counted in the worker's own resource timeline over CDP:
    // no timing and no sleep — either the fetch happened or it did not, and the
    // follower above only ever answers for the engine's own worker.
    if (fetchedBeforeCancel < 1) {
      throw new Error(
        `the engine worker's timeline held ${fetchedBeforeCancel} wasm fetches before the cancel: ` +
          'nothing for a restarted worker not to repeat',
      );
    }
    const after = await engine.fetched();
    if (after !== 0) {
      throw new Error(`the restarted engine worker fetched the wasm ${after} times`);
    }
    engine.stop();
  });

  await run('ctrl+c at an idle prompt clears the line', async () => {
    // The other arm of the same key: app.rs `handle`'s `\u{3}`, which runs with no
    // command anywhere near the engine — the run above settled, so `busy` is false
    // and the key cannot reach the branch above. It writes `^C` where the cursor is,
    // clears the line under it and draws the prompt again.
    const before = await tab.read();
    const marks = occurrences(before, '^C');

    await tab.type('stale');
    const echoed = await tab.read();
    if (!echoed.trimEnd().endsWith(`${SLOW_JOURNAL} » stale`)) {
      throw new Error(`the line reads ${JSON.stringify(echoed.trimEnd().split('\n').pop())}`);
    }

    await tab.press('c', { code: 'KeyC', keyCode: 67, modifiers: 2 });
    await tab.until(
      `(${READ_TERMINAL}).text.split('^C').length - 1 > ${marks}`,
      'the second ^C to be written',
    );
    await tab.until(
      `(${READ_TERMINAL}).text.trimEnd().endsWith(${JSON.stringify(`${SLOW_JOURNAL} »`)})`,
      'the line to be cleared back to the prompt',
    );

    const lines = (await tab.read()).split('\n').map((line) => line.trim());
    const cancelled = lines.filter((line) => line.includes('^C'));
    if (cancelled.length !== marks + 1) {
      throw new Error(`${cancelled.length} ^C rows on screen, expected ${marks + 1}`);
    }
    // The `^C` was written onto the line it cancelled rather than beside it: that row
    // still holds the word that was typed, and the prompt below is the same row
    // redrawn without it — which is what `clear_line` + `prompt` (app.rs) do.
    if (!cancelled[cancelled.length - 1].includes('stale')) {
      throw new Error(`the last ^C row reads ${JSON.stringify(cancelled[cancelled.length - 1])}`);
    }
  });
}

/**
 * Reload until the stored scrollback proves itself, then clear it and prove that too.
 *
 * Needs: no new banner since boot — no scenario above prints one, and `booted` counts
 * the banner's title line rather than the word, so a typed line holding the word (the
 * settings import types the file's name) cannot move the count — the font at the size
 * the window was sized for, and this visit's
 * own screen in the stored scrollback — `income:salary` from the balance step is what
 * the assertions below look for in it. The reload is what stops that screen mattering
 * to anything after it.
 * Leaves: the screen cleared and the stored copy cleared with it — the reload after
 * `clear` finds no `income:salary` to replay — and, last, the typed `clear` word
 * reaching the same wipe with its own echo on screen to take away.
 */
async function reloadAndClear({ tab }) {
  // The height passed to Tab.open is the ceiling for everything on screen — xterm only
  // renders the rows that fit, so a run that outgrows it fails in some early scenario's
  // banner wait, far from the constant. The budget checks itself here, at the run's
  // fullest and before the reloads thin it out: filled rows against rendered rows, with
  // room to grow. This has been re-tuned at 3200, 4800, 7200 and 11200 by hand; when it
  // fails, the height in main()'s Tab.open is what to grow.
  await run('the screen fits the window with room to grow', async () => {
    const room = await tab.eval(`(() => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')];
      const filled = rows.filter((row) => row.textContent.trim()).length;
      return { capacity: rows.length, filled };
    })()`);
    const margin = room.capacity - room.filled;
    if (margin < 100) {
      throw new Error(
        `${margin} rows of margin (${room.filled} filled of ${room.capacity}) — grow the height passed to Tab.open in main()`,
      );
    }
  });

  await run('the report and a fresh banner are there after a reload', async () => {
    // `booted` waits for the banners in the stored copy plus this visit's own, so what is
    // left to prove is the order: the report came back from the replay, and this visit's
    // banner is printed under it rather than instead of it.
    await tab.reload();
    await tab.booted();
    const text = await tab.read();
    if (!text.includes('income:salary')) throw new Error('the report did not come back');
    if (text.lastIndexOf('hledger-anywhere') < text.indexOf('income:salary')) {
      throw new Error('the fresh banner is not below the report: nothing was replayed first');
    }
  });

  await run('the scrollback survives any number of reloads', async () => {
    // What the feature promises: the stored copy is the screen, so a reload that
    // types nothing keeps the report on screen and grows the key by one boot and
    // no more — for the third reload as well as the second, which is where a
    // replay that was not captured showed up: visit A's history was replayed onto
    // the screen once, then only visit B's own 665-byte boot was saved, so visit C
    // replayed a screen with no report on it.
    //
    // The numbers this threshold sits between: one boot (banner, greeting, prompt)
    // is ~665 bytes as measured, and the whole screen the reload above left in
    // storage is ~55 KB (55,472 bytes, counted before the replay came back through
    // the capture — the note below prints this run's exact count). So the second
    // reload may grow the key by ~665, while a capture that took the replayed text
    // in twice would grow it by ~L1; 2000 is ~3 boots and ~1/27 of that screen —
    // room for the greeting to differ between visits, no room for a copy stacked
    // on top.
    const cap = 512 * 1024; // `MAX_CAPTURE_BYTES`, src/terminal/capture.rs
    const l1 = Buffer.byteLength(await tab.storedScrollback(), 'utf8');
    console.log(`note the stored scrollback held ${l1} bytes after the first reload`);

    await tab.reload(); // the second
    await tab.booted();
    if (!(await tab.read()).includes('income:salary')) {
      throw new Error('the report did not survive the second reload');
    }
    const l2 = Buffer.byteLength(await tab.storedScrollback(), 'utf8');
    console.log(`note the stored scrollback held ${l2} bytes after the second reload`);
    if (l2 - l1 >= 2000) {
      throw new Error(`the stored scrollback grew by ${l2 - l1} bytes across a reload that only booted (${l1} then ${l2})`);
    }

    await tab.reload(); // the third
    await tab.booted();
    if (!(await tab.read()).includes('income:salary')) {
      throw new Error('the report did not survive the third reload');
    }
    const l3 = Buffer.byteLength(await tab.storedScrollback(), 'utf8');
    console.log(`note the stored scrollback held ${l3} bytes after the third reload`);
    if (l3 > cap) {
      throw new Error(`the stored scrollback holds ${l3} bytes, over the ${cap}-byte cap`);
    }
  });

  await run('clear takes the report off the screen', async () => {
    await tab.clearScreen();
    await tab.until(`!(${READ_TERMINAL}).text.includes('income:salary')`, 'the screen to be cleared');
  });

  await run('the cleared report stays gone after a reload', async () => {
    await tab.reload();
    await tab.booted();
    const text = await tab.read();
    if (text.includes('income:salary')) throw new Error('the cleared report came back');
  });

  await run('the typed clear command reaches the same wipe', async () => {
    await tab.type('clear');
    await tab.enter();
    // Ctrl+L above cleared the screen straight from the key handler; this is the word
    // itself, through classify → dispatch → Effect::Clear (src/app.rs), which clears
    // and redraws the prompt the same way. The echo of the word is what says it took
    // that path: a line routed to hledger instead would keep the echo on screen and
    // print hledger's complaint about a command it does not have, and a wipe that
    // stopped short of the echo would leave `clear` itself behind.
    await tab.until(
      `(() => { const text = (${READ_TERMINAL}).text; return text.trimEnd().endsWith('»') && !text.includes('clear'); })()`,
      'the typed clear to wipe the screen',
    );
  });
}

async function main() {
  let built = true;
  try {
    accessSync(join(DIST, 'index.html'), constants.R_OK);
    accessSync(join(DIST, 'hledger-anywhere_bg.wasm'), constants.R_OK);
  } catch {
    built = false;
  }
  check(built, 'dist/ has been built', 'run `trunk build` first: this drives the built app, and CI runs it after the Build step');
  if (!built) return finish();

  const chrome = findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'hla-app-'));
  const fixtures = await mkdtemp(join(tmpdir(), 'hla-upload-'));
  // Where the browser puts what `download` hands it: a directory of this run's
  // own, named to `Browser.setDownloadBehavior` before the download starts.
  const downloads = await mkdtemp(join(tmpdir(), 'hla-dl-'));
  const { server, port } = await serve(DIST);
  const base = `http://127.0.0.1:${port}`;
  let launched = null;

  try {
    launched = await launch(chrome, { windowSize: '1200,1600', profile });
    // Tall rather than a person's window: the whole scrollback has to be visible for the
    // rows to be read, and a report scrolled off the top would fail for want of a scrollbar.
    // The app's own commands pile up quickly — a help overview alone is most of a hundred
    // rows — so the height is what the stored copy needs rather than a person's window.
    // xterm puts only the rows on screen into the DOM (both `.xterm-rows` and the
    // accessibility tree stop at the terminal's rows), so this is also the ceiling the
    // run's output has to fit under: 3200 was 198 rows and the scrollback outgrew it,
    // taking the first banner out of the read window and failing the reload below; 4800
    // was 298 and fit the 55,472-byte screen of the run that measured it, but a reload
    // now replays the first visit back on top of that screen (the scrollback survives
    // every reload, not the first), which is ~20 rows more and then ~4 rows per reload
    // after. 7200 was ~445 rows and the run had grown to 448 — two rows of margin, too
    // close: 11200 is ~690 against the 448 the scenarios measure now, so the next
    // scenario has room to add output before the early screens scroll out again.
    const tab = await Tab.open(launched.cdp, { width: 1200, height: 11200 });

    // The run as the scenarios it is made of. Each declares what it needs from the
    // scenario before it and what it leaves for the one after in its own comment
    // above; what crosses a boundary is handed over in `session` rather than left
    // in a variable for the next scenario to find.
    const session = { tab, base, launched, fixtures, downloads };
    await bootTheTerminal(session);
    await loadTheDemoJournal(session);
    await aliasAndRecall(session);
    await helpAndSettings(session);
    await importTheSettingsBack(session);
    await searchTheScreen(session);
    await switchTheJournal(session);
    await finderAndHistory(session);
    await clearTheHistory(session);
    await completeAtThePrompt(session);
    await themeAndFont(session);
    await mountTheUpload(session);
    await pluginsAndScreenreader(session);
    await addAndForgetARepository(session);
    await reloadAfterTheManifestChanged(session);
    await runTheProbePlugin(session);
    await dropAJournal(session);
    await writeAndDownload(session);
    await openAFolderReadOnly(session);
    await cancelARunningCommand(session);
    await reloadAndClear(session);

    if (!stopped) console.log(`note the terminal was read from ${tab.via}`);
  } catch (error) {
    check(false, 'the run reached the end', short(error));
  } finally {
    if (launched) launched.child.kill('SIGKILL');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        await rm(fixtures, { recursive: true, force: true });
        await rm(downloads, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
    server.close();
  }

  finish();
}

function finish() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
