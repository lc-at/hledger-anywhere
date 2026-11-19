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

import { createServer } from 'node:http';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launch, Tab as BaseTab } from './browser.mjs';

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
    const expected = (await this.storedScrollback()).match(/hledger-anywhere/g);
    const want = (expected ? expected.length : 0) + 1;
    const at = `(() => {
      const lines = (${READ_TERMINAL}).text.split('\\n').map((line) => line.trim()).filter(Boolean);
      const banners = (lines.join('\\n').match(/hledger-anywhere/g) || []).length;
      return banners >= ${want} && lines.length > 0 && lines[lines.length - 1].includes('»');
    })()`;
    try {
      await this.until(at, 'the terminal to finish booting');
    } catch (error) {
      const lines = (await this.read()).split('\n').map((line) => line.trim()).filter(Boolean);
      const banners = (lines.join('\n').match(/hledger-anywhere/g) || []).length;
      throw new Error(
        `${error.message}: ${banners} banner on screen, ${want} expected — the stored scrollback did not come back, or this visit never finished printing`,
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
      // below that, and the keystroke never reaches the line.
      else if (character === '.') await this.press('.', { code: 'Period', keyCode: 190, text: '.' });
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

  // Steps run in order and stop at the first that cannot be done: every one after a failed
  // step would fail for the same reason and say nothing new.
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
    // after. 7200 is ~445 rows: over the ~326 that chain can reach, measured against
    // the 16.16 px a row of the default font takes here.
    const tab = await Tab.open(launched.cdp, { width: 1200, height: 7200 });

    await run('the app boots to its banner', async () => {
      await tab.navigate(`${base}/`);
      await tab.booted();
      const text = await tab.read();
      if (!text.includes('hledger-anywhere')) throw new Error('the banner is not on screen');
    });

    // Screenreader mode on, then a reload to mount the terminal with it: xterm only keeps
    // its rows in the DOM when asked to, and this is the record the settings command uses.
    if (!stopped) {
      await tab.eval(`localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, '{"screen_reader":true}')`);
      await tab.reload();
      await run('the terminal is readable as rows', async () => {
        await tab.booted();
        const text = await tab.read();
        if (!text.includes('hledger-anywhere')) throw new Error('the banner is not on screen');
      });
    }

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
      // under the name that was typed. `income:salary` is already on screen from the
      // report above, so the alias's own report is the second copy of the line.
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

    // Search is the one app command whose work happens on the screen itself: `find`
    // decides, and only a run like this one can show that App::find then read the rows,
    // counted the hits and left the app's own words out of them. The words asserted are
    // the ones it formats — `match {index} of {total} · {term}` and
    // `No match for {term}.` — rather than anything paraphrased here.

    // The total is read off the screen rather than guessed: it is the report rows
    // holding `income:salary`, and `n` a step below is asserted against this same
    // number, because the counter line the search just printed is chatter and so does
    // not add to what the next search counts.
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

    // How often a string is on screen, for reports that grow one copy per run.
    const occurrences = (text, needle) => text.split(needle).length - 1;

    // The journal chain, after the settings file and before the search: `-f` is never
    // needed because the app chooses the main file and exports it as `$LEDGER_FILE`, and
    // `demo` proved only the default choice. These steps move the choice to the other
    // loaded file and back, and the report drawn under each is what says the new choice
    // reached the engine rather than only the screen. The search below counts whatever
    // is on screen when it runs, so it sees these reports too without being changed.

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

    // The two history surfaces, after the journal chain and before the reload. They are
    // the only parts of Ctrl+R's finder and of `history` that no other check touches: the
    // matching and the drawing are pinned by `cargo test` against `Picker` and
    // `history_listing`, but only a real window can show that a keystroke opened the
    // finder, that what was typed went into its query rather than the line, and that the
    // selection ran. Every count around them is read off the screen at the moment it is
    // used, so the extra report these steps draw moves nothing, and the reload at the end
    // is what stops this visit's screen from mattering to anything after it.

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

    // Three surfaces the Keys section of the help promises and no step above drives:
    // the menu Tab draws, the colours `theme` writes into the page, and the size `font`
    // gives xterm. Each is asserted by the value the code itself formats — the heading
    // `completion` prints, the theme's own background as a custom property, the font
    // size as the rows measure it — rather than by something having changed. The font
    // goes back to the size it was before the reload section: `booted` counts banners
    // in a window sized for the default font, and a big one scrolls them out of it.

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
      const end = Date.now() + 30000;
      while (!(await tab.eval(holds))) {
        if (Date.now() > end) throw new Error('timed out waiting for the account names to arrive');
        await tab.press('Tab', { code: 'Tab', keyCode: 9 });
      }
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
      // Back to the size it was before this step, so the reload below counts banners
      // in the window `booted` was written for: `set_font_size` puts it there and the
      // rows measure it again.
      await tab.type(`font ${original}`);
      await tab.enter();
      await tab.until(`(${READ_TERMINAL}).text.includes('The font is now ${original}px.')`, 'the original size to be announced');
      await tab.until(measures(String(original)), 'the rows to measure the original size again');
    });

    // The upload chain, after the font and before the reload: `upload` opens the
    // picker inside the key handler (app.rs, `Effect::Upload`), the browser hands
    // over four files, and `src/upload.rs` mounts the one it can and says why the
    // other three are skipped. The upload replaces what was loaded, which is what
    // the README promises, and nothing the reload and clear steps below depend on
    // the demo journals still being loaded: they read scrollback text, and every
    // report they look for was drawn before this step, so their assertions stay
    // where they are.

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
        const end = Date.now() + 15000;
        while (intercepted && !chooser && Date.now() < end) await sleep(60);
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

    // Three surfaces the upload chain leaves undriven, after the prompt that ends it
    // and before the reload that reads the scrollback back: the registry's own
    // listing, the accessibility tree the `screenreader` command moves, and the
    // third way a file arrives — dropped on the page rather than picked or opened.
    // Each is asserted by the words the code itself formats (`plugin_list`,
    // `set_screen_reader`, `files_arrived`) or by the DOM the code itself creates,
    // and none of them prints `hledger-anywhere`, so the banner count the reload
    // below waits for does not move.

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

    // The last chain the README's 2 MB workaround needs, after the drop steps
    // and before the reload: a report the screen would have to cut is written
    // into the engine's own filesystem with `-o`, `download` reads it back and
    // hands it to the browser, and real bytes land on disk — plus the refusal
    // for a name nothing wrote. None of the three prints `hledger-anywhere`, so
    // the banner count the reload below waits for does not move.

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
      const end = Date.now() + 30000;
      let bytes = null;
      for (;;) {
        if (downloadStarts > before && downloadCompleted) {
          try {
            bytes = await readFile(join(downloads, 'round19.csv'));
          } catch {
            bytes = null; // still on its way
          }
          if (bytes) break;
        }
        if (Date.now() > end) {
          throw new Error(
            `no file after 30 s: begun=${JSON.stringify(downloadBegun)} completed=${downloadCompleted} bytes=${bytes && bytes.length}`,
          );
        }
        await sleep(60);
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
