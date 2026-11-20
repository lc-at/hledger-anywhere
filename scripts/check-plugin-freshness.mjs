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
// The other half of the promise is offline, which nothing here had asked for: sw.js's own
// header opens with "the second visit should not need a network". So the same run then
// cuts the connection and asks the worker for what only it can have — the shell the page
// renders from, a plugin module it cached while it could still fetch one, a versioned
// `v=` asset — with the server changed underneath while the network is down, so an answer
// that reached it shows up as the wrong one rather than merely being possible. One fetch
// afterwards, back online, proves the cut was real and has been undone.
//
// Usage:
//   CHROME=<path> node scripts/check-plugin-freshness.mjs
//   SW_FILE=/tmp/sw-old.js CHROME=<path> node scripts/check-plugin-freshness.mjs
//
// SW_FILE points at a different worker to compare against, which is how the change in sw.js
// is shown to be the thing that makes the difference rather than luck. CHROME is honoured
// when it is set; otherwise Chrome is found the way scripts/browser.mjs finds it.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome, launch, Protocol, Tab } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = process.env.SW_FILE || join(HERE, '..', 'sw.js');

const CHROME = findChrome();

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
 * The engine's bytes, served at the URL shape src/hledger_info.rs builds for the real
 * app (`/wasm/hledger.wasm?v=…`), with this run's version the way `/sw.js?v=test` carries
 * one. Nothing about the bytes matters: what matters is that the URL has a `v=`.
 */
const ENGINE = 'the engine, as far as this test is concerned';

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
  // Pop-ups have to be let through: the window a plugin opens is one of the three ways a
  // plugin module is reached, and a blocked pop-up would fail every check that opens one.
  const { child: chrome, cdp, port } = await launch(CHROME, {
    windowSize: '900,700', extraArgs: ['--disable-popup-blocking'], profile,
  });
  const tab = await Tab.open(cdp);
  let workerCdp = null;
  const emulateOffline = async (offline) => {
    const conditions = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await tab.send('Network.enable');
    await tab.send('Network.emulateNetworkConditions', conditions);
    if (!workerCdp) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const worker = targets.find((entry) => entry.type === 'service_worker');
      if (!worker) throw new Error('the worker has no DevTools target to emulate');
      workerCdp = new Protocol(new WebSocket(worker.webSocketDebuggerUrl));
      await new Promise((resolve, reject) => {
        workerCdp.socket.onopen = resolve;
        workerCdp.socket.onerror = reject;
      });
      await workerCdp.send('Network.enable');
    }
    // The worker's fetches read the browser's HTTP cache too, and a fresh entry answers a
    // `no-cache` fetch even with the network gone — Chrome serves it rather than failing —
    // so with the cache left on, the ten-minute cache would answer every check below and
    // the worker's own fallback would never be the thing under test. Disabled on this
    // target, the worker's cache is the only thing that can answer, which is the promise
    // its header makes for the second visit.
    await workerCdp.send('Network.setCacheDisabled', { cacheDisabled: offline });
    await workerCdp.send('Network.emulateNetworkConditions', conditions);
  };
  // The tab itself, with this run's own parts hung on it: `eval`, `navigate` and `until`
  // are the tab's own — the page handle's `evaluate` was an alias over `tab.eval`, a
  // second name for one function, so it is gone rather than carried here, and the waits
  // in this file ask the tab, which names what it waited for when it runs out of time.
  // The tab's own `reload` is kept beside this one before the name goes to it, since
  // the check below is what has to call it.
  const reload = Tab.prototype.reload;
  return Object.assign(tab, {
    // The offline scenario's network cut, on both targets at once: the worker runs its
    // fetches in its own target, and emulation set on the page does not reach them — the
    // page reports itself offline while the worker keeps talking to the network, which is
    // exactly the traffic being tested.
    emulateOffline,
    reload: async () => {
      const before = await tab.eval('window.__boot || 0');
      await reload.call(tab);
      const after = await tab.eval('window.__boot || 0');
      // The load event says a page was drawn; the boot marker says it is a fresh one, since
      // only the document itself sets `window.__boot` on the way up.
      if (!(after > before)) throw new Error(`the page did not reload (boot ${before} -> ${after})`);
    },
    async close() {
      try {
        cdp.socket.close();
      } catch { /* already gone */ }
      try {
        if (workerCdp) workerCdp.socket.close();
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
  });
}

/** Wait until the worker is installed and controlling the page. */
async function untilControlled(page, want) {
  for (let i = 0; i < 80; i += 1) {
    const controlled = await page.eval('Boolean(navigator.serviceWorker.controller)');
    if (controlled === want) return;
    await sleep(100);
  }
  // Say what the registration actually is, rather than only that it never arrived.
  const why = await page.eval(`JSON.stringify({
    scriptRan: typeof window.openBlob,
    secure: window.isSecureContext,
    workerApi: typeof navigator.serviceWorker,
    error: window.__swError || null,
    title: document.title,
    body: document.body ? document.body.innerHTML.slice(0, 80) : null,
  })`);
  const state = await page.eval(`navigator.serviceWorker.getRegistrations().then((all) => all.map((r) => ({
    scope: r.scope, active: Boolean(r.active), installing: Boolean(r.installing), waiting: Boolean(r.waiting),
    error: r.installing ? 'installing' : (r.waiting ? 'waiting' : (r.active ? 'active' : 'none')),
  })))`).catch((error) => String(error));
  throw new Error(`the worker did not become ${want ? 'controlling' : 'uninstalled'} in time: ${why} / ${JSON.stringify(state)}`);
}

/** Wait for the page's own import on load, and say which version it got. */
async function pageVersion(page) {
  return page.until('window.__loaded || null', 'the page’s own import on load to say its version');
}

/** Ask a fresh load what version of the plugin it can import. */
async function versionAfterReload(page, base) {
  await page.reload();
  return page.eval(`import('${base}/plugins/demo.js').then((m) => m.version)`);
}

/**
 * Wait until some cache holds a URL with the body the server just had: remember() writes
 * the copy after the response has been delivered, so the copy has to be waited for rather
 * than assumed. Every cache is read, because the probe cache holds a count under the same
 * URL, and a wait rather than a claim — what the offline checks assert is answered by a
 * fetch, and this only makes sure there is an answer to give.
 */
async function untilCached(page, url, want) {
  for (let i = 0; i < 50; i += 1) {
    const bodies = await page.eval(`caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.open(name)
        .then((c) => c.match(${JSON.stringify(url)}))
        .then((r) => (r ? r.text() : null)))))
      .then((bodies) => bodies.filter(Boolean).map((body) => body.trim()))
      .catch((e) => 'cache read failed: ' + e.message)`);
    if (Array.isArray(bodies) && bodies.includes(want)) return true;
    await sleep(100);
  }
  return false;
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
  // The engine, at the versioned URL the real app asks for; the offline scenario takes it
  // away again, so a copy served from anywhere but the worker's cache is visible.
  await mkdirp(join(dir, 'wasm'));
  await writeFile(join(dir, 'wasm', 'hledger.wasm'), ENGINE);

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
    const first = await page.eval(`import('${base}/plugins/demo.js').then((m) => m.version)`);
    results.push(['the page imports the plugin it was served', first === 'v1', first]);
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v2'));
    await page.reload();
    // The import comes first: a fetch with no-cache in front of it would refresh the HTTP
    // cache itself and prove nothing about the worker.
    const after = await page.eval(`(async () => {
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
    const opened = await page.eval(`window.openBlob(new URL('/plugins/blob-only.js', location.origin).href)`);
    await sleep(700);
    const firstWindow = await page.eval('window.__blob && window.__blob.document.title');
    results.push(['the window a plugin opens can import its module at all',
      opened && !String(firstWindow).startsWith('error'), String(firstWindow)]);
    const seenByWorker = await page.eval(`caches.keys()
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
    const detail = await page.eval(`(async () => {
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
    await page.eval(`window.openBlob(new URL('/plugins/demo.js', location.origin).href)`);
    await sleep(700);
    const fromWindow = await page.eval('window.__blob && window.__blob.document.title');
    notes.push(`the window opened after that load showed: ${fromWindow}`);

    // A second import of the same URL in this document, after the file changed under it.
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v5'));
    await page.reload();
    await pageVersion(page);
    const firstImport = await page.eval(`import(new URL('/plugins/demo.js', location.origin).href).then((m) => m.version)`);
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v6'));
    const twice = await page.eval(`(async () => {
      const url = new URL('/plugins/demo.js', location.origin).href;
      const again = await import(url).then((m) => m.version);
      const server = await fetch(url, { cache: 'no-cache' }).then((r) => r.text());
      return JSON.stringify({ first: ${JSON.stringify(firstImport)}, again, server: server.trim().split("'")[1] });
    })()`);
    notes.push(`the file changed between two imports of the same URL in one document: ${twice}`);

    // 3. With no worker, which is a first visit or a browser that refused to install one.
    await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v5'));
    await page.navigate(`${base}/?nosw=1`);
    await page.eval('navigator.serviceWorker.getRegistrations().then((all) => all.map((r) => r.unregister()))');
    await sleep(400);
    await page.navigate(`${base}/?nosw=1`);
    // Registrations, not the controller: a page keeps the controller it had until it goes away,
    // so the count is what says the worker is really not installed.
    for (let i = 0; i < 60; i += 1) {
      const left = await page.eval('navigator.serviceWorker.getRegistrations().then((all) => all.length)');
      if (left === 0) break;
      await sleep(100);
    }
    // Not a check but a measurement: with no worker the HTTP cache answers inside its
    // max-age, so a changed file can stay unseen for up to ten minutes. That ceiling is why
    // the worker is the thing that has to do this, and asserting it here would lock in a
    // limitation rather than guard a guarantee.
    const withoutWorker = await versionAfterReload(page, base);
    notes.push(`with no worker, after a change: ${withoutWorker} (the HTTP cache's max-age decides)`);

    // 4. With the network gone: the worker's other promise, which nothing above had asked
    // for. Scenario 3 uninstalled the worker, so this page installs it again, reloads with
    // it in control — the difference between a load the worker happened to be present for
    // and one it answered — and warms the two things offline has to come from the cache:
    // the plugin module, and the engine's versioned URL.
    await page.navigate(`${base}/`);
    await untilControlled(page, true);
    await page.reload();
    const engineUrl = `${base}/wasm/hledger.wasm?v=test`;
    const warm = JSON.parse(await page.eval(`(async () => {
      // The page's own import on load, waited for the way the checks above wait for it.
      for (let i = 0; i < 60 && !window.__loaded; i += 1) await new Promise((r) => setTimeout(r, 100));
      const engine = await fetch(${JSON.stringify(engineUrl)})
        .then((r) => (r.ok ? r.text() : 'http ' + r.status)).catch((e) => 'fetch failed: ' + e.message);
      return JSON.stringify({
        controlled: Boolean(navigator.serviceWorker.controller),
        plugin: window.__loaded || 'never settled',
        engine,
      });
    })()`));
    const warmDemo = await untilCached(page, `${base}/plugins/demo.js`, "export const version = 'v5';");
    const warmEngine = await untilCached(page, engineUrl, ENGINE);
    results.push(['the caches are warm before the network goes',
      warm.controlled && warm.plugin === 'v5' && warm.engine === ENGINE && warmDemo && warmEngine,
      JSON.stringify({ ...warm, cached: { demo: warmDemo, engine: warmEngine } })]);

    // The server changes underneath while the network is down: the plugin file gets a new
    // version and the engine's file disappears, so an answer that reaches the network is
    // the wrong one rather than merely a possible one.
    try {
      await page.emulateOffline(true);
      await writeFile(join(dir, 'plugins', 'demo.js'), moduleFor('v6'));
      await rm(join(dir, 'wasm', 'hledger.wasm'));

      // Wait for the cut to be real rather than assuming the commands took: a reload
      // issued too early would be answered by the network and prove nothing. A fresh URL
      // on every attempt, because the probe above records every fetch the worker handles
      // under its own URL — a repeated one would answer the offline attempt from the
      // probe's cache with a 200 and hide a cut that had landed. A fresh URL has never
      // been fetched: a 404 means the network still answers, a failure means only the
      // worker's own cache is left to answer anything.
      let cutOff = 'still up';
      for (let i = 0; i < 50 && !cutOff.startsWith('failed'); i += 1) {
        cutOff = await page.eval(`fetch('${base}/never-requested-${i}.txt', { cache: 'no-cache' })
          .then((r) => 'served: http ' + r.status)
          .catch((e) => 'failed: ' + e.message)`);
        if (!cutOff.startsWith('failed')) await sleep(100);
      }
      results.push(['the network is gone for the worker, and only its cache can answer',
        cutOff.startsWith('failed'), cutOff]);

      await page.reload();
      const rendered = await pageVersion(page);
      const shell = JSON.parse(await page.eval(`JSON.stringify({
        marker: document.title === 'freshness' && typeof window.openBlob === 'function',
        controlled: Boolean(navigator.serviceWorker.controller),
      })`));
      results.push(['the page still renders with the network gone',
        shell.marker && shell.controlled, `${JSON.stringify(shell)} / the page imported ${rendered}`]);
      // v6 is what the server has now: an import that answered with it reached the network,
      // so the copy that answers has to be the v5 only the worker's cache holds.
      results.push(['a plugin module still imports with the network gone',
        rendered === 'v5', rendered]);
      // The engine's file is gone from the server: this body can only have come from the
      // cache the worker's `v=` branch serves without asking the network.
      const engineAnswer = await page.eval(`fetch(${JSON.stringify(engineUrl)})
        .then((r) => (r.ok ? r.text() : 'http ' + r.status))
        .catch((e) => 'fetch failed: ' + e.message)`);
      results.push(['a versioned asset answers from the cache with the network gone',
        engineAnswer === ENGINE, engineAnswer]);
    } finally {
      // Offline is switched off on the way out, whatever failed above: the browser belongs
      // to the rest of this run, and the check below has to see a network again.
      await page.emulateOffline(false);
    }

    // Back online: one network-first fetch, and v6 is on the network only, so this shows
    // the emulation is really off and leaves the worker doing its job for the next load.
    const onlineAnswer = await page.eval(`fetch('${base}/plugins/demo.js', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : 'http ' + r.status))
      .catch((e) => 'fetch failed: ' + e.message)`);
    results.push(['back online, the network-first fetch reaches the network again',
      onlineAnswer.trim() === "export const version = 'v6';", onlineAnswer]);
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
