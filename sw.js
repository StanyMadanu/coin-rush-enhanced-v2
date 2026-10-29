// Coin Rush service worker: lets the game start offline after the first successful visit.
// Strategy: "network first, cache as fallback". When online you always get the newest files;
// when offline (or the network is very slow) the last good copy is used.
// To publish an update, change VERSION. The old cache is deleted automatically.
'use strict';
const VERSION = 'v1';
const CACHE = 'coin-rush-' + VERSION;
const FILES = ['./', './index.html', './style.css', './game.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('coin-rush-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                              // only cache plain page/file requests
  if (new URL(req.url).origin !== self.location.origin) return;  // never touch other websites
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    const res = await fetch(req, { signal: ctrl.signal, cache: 'no-cache' });   // always ask the server if the file changed
    clearTimeout(timer);
    // Only keep complete, successful, same-site answers (never errors or partial responses).
    if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return await fresh(res);
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
                (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    return hit ? await fresh(hit) : new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// Tell the browser not to reuse this answer without asking again, so a new version is never hidden
// behind the browser's own memory cache (the service worker keeps its own offline copy).
async function fresh(res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return res;
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}
