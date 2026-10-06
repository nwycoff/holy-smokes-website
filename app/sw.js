// Static, public shell only. No API, auth response, points or account data is cached.
const CACHE = 'treehouse-shell-v4';
const SHELL = ['/app/', '/assets/customer/app.css', '/assets/customer/app.js', '/app/icon.svg', '/images/img6.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(
  keys.filter(key => key.startsWith('treehouse-shell-') && key !== CACHE).map(key => caches.delete(key))))));
// Render the public shell immediately on repeat launches. Refresh unversioned files
// in the background; content-versioned assets are immutable and keyed by full URL.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), versioned = /^\?v=[a-f0-9]{12}$/.test(url.search);
  const key = url.pathname + url.search;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || (url.search && !versioned) ||
      !SHELL.some(item => item.split('?')[0] === url.pathname)) return;
  const cached = caches.open(CACHE).then(cache => cache.match(key));
  const update = async () => {
    const response = await fetch(event.request);
    if (response.ok) await (await caches.open(CACHE)).put(key, response.clone());
    return response;
  };
  const response = cached.then(hit => {
    if (hit && versioned) return hit;
    const network = update();
    // Keep background refresh alive after a cached response is delivered.
    event.waitUntil(network.catch(() => {}));
    return hit || network;
  });
  event.respondWith(response);
  event.waitUntil(response.then(() => {}, () => {}));
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
  // The CRM's own updates for owners open the CRM.
  if (data.url === '/crm/' && data.tag === 'treehouse-crm') url = '/crm/';
  const tag = ['treehouse-news', 'treehouse-crm'].includes(data.tag) ? data.tag : 'treehouse-order';
  const tap = typeof data.tap === 'string' && /^[a-f0-9]{64}\.[A-Za-z0-9_-]{1,64}\.[a-f0-9]{64}$/.test(data.tap) ? data.tap : null;
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/images/img2.png', badge: '/app/icon.svg',
    tag, data: { url, tap } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app/#order', tap = event.notification.data?.tap;
  // Count the tap for the campaign's results; never hold up opening the app.
  if (tap) event.waitUntil(fetch('/api/app/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: tap }) }).catch(() => {}));
  if (url === '/crm/') { event.waitUntil(self.clients.openWindow(url)); return; }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).pathname.startsWith('/app/'));
    if (open) { open.navigate(url).catch(() => {}); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
