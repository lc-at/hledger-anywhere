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
// Chrome is found on PATH (google-chrome, chromium) or named with CHROME=/path/to/chrome.
// dist/ has to exist: `trunk build` writes it, and CI runs this after the Build step.

import { createServer } from 'node:http';
import { accessSync, constants, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

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

// Chrome the way the window check finds it: CHROME first, then anything PATH answers to a
// browser's name, then agent-browser's own install, which is this machine's answer. No
// Chrome anywhere is said out loud rather than spawned into ENOENT.
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const found = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      // not this one
    }
  }
  try {
    const wrapper = join(process.env.HOME || '', '.local', 'bin', 'agent-browser-chrome');
    accessSync(wrapper, constants.X_OK);
    return wrapper;
  } catch {
    // no wrapper
  }
  try {
    const browsers = readdirSync(join(process.env.HOME || '', '.agent-browser', 'browsers'))
      .filter((entry) => entry.startsWith('chrome-'))
      .sort();
    const latest = browsers[browsers.length - 1];
    if (latest) return join(process.env.HOME, '.agent-browser', 'browsers', latest, 'chrome');
  } catch {
    // no agent-browser either
  }
  throw new Error('no Chrome found: put google-chrome or chromium on PATH, or set CHROME=/path/to/chrome');
}

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

async function launch(chrome, profile) {
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1200,1600', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${seen}`)), 30000);
    child.stderr.on('data', (chunk) => {
      seen += chunk;
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${seen}`)));
  });
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return { child, cdp: new Protocol(socket) };
}

/** The DevTools protocol over one socket, with sessions flattened into it. */
class Protocol {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = message.id && this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
        else waiting.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    };
  }

  send(method, params = {}, sessionId) {
    const id = (this.id += 1);
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
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

/** One tab: navigate, evaluate, and make the input events a person would. */
class Tab {
  static async open(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    // Tall rather than a person's window: the whole scrollback has to be visible for the
    // rows to be read, and a report scrolled off the top would fail for want of a scrollbar.
    // The app's own commands pile up quickly — a help overview alone is most of a hundred
    // rows — so the height is what the stored copy needs rather than a person's window.
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 3200, deviceScaleFactor: 1, mobile: false });
    return tab;
  }

  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.via = null;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const wrapped = `(async () => { const value = await (${expression}); return value instanceof Node || value === window || typeof value === 'function' ? undefined : value; })()`;
    const result = await this.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  /** Poll an expression until it is truthy, and say what was being waited for. */
  async until(expression, what, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(expression);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(60);
    }
  }

  /** A load or a reload, ended by the event rather than by a readyState already complete. */
  async navigate(url, how = 'Page.navigate') {
    const fired = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('the page never finished loading'));
      }, 30000);
      const stop = this.cdp.on((message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.loadEventFired') {
          clearTimeout(timer);
          stop();
          resolve();
        }
      });
    });
    fired.catch(() => {});
    await this.send(how, how === 'Page.navigate' ? { url } : { ignoreCache: false });
    await fired;
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
    launched = await launch(chrome, profile);
    const tab = await Tab.open(launched.cdp);

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
      await tab.navigate('', 'Page.reload');
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

    await run('the report and a fresh banner are there after a reload', async () => {
      // `booted` waits for the banners in the stored copy plus this visit's own, so what is
      // left to prove is the order: the report came back from the replay, and this visit's
      // banner is printed under it rather than instead of it.
      await tab.navigate('', 'Page.reload');
      await tab.booted();
      const text = await tab.read();
      if (!text.includes('income:salary')) throw new Error('the report did not come back');
      if (text.lastIndexOf('hledger-anywhere') < text.indexOf('income:salary')) {
        throw new Error('the fresh banner is not below the report: nothing was replayed first');
      }
    });

    await run('clear takes the report off the screen', async () => {
      await tab.clearScreen();
      await tab.until(`!(${READ_TERMINAL}).text.includes('income:salary')`, 'the screen to be cleared');
    });

    await run('the cleared report stays gone after a reload', async () => {
      await tab.navigate('', 'Page.reload');
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
