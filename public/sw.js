self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'NEON COMPRESS';
  const options = {
    body: data.body || 'A new payment request has arrived.',
    icon: '/assets/logo.png',
    badge: '/assets/logo.png',
    tag: data.tag || 'neon-admin-payment',
    renotify: true,
    data: { url: data.url || '/admin/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url || '/admin/',
    self.location.origin
  ).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    for (const client of clientsList) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
