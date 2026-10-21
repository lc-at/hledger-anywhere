/**
 * hledger-anywhere's service worker: the second visit should not need a network.
 *
 * The engine alone is 13 MB, and nothing about a journal changes between two
 * commands, so caching it is the difference between "a terminal you can use on a
 * train" and "a page that loads for ten seconds".
 *
 * The cache name comes from the URL the page registered with, which carries the
 * engine's SHA-256. A new engine means a new name, so the old cache is dropped on
 * activation rather than lingering as a half-stale mixture, and the engine's URL
 * carries the same checksum, which is what makes it safe to serve from the cache
 * without ever revalidating.
 *
 * Two strategies, deliberately:
 *
 *   * A URL with a `v=` parameter is immutable, so it is cache-first.
 *   * Everything else is network-first with a cache fallback: online you get the
 *     current build, offline you get the last one, and there is no window where a
 *     stale app is served to someone who could have had the new one.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `hledger-anywhere-${VERSION}`;

/**
 * What a first visit must fetch to render the terminal.
 *
 * Individual failures are tolerated: one missing file should not leave the app
 * with no service worker at all, and the fetch handler will cache whatever it
 * sees anyway.
 */
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/hledger-wasi.js',
  '/js/hledger-worker.js',
  '/js/vendor/xterm/xterm.js',
  '/js/vendor/xterm/xterm.css',
  '/js/vendor/xterm/addon-fit.js',
  '/js/vendor/wasi.js',
  '/js/vendor/index.js',
  '/js/vendor/wasi_defs.js',
  '/js/vendor/fd.js',
  '/js/vendor/fs_mem.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.allSettled(SHELL.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('hledger-anywhere-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.searchParams.has('v')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        remember(event, request, response);
        return response;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        remember(event, request, response);
        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        // A navigation with nothing cached still deserves the app's own shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) {
            return shell;
          }
        }
        throw error;
      }
    })(),
  );
});

/**
 * Keep a copy of a good response, without making the page wait for it or depend on it.
 *
 * Caching is best effort. A browser can refuse an entry: a full quota, a private window, or
 * one that will not store the 13 MB engine at all, which is what Chrome did here, with
 * "Cache.put() encountered a network error" for a body it had just downloaded intact. When
 * the put was awaited before answering, that refusal became the answer, and the engine failed
 * to load from a network that had delivered every byte of it. Now the page gets the response
 * either way, and the copy is written alongside it for next time.
 */
function remember(event, request, response) {
  if (!response.ok) {
    return;
  }
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.put(request, copy))
      .catch(() => {
        // Nothing to do: the response was already served, and the next visit fetches again.
      }),
  );
}
