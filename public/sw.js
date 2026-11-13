/* The app shell uses the network; no stale cached connection state is presented as live. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch { data = null; }
  if (!data || typeof data.body !== 'string') return;
  event.waitUntil(self.registration.showNotification(data.title || 'YES / NO', {
    body: data.body, icon: new URL('icon-192.png', self.registration.scope).href,
    tag: data.eventId, data: { url: data.url || self.registration.scope },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || self.registration.scope);
    const scope = new URL(self.registration.scope);
    if (target.origin !== scope.origin || !target.pathname.startsWith(scope.pathname)) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === target.href);
    if (existing) return existing.focus();
    return self.clients.openWindow(target.href);
  })());
});
