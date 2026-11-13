/* Only the grown-ups' shell. Games, catalogs, pairing state and relay traffic
 * remain network-owned. Bump this version when changing the offline shell. */
'use strict';
const CACHE = 'cubby-parents-v5';
const SHELL = ['/parents/', '/parents/index.html', '/parents/parents.css', '/parents/pairing.js',
  '/parents/parents.js', '/parents/companion-host.js', '/parents/install.js', '/parents/manifest.webmanifest',
  '/parents/icons/favicon.svg', '/parents/icons/icon-192.png', '/parents/icons/icon-512.png',
  '/parents/icons/maskable-512.png', '/parents/icons/apple-touch-icon.png', '/runtime/core/link.js'];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  // Let an open app finish its work; use the new worker on its next launch.
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('cubby-parents-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // A normalized navigation cache key never contains scanned hashes or query data.
  const home = request.mode === 'navigate' && ['/parents/', '/parents/index.html'].includes(url.pathname);
  if (!home && (url.search || !SHELL.includes(url.pathname))) return;
  const key = home ? '/parents/' : url.pathname;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) { await cache.put(key, response.clone()); return response; }
      const saved = await cache.match(key);
      return saved || response;
    } catch (error) {
      const saved = await cache.match(key);
      if (saved) return saved;
      throw error;
    }
  })());
});
