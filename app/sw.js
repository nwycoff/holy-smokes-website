// Static, public shell only. No API, auth response, points or account data is cached.
const CACHE = 'treehouse-shell-v1';
const SHELL = ['/app/', '/assets/customer/app.css', '/assets/customer/app.js', '/app/icon.svg', '/images/img6.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(
  keys.filter(key => key.startsWith('treehouse-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
});
