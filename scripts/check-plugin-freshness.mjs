#!/usr/bin/env node
//
// Does a returning visitor get a plugin file changed by a deploy, or the one they cached?
//
// GitHub Pages sends `max-age=600` on every asset, so the HTTP cache is entitled to answer
// with the previous build for ten minutes. The service worker is what is supposed to stop
// that: its own comment promises network-first, so online you get the current build. This
// test holds that promise to account, by serving a page with those headers, changing the
// plugin file underneath it, and asking the page what version it can import afterwards.
//
// Three ways a plugin module is reached are checked, because they do not all take the same
// path: the page itself, a window the plugin opens at a blob: URL, and a load with no
// worker installed at all.
//
// Usage:
//   CHROME=<path> node scripts/check-plugin-freshness.mjs
//   SW_FILE=/tmp/sw-old.js CHROME=<path> node scripts/check-plugin-freshness.mjs
//
// SW_FILE points at a different worker to compare against, which is how the change in sw.js
// is shown to be the thing that makes the difference rather than luck.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = process.env.SW_FILE || join(HERE, '..', 'sw.js');
const CHROME = process.env.CHROME || `${process.env.HOME}/.agent-browser/browsers/chrome-155.0.8059.84/chrome`;

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

/** The page: registers the worker, and can open a blob: window that imports a plugin. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>freshness</title></head>
<body>
<script>
  window.__boot = Date.now();
  // What a plugin command does: import the module from a page script, and say which it got.
  // The real app imports when a command runs, long after the worker has taken the page; this
  // test imports on load, which can be before it does. Waiting for the worker first is the
  // difference being tested for, rather than an accident of timing.
  window.addEventListener('pageshow', (event) => { window.__persisted = event.persisted; });
  const load = () => {
    // Captured before the import starts: control at resolution time is not control at request
    // time, and the request is the one that has to be intercepted.
    window.__controlled = Boolean(navigator.serviceWorker.controller);
    window.__navType = (performance.getEntriesByType('navigation')[0] || {}).type || 'unknown';
    return import(new URL('/plugins/demo.js', location.origin).href)
      .then((m) => { window.__loaded = m.version; window.__resolvedControlled = Boolean(navigator.serviceWorker.controller); })
      .catch((e) => { window.__loaded = 'error: ' + e.message; });
  };
  if (/[?&]nosw=/.test(location.search) || !('serviceWorker' in navigator)) load();
  else Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).then(load, load);
  if (!/[?&]nosw=/.test(location.search) && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js?v=test').catch((error) => { window.__swError = String(error); });
  } else {
    window.__swError = 'serviceWorker is ' + typeof navigator.serviceWorker + ', secure=' + window.isSecureContext;
  }
  // The blob: window the reconcile plugin opens, importing the module the way it does.
  // The closing tag is built by joining, because a literal one in this file would end this
  // script before it finishes, which is exactly what happened the first time.
  window.openBlob = (moduleUrl) => {
    const close = '<' + '/script>';
    const html = '<!doctype html><meta charset="utf-8"><title>waiting</title>' +
      '<script>import(' + JSON.stringify(moduleUrl) + ').then((m) => { document.title = m.version; }).catch((e) => { document.title = "error: " + e.message; });' + close;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.__blob = window.open(url, 'plugin');
    return Boolean(window.__blob);
  };
</script>
</body></html>`;

/** The plugin module, whose only content is which version it is. */
const moduleFor = (version) => `export const version = '${version}';\n`;

/**
 * Serve the directory the way GitHub Pages does: every asset fresh for ten minutes, with an
 * ETag so a revalidation can be answered without sending the body again.
 */
async function serve(dir) {
  const log = [];
  const server = createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
    let body;
    try {
      body = await readFile(join(dir, name));
    } catch {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    if (request.headers['if-none-match'] === etag) {
      log.push(`304 ${name} if-none-match=${request.headers['if-none-match']}`);
      response.writeHead(304, { etag, 'cache-control': 'max-age=600' });
      response.end();
      return;
    }
    log.push(`200 ${name} if-none-match=${request.headers['if-none-match'] || '-'} etag=${etag} bytes=${body.length}`);
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : 'text/plain';
    response.writeHead(200, { 'content-type': type, etag, 'cache-control': 'max-age=600' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, log };
}

/** A page on a DevTools endpoint: navigate, evaluate, reload, close. */
async function openPage(url) {
  const profile = await mkdtemp(join(tmpdir(), 'hla-fresh-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--window-size=900,700', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = null;
  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = /DevTools listening on (?:ws:\/\/)?127\.0\.0\.1:(\d+)/.exec(stderr);
    if (match && !port) port = Number(match[1]);
  });
  for (let i = 0; i < 60 && !port; i += 1) await sleep(100);
  if (!port) {
    chrome.kill('SIGKILL');
    throw new Error(`chrome did not start on a debugging port: ${stderr.slice(-300)}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let id = 0;
  const waiters = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiters.has(message.id)) {
      waiters.get(message.id)(message.result ?? message.error);
      waiters.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const next = ++id;
    waiters.set(next, resolve);
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  await send('Page.enable');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    return result.result?.value;
  };
  const navigate = async (to) => {
    await send('Page.navigate', { url: to });
    for (let i = 0; i < 60; i += 1) {
      await sleep(100);
      const state = await evaluate('document.readyState');
      if (state === 'complete') return;
    }
    throw new Error('the page never finished loading');
  };
  return {
    evaluate,
    navigate,
    reload: async () => {
      const before = await evaluate('window.__boot || 0');
      await send('Page.reload', { ignoreCache: false });
      for (let i = 0; i < 60; i += 1) {
        await sleep(100);
        if (await evaluate('document.readyState') === 'complete') break;
      }
      const after = await evaluate('window.__boot || 0');
      // readyState is already 'complete' in a page that never went away, so the boot marker is
      // what proves the reload happened rather than being assumed.
      if (!(after > before)) throw new Error(`the page did not reload (boot ${before} -> ${after})`);
    },
    async close() {
      try {
        socket.close();
      } catch { /* already gone */ }
      chrome.kill('SIGKILL');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    },
  };
}

/** Wait until the worker is installed and controlling the page. */
async function untilControlled(page, want) {
  for (let i = 0; i < 80; i += 1) {
    const controlled = await page.evaluate('Boolean(navigator.serviceWorker.controller)');
    if (controlled === want) return;
    await sleep(100);
  }
  // Say what the registration actually is, rather than only that it never arrived.
  const why = await page.evaluate(`JSON.stringify({
    scriptRan: typeof window.openBlob,
    secure: window.isSecureContext,
    workerApi: typeof navigator.serviceWorker,
    error: window.__swError || null,
    title: document.title,
    body: document.body ? document.body.innerHTML.slice(0, 80) : null,
  })`);
  const state = await page.evaluate(`navigator.serviceWorker.getRegistrations().then((all) => all.map((r) => ({
    scope: r.scope, active: Boolean(r.active), installing: Boolean(r.installing), waiting: Boolean(r.waiting),
    error: r.installing ? 'installing' : (r.waiting ? 'waiting' : (r.active ? 'active' : 'none')),
  })))`).catch((error) => String(error));
  throw new Error(`the worker did not become ${want ? 'controlling' : 'uninstalled'} in time: ${why} / ${JSON.stringify(state)}`);
}

/** Wait for the page's own import on load, and say which version it got. */
async function pageVersion(page) {
  for (let i = 0; i < 60; i += 1) {
    const value = await page.evaluate('window.__loaded || null');
    if (value) return value;
    await sleep(100);
  }
  return 'never settled';
}

/** Ask a fresh load what version of the plugin it can import. */
async function versionAfterReload(page, base) {
  await page.reload();
  return page.evaluate(`import('${base}/plugins/demo.js').then((m) => m.version)`);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'hla-freshness-'));
  const dir = join(root, 'site');
  await mkdirp(dir);
  await mkdirp(join(dir, 'plugins'));
  await writeFile(join(dir, 'index.html'), PAGE);
  // A probe in the copy that is served, not in the repository's worker: it records every
  // request the fetch handler is actually given, so "the worker saw it" can be measured
  // rather than assumed.
  const workerSource = await readFile(WORKER, 'utf8');
  // Only the first request for a URL, so a later fetch in a check cannot make this look true.
  // A count per URL, so the handler's traffic can be compared with the server's log.
  const probe = "  event.waitUntil(caches.open('probe').then((c) => c.match(request.url).then((m) => c.put(request.url, new Response(m ? String(Number(m.headers.get('x-count') || '0') + 1) : '1')))));\n";
  const anchor = '  const url = new URL(request.url);';
  if (!workerSource.includes(anchor)) throw new Error('the worker changed shape; the probe has nowhere to go');
  await writeFile(join(dir, 'sw.js'), workerSource.replace(anchor, `${anchor}\n${probe}`));
  await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v1'));

  const { server, port, log } = await serve(dir);
  const base = `http://127.0.0.1:${port}`;
  const page = await openPage(`${base}/`);
  const results = [];
  const notes = [];
  // The module map: within one document a URL is fetched once, and a later import of it returns
  // what was already evaluated, whatever the file now says. That is what decides whether an
  // in-page re-import, which is what `plugins reload` does, can ever see a deploy.
  try {
    // 1. Through the worker: this is the path a returning visitor takes.
    await page.navigate(`${base}/`);
    await untilControlled(page, true);
    const first = await page.evaluate(`import('${base}/plugins/demo.js').then((m) => m.version)`);
    results.push(['the page imports the plugin it was served', first === 'v1', first]);
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v2'));
    await page.reload();
    // The import comes first: a fetch with no-cache in front of it would refresh the HTTP
    // cache itself and prove nothing about the worker.
    const after = await page.evaluate(`(async () => {
      const controlled = Boolean(navigator.serviceWorker.controller);
      // Wait for the page's own import to settle before asking for another one.
      for (let i = 0; i < 50 && !window.__loaded; i += 1) await new Promise((r) => setTimeout(r, 100));
      const viaImport = window.__loaded;
      // What the worker's own cache holds says whether its fetch handler ever ran for this
      // file: remember() only writes after it has handled the request.
      const inWorkerCache = await caches.keys()
        .then((names) => Promise.all(names.map((name) => caches.open(name)
          .then((c) => c.match('${base}/plugins/demo.js'))
          .then((r) => (r ? r.text() : null)))))
        .then((bodies) => bodies.filter(Boolean).map((body) => body.trim()))
        .catch((e) => 'cache read failed: ' + e.message);
      const viaFetch = await fetch('${base}/plugins/demo.js', { cache: 'no-cache' })
        .then((r) => r.text()).catch((e) => 'fetch failed: ' + e.message);
      return JSON.stringify({ controlled, viaFetch: viaFetch.trim(), viaImport, inWorkerCache });
    })()`);
    results.push(['a plugin file changed by a deploy is seen on the next load',
      JSON.parse(after).viaImport === 'v2', after]);

    // 2. The window a plugin opens: a second realm with its own module map. Two things are
    // measured, because they are different questions.
    await writeFile(join(dir, 'plugins', 'blob-only.js'), moduleFor('v1'));
    await page.reload();
    await pageVersion(page);
    // (a) A module only that window asks for. If the worker's cache never holds it, that
    //     realm's requests do not reach the worker at all, whatever the page's do.
    const opened = await page.evaluate(`window.openBlob(new URL('/plugins/blob-only.js', location.origin).href)`);
    await sleep(700);
    const firstWindow = await page.evaluate('window.__blob && window.__blob.document.title');
    results.push(['the window a plugin opens can import its module at all',
      opened && !String(firstWindow).startsWith('error'), String(firstWindow)]);
    const seenByWorker = await page.evaluate(`caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.open(name)
        .then((c) => c.match('${base}/plugins/blob-only.js'))
        .then((r) => (r ? r.text() : null)))))
      .then((bodies) => bodies.some(Boolean))`);
    notes.push(`the worker's cache holds that window's module: ${seenByWorker} (that realm is not one it controls)`);

    // (b) What actually happens in the app: running the command imports the module on the page
    //     first, through the worker, so the copy in the HTTP cache is one the worker refreshed
    //     by the time the window asks for it.
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v3'));
    await page.reload();
    const pageSaw = await pageVersion(page);
    const detail = await page.evaluate(`(async () => {
      const viaFetch = await fetch('${base}/plugins/demo.js', { cache: 'no-cache' }).then((r) => r.text());
      const probe = await caches.open('probe').then((c) => c.match('${base}/plugins/demo.js')).then((r) => Boolean(r)).catch(() => 'no probe cache');
      const inCache = await caches.keys()
        .then((names) => Promise.all(names.map((name) => caches.open(name)
          .then((c) => c.match('${base}/plugins/demo.js'))
          .then((r) => (r ? r.text() : null)))))
        .then((bodies) => bodies.filter(Boolean).map((b) => b.trim()));
      const probeCount = await caches.open('probe').then((c) => c.match('${base}/plugins/demo.js'))
        .then((r) => (r ? r.text() : 'none'));
      return JSON.stringify({ navType: window.__navType, persisted: window.__persisted, controlledAtRequest: window.__controlled, probeCount, pageSaw: window.__loaded, viaFetch: viaFetch.trim(), inCache });
    })()`);
    notes.push(`a second change on a later load: the page imported ${pageSaw}, the server had v3 (${detail})`);
    await page.evaluate(`window.openBlob(new URL('/plugins/demo.js', location.origin).href)`);
    await sleep(700);
    const fromWindow = await page.evaluate('window.__blob && window.__blob.document.title');
    notes.push(`the window opened after that load showed: ${fromWindow}`);

    // A second import of the same URL in this document, after the file changed under it.
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v5'));
    await page.reload();
    await pageVersion(page);
    const firstImport = await page.evaluate(`import(new URL('/plugins/demo.js', location.origin).href).then((m) => m.version)`);
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v6'));
    const twice = await page.evaluate(`(async () => {
      const url = new URL('/plugins/demo.js', location.origin).href;
      const again = await import(url).then((m) => m.version);
      const server = await fetch(url, { cache: 'no-cache' }).then((r) => r.text());
      return JSON.stringify({ first: ${JSON.stringify(firstImport)}, again, server: server.trim().split("'")[1] });
    })()`);
    notes.push(`the file changed between two imports of the same URL in one document: ${twice}`);

    // 3. With no worker, which is a first visit or a browser that refused to install one.
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v5'));
    await page.navigate(`${base}/?nosw=1`);
    await page.evaluate('navigator.serviceWorker.getRegistrations().then((all) => all.map((r) => r.unregister()))');
    await sleep(400);
    await page.navigate(`${base}/?nosw=1`);
    // Registrations, not the controller: a page keeps the controller it had until it goes away,
    // so the count is what says the worker is really not installed.
    for (let i = 0; i < 60; i += 1) {
      const left = await page.evaluate('navigator.serviceWorker.getRegistrations().then((all) => all.length)');
      if (left === 0) break;
      await sleep(100);
    }
    // Not a check but a measurement: with no worker the HTTP cache answers inside its
    // max-age, so a changed file can stay unseen for up to ten minutes. That ceiling is why
    // the worker is the thing that has to do this, and asserting it here would lock in a
    // limitation rather than guard a guarantee.
    const withoutWorker = await versionAfterReload(page, base);
    notes.push(`with no worker, after a change: ${withoutWorker} (the HTTP cache's max-age decides)`);
  } catch (error) {
    check(false, 'the freshness scenario ran', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : String(error));
  } finally {
    await page.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }

  if (process.env.REQUEST_LOG) for (const line of log) console.log(`req  ${line}`);
  for (const [label, ok, detail] of results) check(ok, label, String(detail));
  for (const note of notes) console.log(`note ${note}`);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

async function mkdirp(path) {
  await mkdir(path, { recursive: true });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
