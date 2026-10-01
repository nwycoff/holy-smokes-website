// Static, public shell only. No API, auth response, points or account data is cached.
const CACHE = 'treehouse-shell-v3';
const SHELL = ['/app/', '/assets/customer/app.css', '/assets/customer/app.js', '/app/icon.svg', '/images/img6.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(
  keys.filter(key => key.startsWith('treehouse-shell-') && key !== CACHE).map(key => caches.delete(key))))));
// Network first; the offline copy is refreshed whenever the network answers. Pages load their
// script and stylesheet with a content version (?v=hash), which maps to the same offline copy.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), versioned = /^\?v=[a-f0-9]{12}$/.test(url.search);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || (url.search && !versioned) || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy))); }
    return response;
  }).catch(() => caches.match(url.pathname)));
});
// Order-ready alerts and opted-in "Deals & news". Messages carry no order details, and a tap
// can only open a screen inside the app.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Fall back to the default wording. */ }
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Treehouse Pharmacy';
  const body = typeof data.body === 'string' ? data.body.slice(0, 160) : 'There’s an update on your order.';
  let url = typeof data.url === 'string' && /^\/app\/(#[a-z-]{1,24})?$/.test(data.url) ? data.url : '/app/#order';
  // A campaign may open the menu filtered to one section or brand.
  if (url === '/app/#menu' && typeof data.filter === 'string' && /^(category|brand)=[A-Za-z0-9%._~!*'()-]{1,200}$/.test(data.filter))
    url += `?${data.filter}`;
  const tag = data.tag === 'treehouse-news' ? 'treehouse-news' : 'treehouse-order';
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/images/img2.png', badge: '/app/icon.svg',
    tag, data: { url } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app/#order';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).pathname.startsWith('/app/'));
    if (open) { open.navigate(url).catch(() => {}); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
