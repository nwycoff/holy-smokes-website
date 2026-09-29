// Static, public shell only. No API, auth response, points or account data is cached.
const CACHE = 'treehouse-shell-v2';
const SHELL = ['/app/', '/assets/customer/app.css', '/assets/customer/app.js', '/app/icon.svg', '/images/img6.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(
  keys.filter(key => key.startsWith('treehouse-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
// "Your order is ready" notifications. The message carries no order details.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Fall back to the default wording. */ }
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Treehouse Pharmacy';
  const body = typeof data.body === 'string' ? data.body.slice(0, 160) : 'There’s an update on your order.';
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/images/img2.png', badge: '/app/icon.svg',
    tag: 'treehouse-order', data: { url: '/app/#order' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).pathname.startsWith('/app/'));
    if (open) { open.navigate('/app/#order').catch(() => {}); return open.focus(); }
    return self.clients.openWindow('/app/#order');
  }));
});
