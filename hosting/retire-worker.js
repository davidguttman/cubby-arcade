// Retire the old marketing-origin launcher worker without touching saves,
// installed game bytes, IndexedDB, or caches. Refreshed pages use network routes.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  await self.registration.unregister();
  const windows = await self.clients.matchAll({type: 'window'});
  await Promise.all(windows.map(client => client.navigate(client.url)));
})()));
